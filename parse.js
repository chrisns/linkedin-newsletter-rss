import { fetchUpstream } from "./cache.js";

/**
 * HTML parsing built on HTMLRewriter.
 *
 * HTMLRewriter parses in the runtime's native code and streams, so the cost is
 * the number of JS callbacks rather than the size of the document. The previous
 * cheerio implementation built a full JS DOM: measured at 21-27ms for a single
 * 225KB LinkedIn article page, against a 10ms free-plan CPU budget.
 *
 * Two behaviours of HTMLRewriter shape everything below:
 *
 *  1. Text chunks and attribute values arrive RAW — character references are not
 *     decoded. Re-emitting them verbatim is therefore lossless, and matches what
 *     cheerio produced with `decodeEntities: false`. When we need a real value
 *     (a title, a URL to parse) we decode explicitly.
 *  2. A content token is only valid during its own handler. Anything an
 *     `onEndTag` callback needs — the tag name in particular — must be copied
 *     into a local first.
 */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  pound: "£",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  times: "×",
};

/**
 * Decode the character references cheerio's `.text()` and `.attr()` used to
 * resolve for us. Covers numeric references and the named entities LinkedIn
 * actually emits. Unknown names are left alone rather than dropped.
 */
export function decodeEntities(s) {
  if (!s || !s.includes("&")) return s;
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ref) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[ref];
    return named === undefined ? m : named;
  });
}

/**
 * Escape a value we computed ourselves before it goes back into an attribute.
 * Only applied to attributes we rewrite. Untouched attributes are re-emitted
 * raw, which needs no escaping.
 */
export function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * base64url encode/decode for stateless image proxy IDs.
 */
export function encodeImgId(url) {
  return btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeImgId(id) {
  let s = id.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

/**
 * Strip every `trk*=…` parameter from a URL string. Tolerates the malformed
 * input LinkedIn occasionally emits, such as `#fragment?trk=…`, where the `?`
 * lands inside the fragment. Never throws.
 *
 * Written as a single left-to-right scan rather than a regex. The regex this
 * replaces was polynomial: the parameter name and its value were adjacent
 * unbounded character classes, so a crafted href could make the engine
 * backtrack. Anyone can publish a LinkedIn article containing a crafted link,
 * and the CPU budget here is 10ms.
 */
export function stripTrk(href) {
  if (!href || !href.includes("trk")) return href;

  // The first `?` or `&` begins the parameters, wherever it falls.
  let cut = href.length;
  for (let i = 0; i < href.length; i++) {
    if (href[i] === "?" || href[i] === "&") {
      cut = i;
      break;
    }
  }
  if (cut === href.length) return href;

  const base = href.slice(0, cut);
  const rest = href.slice(cut);

  // Each parameter is `<delimiter><name>=<value>`, ending at the next
  // delimiter or at a `#`. Walk them once and keep the ones we want.
  const kept = [];
  let i = 0;
  while (i < rest.length) {
    const delimiter = rest[i];
    let end = i + 1;
    while (end < rest.length && rest[end] !== "?" && rest[end] !== "&") end++;
    const param = rest.slice(i + 1, end);
    const hash = param.indexOf("#");
    if (hash >= 0) {
      // A fragment starts mid-parameter. Keep everything from the `#` on.
      const before = param.slice(0, hash);
      if (!before.startsWith("trk")) kept.push(delimiter + before);
      kept.push(param.slice(hash));
    } else if (!param.startsWith("trk")) {
      kept.push(delimiter + param);
    }
    i = end;
  }

  const out = kept.join("");
  // A surviving parameter must not open with `&`, because it is now first.
  return base + (out.startsWith("&") ? "?" + out.slice(1) : out);
}

export function rewriteImageUrl(url, origin) {
  if (!url) return url;
  if (!/(^|\.)licdn\.com\//.test(url)) return url;
  return `${origin}/img/${encodeImgId(url)}`;
}

/**
 * The attributes LinkedIn uses for its own instrumentation. Dropped everywhere.
 */
export function shouldDropAttr(name) {
  return (
    name === "class" ||
    name.startsWith("data-tracking") ||
    name.startsWith("data-test")
  );
}

/**
 * Unwrap LinkedIn's redirect wrapper, then drop tracking params. Returns the
 * href unchanged when there is nothing to do, so callers can skip the write.
 */
export function cleanHref(href) {
  if (!href) return href;
  let out = href;
  if (out.includes("linkedin.com/redir/redirect")) {
    try {
      const target = new URL(decodeEntities(out)).searchParams.get("url");
      if (target) return target;
    } catch {
      /* ignore malformed */
    }
  }
  if (out.includes("trk")) out = stripTrk(out);
  return out;
}

function asResponse(input) {
  return typeof input === "string" ? new Response(input) : input;
}

/**
 * Run handlers over a document for their side effects and discard the output.
 * Reading and dropping each chunk avoids concatenating the body into a string,
 * which for a 225KB article page is itself measurable CPU.
 */
async function scan(input, build) {
  const transformed = build(new HTMLRewriter()).transform(asResponse(input));
  const reader = transformed.body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/**
 * Sentinels used to mark a region of the output for extraction.
 *
 * Capturing a subtree through `element`/`text` callbacks costs roughly 15us per
 * text chunk, and a LinkedIn article body arrives as ~978 chunks: 20ms of pure
 * boundary crossing. Marking the region instead lets the native rewriter do all
 * the copying, and leaves JS with one indexOf and one slice.
 */
const MARK_BLOCKS_OPEN = "\u0001cns:b\u0001";
const MARK_BLOCKS_CLOSE = "\u0001cns:/b\u0001";
const MARK_MAIN_OPEN = "\u0001cns:m\u0001";
const MARK_MAIN_CLOSE = "\u0001cns:/m\u0001";
const ALL_MARKS = /\u0001cns:\/?[bm]\u0001/g;

function sliceBetween(html, open, close) {
  const i = html.indexOf(open);
  if (i < 0) return "";
  const j = html.indexOf(close, i + open.length);
  if (j < 0) return "";
  return html.slice(i + open.length, j);
}

/**
 * The shared cleaning rules: strip tracking attrs, unwrap redirect links, drop
 * ?trk= params, and rewrite images through the proxy.
 *
 * Kept in one place so `cleanHtml` and the article parser cannot drift.
 */
function withCleaningRules(rewriter, origin) {
  return (
    rewriter
      // Two jobs on one element, because HTMLRewriter matches selectors against
      // the source element. An <img> carrying only data-delayed-url would never
      // match `img[src]`, so promotion and proxy rewriting must share a handler.
      //
      // LinkedIn ships inline article images with data-delayed-url instead of
      // src so a JS lazy-loader can populate them. We're not running their JS,
      // so promote data-delayed-url -> src before the rest of the pipeline.
      .on("img", {
        element(el) {
          const delayed = el.getAttribute("data-delayed-url");
          let src = el.getAttribute("src");
          if (!src && delayed) {
            src = delayed;
            el.setAttribute("src", src);
          }
          if (delayed !== null) el.removeAttribute("data-delayed-url");
          if (!origin || !src) return;
          const decoded = decodeEntities(src);
          const rewritten = rewriteImageUrl(decoded, origin);
          if (rewritten !== decoded) el.setAttribute("src", escapeAttr(rewritten));
        },
      })
      // LinkedIn videos: the player is wired up at runtime by their JS,
      // which reads `data-sources` (a JSON array of {type, src, bitrate})
      // and `data-poster-url`, then injects <source> children. Without the
      // script, the <video> element is empty and never plays. Materialise
      // sources + poster as plain HTML so the browser can play them.
      .on("video[data-sources]", {
        element(el) {
          let sources = [];
          try {
            sources = JSON.parse(decodeEntities(el.getAttribute("data-sources")));
          } catch {
            /* leave as-is if malformed */
          }
          if (!Array.isArray(sources) || sources.length === 0) return;

          const poster = el.getAttribute("data-poster-url");
          el.setAttribute("controls", "");
          el.setAttribute("preload", "metadata");
          el.setAttribute("playsinline", "");
          if (poster) {
            const decoded = decodeEntities(poster);
            el.setAttribute(
              "poster",
              origin ? rewriteImageUrl(decoded, origin) : decoded
            );
          }
          el.removeAttribute("data-sources");
          el.removeAttribute("data-poster-url");

          // Sort high bitrate first so browsers pick the best by default.
          sources.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          const markup = sources
            .filter((s) => s && s.src)
            .map(
              (s) =>
                `<source src="${escapeAttr(String(s.src))}" type="${escapeAttr(
                  String(s.type || "video/mp4")
                )}">`
            )
            .join("");
          // The original children are the empty placeholder the player replaces.
          el.setInnerContent(markup, { html: true });
        },
      })
      .on("a[href]", {
        element(el) {
          const href = el.getAttribute("href");
          const cleaned = cleanHref(href);
          if (cleaned !== href) el.setAttribute("href", escapeAttr(cleaned));
        },
      })
      .on("*", {
        element(el) {
          // Collect first: removing an attribute invalidates a live iterator.
          let drop = null;
          for (const [name] of el.attributes) {
            if (shouldDropAttr(name)) (drop ||= []).push(name);
          }
          if (drop) for (const name of drop) el.removeAttribute(name);
        },
      })
  );
}

/**
 * Clean LinkedIn-flavoured HTML: strip tracking attrs, unwrap redirect
 * links, drop ?trk= params, rewrite images through the proxy, and
 * remove empty HTML comments.
 *
 * Runs as a streaming transform, so everything it does not touch passes through
 * byte for byte.
 */
export async function cleanHtml(html, origin) {
  if (!html) return html;
  return withCleaningRules(new HTMLRewriter(), origin)
    // LinkedIn leaves empty comments where its framework removed a node.
    // Dropped through the parser rather than by a regex over the output: a
    // regex here cannot tell a real comment from the same characters sitting
    // inside a text node or an attribute.
    .onDocument({
      comments(comment) {
        if (comment.text.trim() === "") comment.remove();
      },
    })
    .transform(new Response(html))
    .text();
}

/**
 * Parse newsletter listing page to extract metadata and article links.
 */
export async function parseNewsletterPage(input) {
  let ogDescription = null;
  let ogImage = null;
  let newsletterImage = null;
  let h1 = "";
  let firstH2 = "";
  let inFirstH2 = false;
  let h2Count = 0;

  // Two buckets, filled in one pass. The primary editions list is newest-first;
  // the right-rail "more articles" list holds older issues LinkedIn collapsed
  // out of it. Merging primary first preserves the original ordering.
  const primary = [];
  const all = [];

  await scan(input, (rw) =>
    rw
      .on('meta[property="og:description"]', {
        element(el) {
          if (ogDescription === null) ogDescription = el.getAttribute("content");
        },
      })
      .on('meta[property="og:image"]', {
        element(el) {
          if (ogImage === null) ogImage = el.getAttribute("content");
        },
      })
      .on("img.newsletter-image", {
        element(el) {
          if (newsletterImage === null) {
            newsletterImage = el.getAttribute("data-delayed-url");
          }
        },
      })
      .on("h1", {
        text(chunk) {
          h1 += chunk.text;
        },
      })
      .on("h2", {
        element(el) {
          h2Count += 1;
          if (h2Count === 1) {
            inFirstH2 = true;
            el.onEndTag(() => {
              inFirstH2 = false;
            });
          }
        },
        text(chunk) {
          if (inFirstH2) firstH2 += chunk.text;
        },
      })
      .on(
        "section.newsletter__editions-container ul.newsletter__updates div.share-article a",
        {
          element(el) {
            primary.push(el.getAttribute("href"));
          },
        }
      )
      .on('a[href*="/pulse/"]', {
        element(el) {
          all.push(el.getAttribute("href"));
        },
      })
  );

  const links = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const clean = decodeEntities(raw).split("?")[0];
    if (!/^https?:\/\/[^/]+\/pulse\/[^/]+/.test(clean)) return;
    if (clean.includes("/pulse/api/")) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    links.push(clean);
  };
  primary.forEach(push);
  all.forEach(push);

  const title = decodeEntities(h1).trim();
  const description = ogDescription
    ? decodeEntities(ogDescription)
    : decodeEntities(firstH2).trim();
  const imageUrl = decodeEntities(ogImage || newsletterImage || "");

  return { title, description, imageUrl, links };
}

/**
 * Extract the parent newsletter slug from an article page's HTML.
 */
export async function findParentNewsletter(input) {
  let slug = null;
  await scan(input, (rw) =>
    rw.on('a[href*="/newsletters/"]', {
      element(el) {
        if (slug) return;
        const href = el.getAttribute("href");
        if (!href) return;
        const match = decodeEntities(href).match(/\/newsletters\/([^/?]+)/);
        if (match) slug = match[1];
      },
    })
  );
  return slug;
}

/**
 * Extract the author's profile username from an article page's HTML.
 * Returns the first /in/ link that isn't from comments.
 */
export async function findAuthorProfile(input) {
  let username = null;
  await scan(input, (rw) =>
    rw.on('a[href*="/in/"]', {
      element(el) {
        if (username) return;
        const href = decodeEntities(el.getAttribute("href") || "");
        // Skip comment author links (they have tracking params)
        if (href.includes("trk=")) return;
        const match = href.match(/\/in\/([^/?]+)/);
        if (match) username = match[1];
      },
    })
  );
  return username;
}

/**
 * Extract pulse article links from a LinkedIn profile page's HTML.
 */
export async function parseProfileArticles(input) {
  const links = [];
  await scan(input, (rw) =>
    rw.on('a[href*="/pulse/"]', {
      element(el) {
        const href = el.getAttribute("href");
        if (!href) return;
        const clean = decodeEntities(href).split("?")[0];
        const full = clean.startsWith("http")
          ? clean
          : `https://www.linkedin.com${clean}`;
        if (!links.includes(full)) links.push(full);
      },
    })
  );
  return links;
}

/**
 * Parse a single article page to extract structured data.
 *
 * One streaming pass collects the metadata and marks the article body; the
 * body is then cleaned on its own. `origin` is optional; without it, images
 * are left pointing at licdn.com instead of the proxy.
 */
export async function parseArticlePage(input, origin) {
  const BLOCKS = 'div[data-test-id="article-content-blocks"]';
  const FALLBACK = ".article-main__content";

  let jsonLdRaw = "";
  let jsonLdCount = 0;
  let inFirstJsonLd = false;
  let coverImg = null;
  let caption = "";
  let h1 = "";
  let authorH3 = "";
  let parentNewsletter = null;
  let authorProfile = null;
  let markedBlocks = false;
  let markedMain = false;

  // Only extraction here. The cleaning rules run afterwards over the ~31KB
  // body, not this ~230KB page: a `*` handler costs per element matched, and
  // the page holds an order of magnitude more of them than the article does.
  const html = await new HTMLRewriter()
    .on('script[type="application/ld+json"]', {
      element(el) {
        jsonLdCount += 1;
        if (jsonLdCount === 1) {
          inFirstJsonLd = true;
          el.onEndTag(() => {
            inFirstJsonLd = false;
          });
        }
      },
      text(chunk) {
        if (inFirstJsonLd) jsonLdRaw += chunk.text;
      },
    })
    .on("img.cover-img__image", {
      element(el) {
        if (coverImg === null) coverImg = el.getAttribute("src");
      },
    })
    .on("figcaption.cover-img__caption", {
      text(chunk) {
        caption += chunk.text;
      },
    })
    .on("h1", {
      text(chunk) {
        h1 += chunk.text;
      },
    })
    .on(".publisher-author-card h3", {
      text(chunk) {
        authorH3 += chunk.text;
      },
    })
    // The parent newsletter and the author profile are collected here so the
    // whole article page is read once, not three times.
    .on('a[href*="/newsletters/"]', {
      element(el) {
        if (parentNewsletter) return;
        const href = el.getAttribute("href");
        if (!href) return;
        const match = decodeEntities(href).match(/\/newsletters\/([^/?]+)/);
        if (match) parentNewsletter = match[1];
      },
    })
    .on('a[href*="/in/"]', {
      element(el) {
        if (authorProfile) return;
        const href = decodeEntities(el.getAttribute("href") || "");
        // Skip comment author links (they have tracking params)
        if (href.includes("trk=")) return;
        const match = href.match(/\/in\/([^/?]+)/);
        if (match) authorProfile = match[1];
      },
    })
    // LinkedIn's auto-recommended-articles widget is not part of the article.
    .on(".inline-articles", {
      element(el) {
        el.remove();
      },
    })
    // The text paragraphs and the inline image blocks live as sibling
    // children inside `article-content-blocks`, so taking only
    // `.article-main__content` would skip the images entirely. Mark the whole
    // container, and mark the narrower one as a fallback for pages that lack it.
    .on(BLOCKS, {
      element(el) {
        if (markedBlocks) return;
        markedBlocks = true;
        el.prepend(MARK_BLOCKS_OPEN, { html: true });
        el.append(MARK_BLOCKS_CLOSE, { html: true });
      },
    })
    .on(FALLBACK, {
      element(el) {
        if (markedMain) return;
        markedMain = true;
        el.prepend(MARK_MAIN_OPEN, { html: true });
        el.append(MARK_MAIN_CLOSE, { html: true });
      },
    })
    .transform(asResponse(input))
    .text();

  let jsonLdData = {};
  try {
    if (jsonLdRaw.trim()) jsonLdData = JSON.parse(jsonLdRaw);
  } catch {
    // Fall back to HTML selectors if JSON-LD parsing fails
  }

  const img = jsonLdData.image?.url || decodeEntities(coverImg || "") || "";
  const imgCaption = decodeEntities(caption).trim() || null;
  const title = jsonLdData.name || decodeEntities(h1).trim();

  let pubDate = "";
  if (jsonLdData.datePublished) {
    pubDate = new Date(jsonLdData.datePublished).toUTCString();
  }

  const author = jsonLdData.author?.name || decodeEntities(authorH3).trim();

  const body =
    sliceBetween(html, MARK_BLOCKS_OPEN, MARK_BLOCKS_CLOSE) ||
    sliceBetween(html, MARK_MAIN_OPEN, MARK_MAIN_CLOSE);
  const description = body
    ? await cleanHtml(body.replace(ALL_MARKS, ""), origin)
    : "";

  return {
    title,
    author,
    img,
    imgCaption,
    pubDate,
    description,
    parentNewsletter,
    authorProfile,
  };
}

/**
 * Fetch and parse a single article page.
 *
 * The Response is handed straight to the parser so the body is never
 * materialised as a JS string.
 */
export async function fetchAndParseArticle(url, origin) {
  const response = await fetchUpstream(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch article ${url}: ${response.status}`);
  }
  return { ...(await parseArticlePage(response, origin)), link: url };
}

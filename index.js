import * as cheerio from "cheerio";
import xml from "xml";

const BROWSER_UA = "Mozilla/5.0 (compatible)";
const PAGE_SIZE = 5;

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
 * Strip every `trk*=…` query param from a URL string. Tolerates malformed
 * inputs that LinkedIn occasionally emits (e.g. `#fragment?trk=…`, where
 * `?` lands inside the fragment). Pure regex — never throws.
 */
export function stripTrk(href) {
  let h = href;
  h = h.replace(/([?&])trk[^=&]*=[^&#]*&/g, "$1");
  h = h.replace(/[?&]trk[^=&]*=[^&#]*/g, "");
  return h;
}

function rewriteImageUrl(url, origin) {
  if (!url) return url;
  if (!/(^|\.)licdn\.com\//.test(url)) return url;
  return `${origin}/img/${encodeImgId(url)}`;
}

/**
 * Clean LinkedIn-flavoured HTML: strip tracking attrs, unwrap redirect
 * links, drop ?trk= params, rewrite images through the proxy, and
 * remove empty HTML comments.
 */
export function cleanHtml(html, origin) {
  if (!html) return html;
  const $ = cheerio.load(html, { decodeEntities: false }, false);

  // LinkedIn ships inline article images with data-delayed-url instead of
  // src so a JS lazy-loader can populate them. We're not running their JS,
  // so promote data-delayed-url -> src before the rest of the pipeline.
  $("img[data-delayed-url]").each((_, el) => {
    const $el = $(el);
    if (!$el.attr("src")) {
      $el.attr("src", $el.attr("data-delayed-url"));
    }
    $el.removeAttr("data-delayed-url");
  });

  $("*").each((_, el) => {
    if (el.type !== "tag" || !el.attribs) return;
    for (const name of Object.keys(el.attribs)) {
      if (
        name === "class" ||
        name.startsWith("data-tracking") ||
        name.startsWith("data-test")
      ) {
        delete el.attribs[name];
      }
    }
  });

  $('a[href*="linkedin.com/redir/redirect"]').each((_, el) => {
    const href = $(el).attr("href");
    try {
      const target = new URL(href).searchParams.get("url");
      if (target) $(el).attr("href", target);
    } catch {
      /* ignore malformed */
    }
  });

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !href.includes("trk")) return;
    const cleaned = stripTrk(href);
    if (cleaned !== href) $(el).attr("href", cleaned);
  });

  if (origin) {
    $('img[src*="licdn.com"]').each((_, el) => {
      const src = $(el).attr("src");
      $(el).attr("src", rewriteImageUrl(src, origin));
    });
  }

  return $.html().replace(/<!--\s*-->/g, "");
}

function cleanArticle(article, origin) {
  return {
    ...article,
    description: cleanHtml(article.description, origin),
    img: rewriteImageUrl(article.img, origin),
  };
}

/**
 * Parse newsletter listing page to extract metadata and article links.
 */
export function parseNewsletterPage(html) {
  const $ = cheerio.load(html);

  const title = $("h1").text().trim();
  const description =
    $('meta[property="og:description"]').attr("content") ||
    $("h2").first().text().trim();
  const imageUrl =
    $('meta[property="og:image"]').attr("content") ||
    $("img.newsletter-image").attr("data-delayed-url") ||
    "";

  // Collect from the primary issues list first (preserves newest-first order)
  // then merge in any other pulse links on the page (e.g. the right-rail
  // "more articles" list contains older issues LinkedIn collapsed out of the
  // main list).
  const links = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const clean = raw.split("?")[0];
    if (!/^https?:\/\/[^/]+\/pulse\/[^/]+/.test(clean)) return;
    if (clean.includes("/pulse/api/")) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    links.push(clean);
  };

  $(
    "section.newsletter__editions-container ul.newsletter__updates div.share-article a"
  ).each((_, el) => push($(el).attr("href")));
  $('a[href*="/pulse/"]').each((_, el) => push($(el).attr("href")));

  return { title, description, imageUrl, links };
}

/**
 * Extract the parent newsletter slug from an article page's HTML.
 */
export function findParentNewsletter(html) {
  const $ = cheerio.load(html);
  let slug = null;
  $('a[href*="/newsletters/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const match = href.match(/\/newsletters\/([^/?]+)/);
      if (match && !slug) slug = match[1];
    }
  });
  return slug;
}

/**
 * Extract the author's profile username from an article page's HTML.
 * Returns the first /in/ link that isn't from comments.
 */
export function findAuthorProfile(html) {
  const $ = cheerio.load(html);
  let username = null;
  $('a[href*="/in/"]').each((_, el) => {
    if (username) return;
    const href = $(el).attr("href") || "";
    // Skip comment author links (they have tracking params)
    if (href.includes("trk=")) return;
    const match = href.match(/\/in\/([^/?]+)/);
    if (match) username = match[1];
  });
  return username;
}

/**
 * Extract pulse article links from a LinkedIn profile page's HTML.
 */
export function parseProfileArticles(html) {
  const $ = cheerio.load(html);
  const links = [];
  $('a[href*="/pulse/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const clean = href.split("?")[0];
      const full = clean.startsWith("http")
        ? clean
        : `https://www.linkedin.com${clean}`;
      if (!links.includes(full)) links.push(full);
    }
  });
  return links;
}

/**
 * Parse a single article page to extract structured data.
 */
export function parseArticlePage(html) {
  const $ = cheerio.load(html);

  let jsonLdData = {};
  try {
    const jsonLdScript = $('script[type="application/ld+json"]').first().text();
    if (jsonLdScript) {
      jsonLdData = JSON.parse(jsonLdScript);
    }
  } catch (e) {
    // Fall back to HTML selectors if JSON-LD parsing fails
  }

  const img =
    jsonLdData.image?.url || $("img.cover-img__image").attr("src") || "";
  const imgCaption = $("figcaption.cover-img__caption").text().trim() || null;
  const title = jsonLdData.name || $("h1").text().trim();

  let pubDate = "";
  if (jsonLdData.datePublished) {
    pubDate = new Date(jsonLdData.datePublished).toUTCString();
  }

  const author =
    jsonLdData.author?.name || $(".publisher-author-card h3").text().trim();

  // The text paragraphs and the inline image blocks live as sibling
  // children inside `article-content-blocks`, so iterating only
  // `.article-main__content` would skip the images entirely. Take the
  // whole container, minus LinkedIn's auto-recommended-articles widget.
  let description = "";
  const root = $('div[data-test-id="article-content-blocks"]').first();
  if (root.length) {
    root.find(".inline-articles").remove();
    description = root.html() || "";
  } else {
    description = $(".article-main__content").html() || "";
  }

  return { title, author, img, imgCaption, pubDate, description };
}

/**
 * Fetch and parse a single article page.
 */
export async function fetchAndParseArticle(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch article ${url}: ${response.status}`);
  }
  const html = await response.text();
  return {
    ...parseArticlePage(html),
    parentNewsletter: findParentNewsletter(html),
    link: url,
  };
}

/**
 * Best-effort match between two newsletter identifiers. LinkedIn slugs are
 * `kebab-name-<numeric-id>` but the request might use only the numeric id.
 * We compare on the trailing numeric id when possible, otherwise on equality.
 */
export function newslettersMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const idA = String(a).match(/(\d{15,})/);
  const idB = String(b).match(/(\d{15,})/);
  if (idA && idB) return idA[1] === idB[1];
  return false;
}

/**
 * Build RSS XML from newsletter metadata and parsed articles.
 */
export function buildRssFeed(metadata, articles, selfUrl) {
  const rss = [
    {
      rss: [
        {
          _attr: {
            version: "2.0",
            "xmlns:atom": "http://www.w3.org/2005/Atom",
          },
        },
        {
          channel: [
            {
              image: [
                { title: metadata.title },
                { link: metadata.link },
                { url: metadata.imageUrl },
              ],
            },
            { title: metadata.title },
            { link: metadata.link },
            { description: metadata.description },
            { docs: "https://www.rssboard.org/rss-specification" },
            {
              "atom:link": {
                _attr: {
                  href: selfUrl,
                  rel: "self",
                  type: "application/rss+xml",
                },
              },
            },
            {
              generator:
                "https://github.com/chrisns/linkedin-newsletter-rss",
            },
            ...articles.map((article) => ({
              item: [
                { title: article.title },
                { author: article.author },
                { link: article.link },
                { guid: article.link },
                { pubDate: article.pubDate },
                { description: { _cdata: article.description } },
                {
                  enclosure: {
                    _attr: {
                      url: article.img,
                      type: "image/jpeg",
                      length: "100",
                    },
                  },
                },
              ],
            })),
          ],
        },
      ],
    },
  ];

  return xml(rss, { declaration: true, indent: "  " });
}

function homepageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LinkedIn Newsletter RSS</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5; color: #333;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .container { max-width: 520px; width: 100%; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #666; margin-bottom: 1.5rem; line-height: 1.5; }
    form { display: flex; gap: 0.5rem; }
    input {
      flex: 1; padding: 0.75rem; border: 1px solid #ddd;
      border-radius: 6px; font-size: 1rem;
    }
    input:focus { outline: none; border-color: #0a66c2; }
    button {
      padding: 0.75rem 1.25rem; background: #0a66c2; color: #fff;
      border: none; border-radius: 6px; font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #004182; }
    .example { margin-top: 1rem; font-size: 0.85rem; color: #999; }
    code {
      background: #e8e8e8; padding: 0.15rem 0.35rem;
      border-radius: 3px; font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>LinkedIn Newsletter to RSS</h1>
    <p>Convert any LinkedIn newsletter into an RSS feed. Paste a newsletter URL, article URL, or slug below.</p>
    <form id="form">
      <input type="text" id="url" placeholder="https://www.linkedin.com/newsletters/..." required>
      <button type="submit">Get Feed</button>
    </form>
    <p class="example">Accepts newsletter URLs, article URLs, or slugs</p>
  </div>
  <script>
    document.getElementById("form").addEventListener("submit", function(e) {
      e.preventDefault();
      var input = document.getElementById("url").value.trim();
      var match;
      if ((match = input.match(/linkedin\\.com\\/newsletters\\/([^/?]+)/))) {
        window.location.href = "/" + encodeURIComponent(match[1]);
      } else if ((match = input.match(/linkedin\\.com\\/pulse\\/([^/?]+)/))) {
        window.location.href = "/pulse/" + encodeURIComponent(match[1]);
      } else {
        var slug = input.replace(/^\\//, "");
        if (slug) window.location.href = "/" + encodeURIComponent(slug);
      }
    });
  </script>
</body>
</html>`;
}

async function generateFeed(newsletter, selfUrl, page = 1) {
  const url = `https://www.linkedin.com/newsletters/${newsletter}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `LinkedIn returned ${response.status} for newsletter "${newsletter}"`
    );
  }
  const html = await response.text();
  const { title, description, imageUrl, links } = parseNewsletterPage(html);

  const origin = new URL(selfUrl).origin;
  const start = (page - 1) * PAGE_SIZE;
  const pageLinks = links.slice(start, start + PAGE_SIZE);

  // Empty page: skip the LinkedIn round-trips entirely. Lets consumers
  // safely loop until they hit zero items without DoSing the upstream.
  const results = pageLinks.length
    ? await Promise.allSettled(
        pageLinks.map((link) => fetchAndParseArticle(link))
      )
    : [];

  const articles = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((a) =>
      a.parentNewsletter
        ? newslettersMatch(a.parentNewsletter, newsletter)
        : true
    )
    .map((a) => cleanArticle(a, origin));

  results
    .filter((r) => r.status === "rejected")
    .forEach((r) => console.error(`Article fetch failed: ${r.reason.message}`));

  return buildRssFeed(
    {
      title,
      description,
      imageUrl: rewriteImageUrl(imageUrl, origin),
      link: url,
    },
    articles,
    selfUrl
  );
}

async function handleImageProxy(id) {
  let upstream;
  try {
    upstream = decodeImgId(id);
    new URL(upstream);
  } catch {
    return new Response("Invalid image id", { status: 400 });
  }
  const u = new URL(upstream);
  if (!/(^|\.)licdn\.com$/.test(u.hostname)) {
    return new Response("Forbidden upstream", { status: 403 });
  }
  const upstreamRes = await fetch(upstream);
  if (!upstreamRes.ok) {
    return new Response("Upstream error", { status: upstreamRes.status });
  }
  const headers = new Headers();
  const ct = upstreamRes.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(upstreamRes.body, { headers });
}

export default {
  async fetch(request) {
    try {
      const reqUrl = new URL(request.url);
      const pathname = reqUrl.pathname;
      const origin = reqUrl.origin;

      if (pathname === "/") {
        return new Response(homepageHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Stateless image proxy for licdn.com assets
      if (pathname.startsWith("/img/")) {
        return handleImageProxy(pathname.substring("/img/".length));
      }

      // Single-article JSON, no redirect-to-newsletter behaviour. Used by
      // archival consumers that already know the article slug and just want
      // the cleaned body, image, etc.
      if (pathname.startsWith("/article/")) {
        const slug = pathname.substring("/article/".length);
        if (!slug) {
          return new Response("Missing slug", { status: 400 });
        }
        const articleUrl = `https://www.linkedin.com/pulse/${slug}`;
        const articleResponse = await fetch(articleUrl);
        if (!articleResponse.ok) {
          return new Response(
            `LinkedIn returned ${articleResponse.status}`,
            { status: articleResponse.status }
          );
        }
        const articleHtml = await articleResponse.text();
        const article = cleanArticle(
          {
            ...parseArticlePage(articleHtml),
            parentNewsletter: findParentNewsletter(articleHtml),
            link: articleUrl,
          },
          origin
        );
        return new Response(JSON.stringify(article), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      }

      let slug = pathname.substring(1);
      if (!slug) {
        return new Response("Please provide a newsletter ID in the URL path", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // Handle pulse article URLs
      if (pathname.startsWith("/pulse/")) {
        const articleSlug = pathname.substring("/pulse/".length);
        const articleUrl = `https://www.linkedin.com/pulse/${articleSlug}`;
        const articleResponse = await fetch(articleUrl);
        if (!articleResponse.ok) {
          throw new Error(`LinkedIn returned ${articleResponse.status} for article`);
        }
        const articleHtml = await articleResponse.text();

        // If article belongs to a newsletter, redirect to the full feed
        const newsletterSlug = findParentNewsletter(articleHtml);
        if (newsletterSlug) {
          return Response.redirect(`${origin}/${newsletterSlug}`, 302);
        }

        // Standalone article - try to find more articles by the same author
        const authorUsername = findAuthorProfile(articleHtml);
        if (authorUsername) {
          const profileUrl = `https://www.linkedin.com/in/${authorUsername}`;
          const profileResponse = await fetch(profileUrl, {
            headers: { "User-Agent": BROWSER_UA },
          });
          if (profileResponse.ok) {
            const profileHtml = await profileResponse.text();
            const articleLinks = parseProfileArticles(profileHtml);
            if (articleLinks.length > 0) {
              const results = await Promise.allSettled(
                articleLinks.map((link) => fetchAndParseArticle(link))
              );
              const articles = results
                .filter((r) => r.status === "fulfilled")
                .map((r) => cleanArticle(r.value, origin));
              results
                .filter((r) => r.status === "rejected")
                .forEach((r) =>
                  console.error(`Article fetch failed: ${r.reason.message}`)
                );
              if (articles.length > 0) {
                const authorName =
                  articles[0].author || authorUsername;
                const metadata = {
                  title: `Articles by ${authorName}`,
                  description: `Articles by ${authorName} on LinkedIn`,
                  imageUrl: articles[0].img,
                  link: profileUrl,
                };
                const xmlContent = buildRssFeed(
                  metadata,
                  articles,
                  request.url
                );
                return new Response(xmlContent, {
                  headers: { "Content-Type": "application/rss+xml" },
                });
              }
            }
          }
        }

        // Fallback: single-item feed from just this article
        const article = cleanArticle(
          { ...parseArticlePage(articleHtml), link: articleUrl },
          origin
        );
        const metadata = {
          title: article.title,
          description: article.title,
          imageUrl: article.img,
          link: articleUrl,
        };
        const xmlContent = buildRssFeed(metadata, [article], request.url);
        return new Response(xmlContent, {
          headers: { "Content-Type": "application/rss+xml" },
        });
      }

      const pageParam = parseInt(reqUrl.searchParams.get("page") || "1", 10);
      const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
      const xmlContent = await generateFeed(slug, request.url, page);
      return new Response(xmlContent, {
        headers: { "Content-Type": "application/rss+xml" },
      });
    } catch (error) {
      console.error("Error:", error);
      return new Response(`Error generating RSS feed: ${error.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};

import xml from "xml";

import { errorHtml, FAVICON, homepageHtml } from "./pages.js";
import {
  readPopular,
  recordHit,
  refreshPopular,
  warmPopular,
} from "./popular.js";
import {
  ARTICLE_TTL,
  articleKey,
  FEED_TTL,
  fetchUpstream,
  getJson,
  PAGE_TTL,
  putJson,
  REDIRECT_TTL,
  withCache,
} from "./cache.js";

import {
  cleanHtml,
  decodeImgId,
  encodeImgId,
  fetchAndParseArticle,
  findAuthorProfile,
  findParentNewsletter,
  parseArticlePage,
  parseNewsletterPage,
  parseProfileArticles,
  rewriteImageUrl,
  stripTrk,
} from "./parse.js";

// Re-exported so consumers and tests keep a single entry point.
export {
  cleanHtml,
  decodeImgId,
  encodeImgId,
  fetchAndParseArticle,
  findAuthorProfile,
  findParentNewsletter,
  parseArticlePage,
  parseNewsletterPage,
  parseProfileArticles,
  stripTrk,
};

const BROWSER_UA = "Mozilla/5.0 (compatible)";
const PAGE_SIZE = 5;

/**
 * `parseArticlePage` already cleans the body in its own pass, so only the
 * cover image is left to rewrite.
 */
function cleanArticle(article, origin) {
  return { ...article, img: rewriteImageUrl(article.img, origin) };
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
                ...(article.imgCaption
                  ? [{ imgCaption: article.imgCaption }]
                  : []),
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

/**
 * Fetch and parse one article, reusing the Cache API copy when there is one.
 *
 * A newsletter gains one issue at a time, so a rebuilt feed should reparse one
 * document rather than five. Each article costs about 3.4ms to parse, and the
 * free plan allows 10ms of CPU per request.
 */
async function cachedArticle(url, origin, ctx) {
  const key = articleKey(url, origin);
  const hit = await getJson(key);
  if (hit) return hit;
  const article = await fetchAndParseArticle(url, origin);
  putJson(key, article, ARTICLE_TTL, ctx);
  return article;
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function generateFeed(newsletter, selfUrl, page = 1, ctx) {
  const url = `https://www.linkedin.com/newsletters/${newsletter}`;
  const response = await fetchUpstream(url);
  if (!response.ok) {
    throw new Error(
      `LinkedIn returned ${response.status} for newsletter "${newsletter}"`
    );
  }
  const { title, description, imageUrl, links } = await parseNewsletterPage(
    response
  );

  const origin = new URL(selfUrl).origin;
  const start = (page - 1) * PAGE_SIZE;
  const pageLinks = links.slice(start, start + PAGE_SIZE);

  // Empty page: skip the LinkedIn round-trips entirely. Lets consumers
  // safely loop until they hit zero items without DoSing the upstream.
  const results = pageLinks.length
    ? await Promise.allSettled(
        pageLinks.map((link) => cachedArticle(link, origin, ctx))
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

  const rss = buildRssFeed(
    {
      title,
      description,
      imageUrl: rewriteImageUrl(imageUrl, origin),
      link: url,
    },
    articles,
    selfUrl
  );
  return { rss, title };
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
  async fetch(request, env, ctx) {
    try {
      const reqUrl = new URL(request.url);
      const pathname = reqUrl.pathname;
      const origin = reqUrl.origin;

      if (pathname === "/") {
        // Not stored: the cron rewrites the most-followed list every 15
        // minutes, and a stored copy would keep serving the old one until its
        // TTL ran out. Rendering the page is a string concatenation, so the
        // ETag and the browser cache carry the saving.
        return await withCache(request, ctx, {
          ttl: PAGE_TTL,
          contentType: "text/html; charset=utf-8",
          store: false,
          build: async () => homepageHtml(await readPopular(env)),
        });
      }

      // A pink dot, the same mark as the wordmark. Inline so it costs no
      // storage and no second origin.
      if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
        return new Response(FAVICON, {
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=604800",
          },
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
        // Shares the feed's article cache, so this route both reads it and
        // fills it. The cron warmer uses that: see warmPopular().
        const article = cleanArticle(
          await cachedArticle(articleUrl, origin, ctx),
          origin
        );
        return new Response(JSON.stringify(article), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${ARTICLE_TTL}`,
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

        // One cached pass over the page yields the parent newsletter, the
        // author profile and the article itself. The article cache therefore
        // doubles as the redirect cache: a repeat visit costs no LinkedIn
        // round trip at all.
        const parsedArticle = await cachedArticle(articleUrl, origin, ctx);

        // If the article belongs to a newsletter, redirect to the full feed.
        if (parsedArticle.parentNewsletter) {
          return new Response(null, {
            status: 302,
            headers: {
              location: `${origin}/${parsedArticle.parentNewsletter}`,
              "cache-control": `public, max-age=${REDIRECT_TTL}`,
            },
          });
        }

        return await withCache(request, ctx, {
          ttl: FEED_TTL,
          contentType: "application/rss+xml; charset=utf-8",
          build: async () => {
            // Standalone article: try to find more by the same author.
            const authorUsername = parsedArticle.authorProfile;
            if (authorUsername) {
              const profileUrl = `https://www.linkedin.com/in/${authorUsername}`;
              const profileResponse = await fetchUpstream(profileUrl, {
                headers: { "User-Agent": BROWSER_UA },
              });
              if (profileResponse.ok) {
                const articleLinks = await parseProfileArticles(profileResponse);
                if (articleLinks.length > 0) {
                  // Bounded: the free plan allows 50 subrequests per
                  // invocation and a busy profile lists more.
                  const results = await Promise.allSettled(
                    articleLinks
                      .slice(0, PAGE_SIZE)
                      .map((link) => cachedArticle(link, origin, ctx))
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
                    const authorName = articles[0].author || authorUsername;
                    return {
                      body: buildRssFeed(
                        {
                          title: `Articles by ${authorName}`,
                          description: `Articles by ${authorName} on LinkedIn`,
                          imageUrl: articles[0].img,
                          link: profileUrl,
                        },
                        articles,
                        request.url
                      ),
                    };
                  }
                }
              }
            }

            // Fallback: single-item feed from just this article.
            const article = cleanArticle(
              { ...parsedArticle, link: articleUrl },
              origin
            );
            return {
              body: buildRssFeed(
                {
                  title: article.title,
                  description: article.title,
                  imageUrl: article.img,
                  link: articleUrl,
                },
                [article],
                request.url
              ),
            };
          },
        });
      }

      const pageParam = parseInt(reqUrl.searchParams.get("page") || "1", 10);
      const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
      const feed = await withCache(request, ctx, {
        ttl: FEED_TTL,
        contentType: "application/rss+xml; charset=utf-8",
        build: async () => {
          const { rss, title } = await generateFeed(slug, request.url, page, ctx);
          // Carried as a header so a cache hit still knows the title, and the
          // request can be counted without rebuilding the feed to learn it.
          return { body: rss, meta: { "x-feed-title": title } };
        },
      });
      // Counted on every request, cached or not: the question is how often a
      // newsletter is asked for, not how often we rebuild it.
      recordHit(env, ctx, {
        slug,
        title: feed.headers.get("x-feed-title") || "",
        kind: "newsletter",
      });
      return feed;
    } catch (error) {
      // Logged in full, shown in outline. The thrown message can name an
      // upstream URL or a parser internal, which the reader has no use for.
      console.error("Error:", error);
      // LinkedIn answers 500 for a newsletter that does not exist, so an
      // upstream failure cannot be told apart from a typo. Say both, and use
      // 502: a feed reader retries that, where a 404 would make it give up on
      // a feed that is only briefly unavailable.
      if (/\b(40[34]|410)\b/.test(error.message)) {
        return htmlResponse(
          errorHtml(
            404,
            "No newsletter <em>there</em>",
            "LinkedIn has no public newsletter or article at that address. Check the URL, then try again."
          ),
          404
        );
      }
      return htmlResponse(
        errorHtml(
          502,
          "That did not <em>work</em>",
          "LinkedIn did not give us a page we could read. Either that newsletter does not exist, or LinkedIn is having trouble. Check the address, then try again in a minute."
        ),
        502
      );
    }
  },

  /**
   * Refreshes the most-followed list. Reading Analytics Engine costs a query
   * against a 10,000 per day allowance, so it happens here rather than on every
   * homepage request.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshPopular(env)
        .then((result) => console.log("Popularity refresh:", JSON.stringify(result)))
        .catch((error) => console.error("Popularity refresh failed:", error.message))
        // Warming runs after the refresh so it uses the list just written.
        .then(() => warmPopular(env))
        .then((result) => console.log("Cache warm:", JSON.stringify(result)))
        .catch((error) => console.error("Cache warm failed:", error.message))
    );
  },
};

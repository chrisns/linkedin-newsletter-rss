import xml from "xml";

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
        pageLinks.map((link) => fetchAndParseArticle(link, origin))
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
        const article = cleanArticle(
          { ...(await parseArticlePage(articleResponse, origin)), link: articleUrl },
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
        // One pass over the page yields the parent newsletter, the author
        // profile and the article itself.
        const parsedArticle = await parseArticlePage(articleResponse, origin);

        // If article belongs to a newsletter, redirect to the full feed
        const newsletterSlug = parsedArticle.parentNewsletter;
        if (newsletterSlug) {
          return Response.redirect(`${origin}/${newsletterSlug}`, 302);
        }

        // Standalone article - try to find more articles by the same author
        const authorUsername = parsedArticle.authorProfile;
        if (authorUsername) {
          const profileUrl = `https://www.linkedin.com/in/${authorUsername}`;
          const profileResponse = await fetch(profileUrl, {
            headers: { "User-Agent": BROWSER_UA },
          });
          if (profileResponse.ok) {
            const articleLinks = await parseProfileArticles(profileResponse);
            if (articleLinks.length > 0) {
              // Bounded: the free plan allows 50 subrequests per invocation and
              // a busy profile lists far more articles than that.
              const results = await Promise.allSettled(
                articleLinks
                  .slice(0, PAGE_SIZE)
                  .map((link) => fetchAndParseArticle(link, origin))
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
          { ...parsedArticle, link: articleUrl },
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

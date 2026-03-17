import * as cheerio from "cheerio";
import xml from "xml";

const BROWSER_UA = "Mozilla/5.0 (compatible)";

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

  // Primary selectors
  let links = [];
  const articles = $(
    "section.newsletter__editions-container ul.newsletter__updates div.share-article"
  );
  if (articles.length > 0) {
    articles.each((_, item) => {
      const href = $(item).find("a").attr("href");
      if (href) links.push(href.split("?")[0]);
    });
  }

  // Fallback: find pulse article links
  if (links.length === 0) {
    $('a[href*="/pulse/"]').each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const clean = href.split("?")[0];
        if (!links.includes(clean)) links.push(clean);
      }
    });
  }

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
  const title = jsonLdData.name || $("h1").text().trim();

  let pubDate = "";
  if (jsonLdData.datePublished) {
    pubDate = new Date(jsonLdData.datePublished).toUTCString();
  }

  const author =
    jsonLdData.author?.name || $(".publisher-author-card h3").text().trim();

  let description = "";
  $('div[data-test-id="article-content-blocks"] .article-main__content').each(
    (_, el) => {
      description += $(el).html();
    }
  );
  if (!description) {
    description = $(".article-main__content").html() || "";
  }

  return { title, author, img, pubDate, description };
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
  return { ...parseArticlePage(html), link: url };
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

async function generateFeed(newsletter, selfUrl) {
  const url = `https://www.linkedin.com/newsletters/${newsletter}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `LinkedIn returned ${response.status} for newsletter "${newsletter}"`
    );
  }
  const html = await response.text();
  const { title, description, imageUrl, links } = parseNewsletterPage(html);

  const results = await Promise.allSettled(
    links.map((link) => fetchAndParseArticle(link))
  );

  const articles = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);

  results
    .filter((r) => r.status === "rejected")
    .forEach((r) => console.error(`Article fetch failed: ${r.reason.message}`));

  return buildRssFeed(
    { title, description, imageUrl, link: url },
    articles,
    selfUrl
  );
}

export default {
  async fetch(request) {
    try {
      const pathname = new URL(request.url).pathname;

      if (pathname === "/") {
        return new Response(homepageHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
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
          const base = new URL(request.url);
          return Response.redirect(`${base.origin}/${newsletterSlug}`, 302);
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
                .map((r) => r.value);
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
        const article = { ...parseArticlePage(articleHtml), link: articleUrl };
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

      const xmlContent = await generateFeed(slug, request.url);
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

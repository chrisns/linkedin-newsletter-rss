import * as cheerio from "cheerio";
import xml from "xml";

async function main(newsletter, self_url) {
  const url = `https://www.linkedin.com/newsletters/${newsletter}`;
  const response = await (await fetch(url)).text();
  const $ = cheerio.load(response);

  const link = url;
  const title = $("h1").text().trim();

  // Use Open Graph meta tag for description to avoid picking up "Editions" junk
  const description = $('meta[property="og:description"]').attr("content") ||
                      $("h2").first().text().trim();

  // Use Open Graph image or newsletter image
  const imageUrl = $('meta[property="og:image"]').attr("content") ||
                   $("img.newsletter-image").attr("data-delayed-url") || "";

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
                { title: title },
                { link: link },
                { url: imageUrl },
              ],
            },
            { title: title },
            { link: link },
            { description: description },
            { docs: "https://www.rssboard.org/rss-specification" },
            {
              "atom:link": {
                _attr: {
                  href: self_url,
                  rel: "self",
                  type: "application/rss+xml",
                },
              },
            },
            { generator: "https://github.com/chrisns/linkedin-newsletter-rss" },
          ],
        },
      ],
    },
  ];

  for (const item of $(
    "section.newsletter__editions-container ul.newsletter__updates div.share-article"
  )) {
    try {
      const article = $(item);
      const link = article.find("a").attr("href").split("?")[0];
      const articleContent = await (await fetch(link)).text();
      const $Content = cheerio.load(articleContent);

      // Try to extract data from JSON-LD for reliability
      let jsonLdData = {};
      try {
        const jsonLdScript = $Content('script[type="application/ld+json"]').first().text();
        if (jsonLdScript) {
          jsonLdData = JSON.parse(jsonLdScript);
        }
      } catch (e) {
        // Fall back to HTML selectors if JSON-LD parsing fails
      }

      const img = jsonLdData.image?.url || $Content("img.cover-img__image").attr("src");
      const title = jsonLdData.name || $Content("h1").text().trim();

      // Use JSON-LD datePublished for proper RFC 822 format
      let pubDate = "";
      if (jsonLdData.datePublished) {
        pubDate = new Date(jsonLdData.datePublished).toUTCString();
      }

      const author = jsonLdData.author?.name ||
                     $Content(".publisher-author-card h3").text().trim();

      // Get ALL article content blocks and combine them
      let articleDescription = "";
      $Content('div[data-test-id="article-content-blocks"] .article-main__content').each((i, el) => {
        articleDescription += $Content(el).html();
      });

      // Fallback if the selector above didn't work
      if (!articleDescription) {
        articleDescription = $Content(".article-main__content").html() || "";
      }

      rss[0].rss[1].channel.push({
        item: [
          { title: title },
          { author: author },
          { link: link },
          { guid: link },
          { pubDate: pubDate },
          { description: { _cdata: articleDescription } },
          {
            enclosure: { _attr: { url: img, type: "image/jpeg", length: "100" } },
          },
        ],
      });
    } catch (articleError) {
      console.error(`Error processing article: ${articleError.message}`);
      // Continue with other articles
    }
  }

  const str = xml(rss, { declaration: true, indent: "  " });
  return str;
}

export default {
  async fetch(request) {
    try {
      const newsletter = new URL(request.url).pathname.substring(1);
      if (!newsletter) {
        return new Response("Please provide a newsletter ID in the URL path", {
          status: 400,
          headers: { "Content-Type": "text/plain" }
        });
      }
      const xmlContent = await main(newsletter, request.url);
      return new Response(xmlContent, {
        headers: { "Content-Type": "application/rss+xml" },
      });
    } catch (error) {
      console.error("Error:", error);
      return new Response(`Error generating RSS feed: ${error.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" }
      });
    }
  },
};

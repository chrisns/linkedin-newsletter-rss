import * as cheerio from "cheerio";
import xml from "xml";

async function main(newsletter, self_url) {
  const url = `https://www.linkedin.com/newsletters/${newsletter}`;
  const response = await (await fetch(url)).text();
  const $ = cheerio.load(response);

  const link = url;
  const title = $("h1").text().trim();
  const description = $("h2").text().trim();
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
                {
                  url: $(".newsletter__top-card-image img").attr(
                    "data-delayed-url"
                  ),
                },
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
    const article = $(item);
    const link = article.find("a").attr("href").split("?")[0];
    const articleContent = await (await fetch(link)).text();
    // Parse the fetched article HTML
    const $Content = cheerio.load(articleContent);
    const img = $Content("img.cover-img__image").attr("src");
    const title = $Content("h1").text().trim();
    const pubDate = $Content(".base-main-card__metadata")
      .text()
      .split("Published")[1]
      .trim();
    const description = $Content(".article-main__content").html();
    rss[0].rss[1].channel.push({
      item: [
        { title: title },
        {
          author: $Content(".publisher-author-card h3").text().trim(),
        },
        { link: link },
        { guid: link },
        { pubDate: pubDate },
        { description: { _cdata: description } },
        {
          enclosure: { _attr: { url: img, type: "image/jpeg", length: "100" } },
        },
      ],
    });
  }
  const str = xml(rss, { declaration: true, indent: "  " });

  return str;
}

export default {
  async fetch(request) {
    const newsletter = new URL(request.url).pathname.substring(1);
    const xml = await main(newsletter, request.url);
    // TODO: handle a 404 or other response
    return new Response(xml, {
      headers: { "Content-Type": "application/rss+xml" },
    });
  },
};

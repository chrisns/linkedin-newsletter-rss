import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SELF } from "cloudflare:test";
import {
  parseNewsletterPage,
  parseArticlePage,
  buildRssFeed,
  fetchAndParseArticle,
  findParentNewsletter,
} from "../index.js";

// --- Fixtures ---

const newsletterPageHtml = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="Weekly insights on technology and leadership">
  <meta property="og:image" content="https://example.com/newsletter-image.jpg">
</head>
<body>
  <h1>Tech Leadership Weekly</h1>
  <section class="newsletter__editions-container">
    <ul class="newsletter__updates">
      <div class="share-article">
        <a href="https://www.linkedin.com/pulse/future-of-ai-john-doe-abc123?trackingId=xyz">Article 1</a>
      </div>
      <div class="share-article">
        <a href="https://www.linkedin.com/pulse/cloud-native-trends-john-doe-def456?trackingId=xyz">Article 2</a>
      </div>
    </ul>
  </section>
</body>
</html>`;

const newsletterPageFallbackHtml = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="AI news and analysis">
  <meta property="og:image" content="https://example.com/ai-newsletter.jpg">
</head>
<body>
  <h1>The AI Beat</h1>
  <div class="newsletter-content">
    <a href="https://www.linkedin.com/pulse/ai-revolution-jane-smith-abc123">AI Revolution</a>
    <a href="https://www.linkedin.com/pulse/ml-trends-2026-jane-smith-def456">ML Trends 2026</a>
    <a href="https://example.com/not-a-pulse-link">Other Link</a>
  </div>
</body>
</html>`;

const emptyNewsletterPageHtml = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="Empty newsletter">
</head>
<body>
  <h1>Empty Newsletter</h1>
</body>
</html>`;

const articlePageHtml = `<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">
  {
    "name": "The Future of AI in 2026",
    "datePublished": "2026-01-15T10:00:00.000Z",
    "author": {
      "name": "John Doe"
    },
    "image": {
      "url": "https://media.licdn.com/article-cover.jpg"
    }
  }
  </script>
</head>
<body>
  <h1>The Future of AI in 2026</h1>
  <div data-test-id="article-content-blocks">
    <div class="article-main__content"><p>AI is transforming the world.</p></div>
    <div class="article-main__content"><p>Here are the key trends to watch.</p></div>
  </div>
</body>
</html>`;

const articlePageHtmlNoJsonLd = `<!DOCTYPE html>
<html>
<body>
  <h1>Cloud Native Trends</h1>
  <img class="cover-img__image" src="https://media.licdn.com/fallback-cover.jpg">
  <div class="publisher-author-card"><h3>Jane Smith</h3></div>
  <div class="article-main__content"><p>Cloud native is the future.</p></div>
</body>
</html>`;

const articleWithNewsletterHtml = `<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">
  {
    "name": "Learning the Fundamentals",
    "datePublished": "2026-02-10T09:00:00.000Z",
    "author": { "name": "David Knott" },
    "image": { "url": "https://media.licdn.com/article-dk.jpg" }
  }
  </script>
</head>
<body>
  <h1>Learning the Fundamentals</h1>
  <a href="https://www.linkedin.com/newsletters/a-lot-to-learn-6694123842199154688">A Lot to Learn</a>
  <div data-test-id="article-content-blocks">
    <div class="article-main__content"><p>Fundamentals matter.</p></div>
  </div>
</body>
</html>`;

const standaloneArticleHtml = `<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">
  {
    "name": "Teaching a Computer BSL",
    "datePublished": "2025-06-01T12:00:00.000Z",
    "author": { "name": "Chris Nesbitt-Smith" },
    "image": { "url": "https://media.licdn.com/bsl-cover.jpg" }
  }
  </script>
</head>
<body>
  <h1>Teaching a Computer BSL</h1>
  <div data-test-id="article-content-blocks">
    <div class="article-main__content"><p>Sign language recognition is fascinating.</p></div>
  </div>
</body>
</html>`;

// --- Pure function tests ---

describe("parseNewsletterPage", () => {
  it("extracts metadata and links using primary selectors", () => {
    const result = parseNewsletterPage(newsletterPageHtml);
    expect(result.title).toBe("Tech Leadership Weekly");
    expect(result.description).toBe(
      "Weekly insights on technology and leadership"
    );
    expect(result.imageUrl).toBe("https://example.com/newsletter-image.jpg");
    expect(result.links).toEqual([
      "https://www.linkedin.com/pulse/future-of-ai-john-doe-abc123",
      "https://www.linkedin.com/pulse/cloud-native-trends-john-doe-def456",
    ]);
  });

  it("falls back to pulse links when primary selectors fail", () => {
    const result = parseNewsletterPage(newsletterPageFallbackHtml);
    expect(result.title).toBe("The AI Beat");
    expect(result.links).toEqual([
      "https://www.linkedin.com/pulse/ai-revolution-jane-smith-abc123",
      "https://www.linkedin.com/pulse/ml-trends-2026-jane-smith-def456",
    ]);
  });

  it("returns empty links for a page with no articles", () => {
    const result = parseNewsletterPage(emptyNewsletterPageHtml);
    expect(result.title).toBe("Empty Newsletter");
    expect(result.links).toEqual([]);
  });
});

describe("parseArticlePage", () => {
  it("extracts data from JSON-LD", () => {
    const result = parseArticlePage(articlePageHtml);
    expect(result.title).toBe("The Future of AI in 2026");
    expect(result.author).toBe("John Doe");
    expect(result.img).toBe("https://media.licdn.com/article-cover.jpg");
    expect(result.pubDate).toContain("2026");
    expect(result.description).toContain("AI is transforming the world.");
    expect(result.description).toContain("Here are the key trends to watch.");
  });

  it("falls back to HTML selectors when JSON-LD is missing", () => {
    const result = parseArticlePage(articlePageHtmlNoJsonLd);
    expect(result.title).toBe("Cloud Native Trends");
    expect(result.author).toBe("Jane Smith");
    expect(result.img).toBe("https://media.licdn.com/fallback-cover.jpg");
    expect(result.description).toContain("Cloud native is the future.");
  });
});

describe("findParentNewsletter", () => {
  it("finds newsletter slug from article with newsletter link", () => {
    expect(findParentNewsletter(articleWithNewsletterHtml)).toBe(
      "a-lot-to-learn-6694123842199154688"
    );
  });

  it("returns null for standalone article", () => {
    expect(findParentNewsletter(standaloneArticleHtml)).toBeNull();
  });
});

describe("buildRssFeed", () => {
  it("produces valid RSS XML with articles", () => {
    const metadata = {
      title: "Test Newsletter",
      description: "A test newsletter",
      imageUrl: "https://example.com/img.jpg",
      link: "https://www.linkedin.com/newsletters/test-123",
    };
    const articles = [
      {
        title: "Article One",
        author: "Author A",
        link: "https://www.linkedin.com/pulse/article-one",
        img: "https://media.licdn.com/article1.jpg",
        pubDate: "Thu, 15 Jan 2026 10:00:00 GMT",
        description: "<p>Content here.</p>",
      },
    ];
    const selfUrl = "https://linkedinrss.cns.me/test-123";

    const result = buildRssFeed(metadata, articles, selfUrl);
    expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result).toContain("<title>Test Newsletter</title>");
    expect(result).toContain("<title>Article One</title>");
    expect(result).toContain("<author>Author A</author>");
    expect(result).toContain(
      "<pubDate>Thu, 15 Jan 2026 10:00:00 GMT</pubDate>"
    );
    expect(result).toContain("<![CDATA[<p>Content here.</p>]]>");
    expect(result).toContain('rel="self"');
    expect(result).toContain(selfUrl);
  });

  it("handles empty articles list", () => {
    const metadata = {
      title: "Empty",
      description: "No articles",
      imageUrl: "",
      link: "https://www.linkedin.com/newsletters/empty",
    };
    const result = buildRssFeed(
      metadata,
      [],
      "https://linkedinrss.cns.me/empty"
    );
    expect(result).toContain("<title>Empty</title>");
    expect(result).not.toContain("<item>");
  });
});

describe("fetchAndParseArticle", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches and parses an article page", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(articlePageHtml))
    );

    const result = await fetchAndParseArticle(
      "https://www.linkedin.com/pulse/test-article"
    );
    expect(result.title).toBe("The Future of AI in 2026");
    expect(result.author).toBe("John Doe");
    expect(result.link).toBe(
      "https://www.linkedin.com/pulse/test-article"
    );
  });

  it("throws on non-200 response", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))
    );

    await expect(
      fetchAndParseArticle("https://www.linkedin.com/pulse/bad")
    ).rejects.toThrow("Failed to fetch article");
  });
});

// --- Worker endpoint tests ---

describe("Homepage", () => {
  it("returns HTML at root path", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
  });

  it("contains form and input", async () => {
    const response = await SELF.fetch("https://example.com/");
    const html = await response.text();
    expect(html).toContain("<form");
    expect(html).toContain('<input type="text"');
    expect(html).toContain("LinkedIn Newsletter to RSS");
  });
});

// --- Mocked integration tests ---

describe("RSS generation (mocked)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn((input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.includes("/newsletters/test-newsletter")) {
        return Promise.resolve(new Response(newsletterPageHtml));
      }
      if (url.includes("/pulse/future-of-ai-john-doe-abc123")) {
        return Promise.resolve(new Response(articlePageHtml));
      }
      if (url.includes("/pulse/cloud-native-trends-john-doe-def456")) {
        return Promise.resolve(new Response(articlePageHtml));
      }
      if (url.includes("/newsletters/empty-newsletter")) {
        return Promise.resolve(new Response(emptyNewsletterPageHtml));
      }
      if (url.includes("/newsletters/bad-newsletter")) {
        return Promise.resolve(
          new Response("Not Found", { status: 404 })
        );
      }
      if (url.includes("/newsletters/partial-fail")) {
        return Promise.resolve(new Response(newsletterPageHtml));
      }
      // For article URLs in the partial-fail test
      if (url.includes("/pulse/")) {
        return Promise.resolve(
          new Response("Internal Server Error", { status: 500 })
        );
      }

      return originalFetch(input);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generates valid RSS from mocked LinkedIn pages", async () => {
    const response = await SELF.fetch(
      "https://example.com/test-newsletter"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml");

    const text = await response.text();
    expect(text).toContain("<title>Tech Leadership Weekly</title>");
    expect(text).toContain("<title>The Future of AI in 2026</title>");
    expect(text).toContain("<author>John Doe</author>");
  });

  it("returns empty feed when newsletter has no articles", async () => {
    const response = await SELF.fetch(
      "https://example.com/empty-newsletter"
    );
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain("<title>Empty Newsletter</title>");
    expect(text).not.toContain("<item>");
  });

  it("returns 500 when LinkedIn returns an error", async () => {
    const response = await SELF.fetch(
      "https://example.com/bad-newsletter"
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("LinkedIn returned 404");
  });
});

describe("RSS generation - partial failures", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles individual article failures gracefully", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn((input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.includes("/newsletters/")) {
        return Promise.resolve(new Response(newsletterPageHtml));
      }
      // First article succeeds, second fails
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(articlePageHtml));
      }
      return Promise.resolve(
        new Response("Internal Server Error", { status: 500 })
      );
    });

    const response = await SELF.fetch(
      "https://example.com/test-newsletter"
    );
    expect(response.status).toBe(200);

    const text = await response.text();
    // Should still contain the successful article
    expect(text).toContain("<title>The Future of AI in 2026</title>");
    expect(text).toContain("<title>Tech Leadership Weekly</title>");
  });
});

// --- Pulse URL tests ---

describe("Pulse article URLs (mocked)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("redirects to parent newsletter when article belongs to one", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(articleWithNewsletterHtml))
    );

    const response = await SELF.fetch(
      "https://example.com/pulse/learning-fundamentals-david-knott-abc123",
      { redirect: "manual" }
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/a-lot-to-learn-6694123842199154688"
    );
  });

  it("generates single-item feed for standalone article", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(standaloneArticleHtml))
    );

    const response = await SELF.fetch(
      "https://example.com/pulse/teaching-computer-bsl-cns-rhs8e"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml");

    const text = await response.text();
    expect(text).toContain("<title>Teaching a Computer BSL</title>");
    expect(text).toContain("<author>Chris Nesbitt-Smith</author>");
    expect(text).toContain("Sign language recognition is fascinating.");
  });
});

// --- Live integration test ---

describe("Integration (live)", () => {
  it("fetches a stale newsletter and returns valid RSS", { timeout: 120_000 }, async () => {
    const response = await SELF.fetch(
      "https://example.com/james-caan-s-business-secrets-6676195873757679616"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml");

    const text = await response.text();
    expect(text).toContain(
      "<title>James Caan&apos;s Business Secrets</title>"
    );
    expect(text).toContain(
      "<link>https://www.linkedin.com/newsletters/james-caan-s-business-secrets-6676195873757679616</link>"
    );
    expect(text).toContain("<description>");
    expect(text).toContain("<pubDate>");
  });
});

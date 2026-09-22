import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { etagFor, notModified, UPSTREAM_TIMEOUT_MS } from "../cache.js";

/** A nonce per test keeps one test's cache entries out of another's way. */
let nonce = "";
const listing = () => `<!DOCTYPE html><html><head>
  <meta property="og:description" content="A test newsletter">
  <meta property="og:image" content="https://media.licdn.com/cover.jpg">
</head><body>
  <h1>Cache Test Newsletter</h1>
  <a href="https://www.linkedin.com/pulse/one-${nonce}">One</a>
  <a href="https://www.linkedin.com/pulse/two-${nonce}">Two</a>
</body></html>`;

const article = (title) => `<!DOCTYPE html><html><body>
  <script type="application/ld+json">${JSON.stringify({
    name: title,
    datePublished: "2026-01-01T00:00:00Z",
    author: { name: "A Writer" },
  })}</script>
  <h1>${title}</h1>
  <div data-test-id="article-content-blocks"><p>Body of ${title}.</p></div>
</body></html>`;

/** A unique slug per test, so one test's cache entry cannot serve another. */
let n = 0;
const freshSlug = () => `cache-test-${Date.now()}-${n++}`;

let upstream;
const pulseCalls = () =>
  upstream.mock.calls.filter(([i]) =>
    String(typeof i === "string" ? i : i.url).includes("/pulse/")
  ).length;

beforeEach(() => {
  nonce = `${Date.now()}-${n++}`;
  upstream = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/newsletters/")) return new Response(listing());
    if (url.includes("/pulse/one-")) return new Response(article("One"));
    if (url.includes("/pulse/two-")) return new Response(article("Two"));
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", upstream);
});

describe("etagFor", () => {
  it("is stable for the same body and different for another", async () => {
    expect(await etagFor("abc")).toBe(await etagFor("abc"));
    expect(await etagFor("abc")).not.toBe(await etagFor("abd"));
  });

  it("is a quoted hex digest", async () => {
    expect(await etagFor("abc")).toMatch(/^"[0-9a-f]{40}"$/);
  });
});

describe("notModified", () => {
  const response = () =>
    new Response("body", { headers: { etag: '"x"', "cache-control": "public" } });

  it("returns null without a matching If-None-Match", () => {
    const request = new Request("https://e.com/", { headers: { "if-none-match": '"y"' } });
    expect(notModified(request, response())).toBeNull();
  });

  it("returns 304 with no body when the tag matches", async () => {
    const request = new Request("https://e.com/", { headers: { "if-none-match": '"x"' } });
    const res = notModified(request, response());
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("public");
  });

  it("matches one tag out of a list, and ignores the weak marker", () => {
    const request = new Request("https://e.com/", {
      headers: { "if-none-match": 'W/"a", "x", "b"' },
    });
    expect(notModified(request, response())?.status).toBe(304);
  });
});

describe("Feed caching", () => {
  it("sets an ETag, a Cache-Control and a Last-Modified", async () => {
    const res = await SELF.fetch(`https://example.com/${freshSlug()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  it("answers a conditional poll with 304 and no body", async () => {
    const url = `https://example.com/${freshSlug()}`;
    const first = await SELF.fetch(url);
    const etag = first.headers.get("etag");

    const second = await SELF.fetch(url, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("serves a repeat poll without touching LinkedIn again", async () => {
    const url = `https://example.com/${freshSlug()}`;
    await SELF.fetch(url);
    const afterFirst = upstream.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await SELF.fetch(url);
    expect(second.status).toBe(200);
    expect(upstream.mock.calls.length).toBe(afterFirst);
  });

  it("reuses a parsed article across two different newsletters", async () => {
    await SELF.fetch(`https://example.com/${freshSlug()}`);
    expect(pulseCalls()).toBe(2);

    // A different slug, so the feed cache misses and the listing is fetched
    // again. Both issues are the same pages, and are already parsed.
    await SELF.fetch(`https://example.com/${freshSlug()}`);
    expect(pulseCalls()).toBe(2);
  });

  it("gives every upstream fetch a timeout", async () => {
    await SELF.fetch(`https://example.com/${freshSlug()}`);
    for (const [, init] of upstream.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("Homepage caching", () => {
  it("sets an ETag and answers a conditional request with 304", async () => {
    const first = await SELF.fetch("https://example.com/");
    expect(first.headers.get("etag")).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("public, max-age=3600");

    const second = await SELF.fetch("https://example.com/", {
      headers: { "if-none-match": first.headers.get("etag") },
    });
    expect(second.status).toBe(304);
  });
});

describe("Non-ASCII feed titles", () => {
  it("does not put raw UTF-8 bytes in the header", async () => {
    nonce = `accent-${Date.now()}`;
    const accented = `<!DOCTYPE html><html><head>
      <meta property="og:description" content="d">
    </head><body><h1>IA g&eacute;n&eacute;rative: Le AI BIG Recap</h1>
      <a href="https://www.linkedin.com/pulse/one-${nonce}">1</a>
    </body></html>`;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/newsletters/")) return new Response(accented);
      if (url.includes("/pulse/")) return new Response(article("One"));
      return real(input);
    });

    const res = await SELF.fetch(`https://example.com/${freshSlug()}`);
    const header = res.headers.get("x-feed-title");
    // A header value must be ASCII. Workers warns, and a browser would throw.
    expect(header).toMatch(/^[\x20-\x7E]*$/);
    expect(decodeURIComponent(header)).toBe("IA générative: Le AI BIG Recap");
    // The feed itself still carries the real characters.
    expect(await res.text()).toContain("IA générative");
  });
});

describe("304 responses keep the caller's headers", () => {
  it("carries x-feed-title through, so a conditional poll is still named", async () => {
    const url = `https://example.com/${freshSlug()}`;
    const first = await SELF.fetch(url);
    const title = first.headers.get("x-feed-title");
    expect(title).toBeTruthy();

    const second = await SELF.fetch(url, {
      headers: { "if-none-match": first.headers.get("etag") },
    });
    expect(second.status).toBe(304);
    // Production showed most popularity rows with an empty title, because a
    // conditional poll dropped this header and recorded "".
    expect(second.headers.get("x-feed-title")).toBe(title);
  });

  it("still carries the standard validators", async () => {
    const url = `https://example.com/${freshSlug()}`;
    const first = await SELF.fetch(url);
    const second = await SELF.fetch(url, {
      headers: { "if-none-match": first.headers.get("etag") },
    });
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(second.headers.get("cache-control")).toBe("public, max-age=900");
  });
});

import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  KV_KEY,
  popularQuery,
  readPopular,
  recordHit,
  refreshPopular,
  warmPopular,
  WARM_NEWSLETTERS,
} from "../popular.js";

const ROWS = [
  { slug: "alpha-123", title: "Alpha", hits: 900 },
  { slug: "beta-456", title: "Beta", hits: 120 },
];

describe("popularQuery", () => {
  it("uses argMax, which Analytics Engine supports, not any()", () => {
    const sql = popularQuery();
    expect(sql).toContain("argMax(blob2, timestamp)");
    expect(sql).not.toContain("any(");
  });

  it("undoes sampling so the count estimates real requests", () => {
    expect(popularQuery()).toContain("SUM(_sample_interval)");
  });

  it("asks for JSON and bounds the result", () => {
    const sql = popularQuery();
    expect(sql).toContain("FORMAT JSON");
    expect(sql).toContain("LIMIT 20");
    expect(sql).toContain("INTERVAL '7' DAY");
  });
});

describe("recordHit", () => {
  it("does nothing without the binding", () => {
    expect(() => recordHit({}, undefined, { slug: "a", kind: "newsletter" })).not.toThrow();
  });

  it("writes one data point with the slug indexed", () => {
    const writeDataPoint = vi.fn();
    recordHit({ AE: { writeDataPoint } }, undefined, {
      slug: "alpha-123",
      title: "Alpha",
      kind: "newsletter",
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual(["alpha-123"]);
    expect(point.blobs).toEqual(["alpha-123", "Alpha", "newsletter"]);
  });

  it("clamps the index to the 96 byte limit", () => {
    const writeDataPoint = vi.fn();
    recordHit({ AE: { writeDataPoint } }, undefined, {
      slug: "x".repeat(200),
      kind: "newsletter",
    });
    const [index] = writeDataPoint.mock.calls[0][0].indexes;
    expect(new TextEncoder().encode(index).length).toBeLessThanOrEqual(96);
  });

  it("swallows a failing write rather than failing the request", () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error("nope");
    });
    expect(() =>
      recordHit({ AE: { writeDataPoint } }, undefined, { slug: "a", kind: "newsletter" })
    ).not.toThrow();
  });
});

describe("readPopular", () => {
  beforeEach(async () => {
    await env.POPULAR.delete(KV_KEY);
  });

  it("returns [] when nothing is bound", async () => {
    expect(await readPopular({})).toEqual([]);
  });

  it("returns [] before the cron has ever run", async () => {
    expect(await readPopular(env)).toEqual([]);
  });

  it("returns what the cron stored", async () => {
    await env.POPULAR.put(KV_KEY, JSON.stringify(ROWS));
    expect(await readPopular(env)).toEqual(ROWS);
  });
});

describe("refreshPopular", () => {
  beforeEach(async () => {
    await env.POPULAR.delete(KV_KEY);
  });

  it("skips, without throwing, when the secrets are missing", async () => {
    const result = await refreshPopular({ POPULAR: env.POPULAR });
    expect(result).toEqual({ skipped: true });
  });

  it("stores the rows the query returns", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: ROWS })));
    const result = await refreshPopular(
      { POPULAR: env.POPULAR, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" },
      fetchImpl
    );
    expect(result).toEqual({ count: 2 });
    expect(await env.POPULAR.get(KV_KEY, "json")).toEqual(ROWS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql"
    );
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("accepts a bare array as well as a wrapped one", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(ROWS));
    await refreshPopular(
      { POPULAR: env.POPULAR, CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t" },
      fetchImpl
    );
    expect(await env.POPULAR.get(KV_KEY, "json")).toEqual(ROWS);
  });

  it("drops rows with no slug or no hits", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ data: [...ROWS, { slug: "", hits: 5 }, { slug: "c", hits: 0 }] })
      );
    await refreshPopular(
      { POPULAR: env.POPULAR, CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t" },
      fetchImpl
    );
    expect(await env.POPULAR.get(KV_KEY, "json")).toEqual(ROWS);
  });

  it("throws on an API error rather than storing rubbish", async () => {
    const fetchImpl = async () => new Response("denied", { status: 403 });
    await expect(
      refreshPopular(
        { POPULAR: env.POPULAR, CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t" },
        fetchImpl
      )
    ).rejects.toThrow("403");
    expect(await env.POPULAR.get(KV_KEY)).toBeNull();
  });
});

describe("Homepage popularity panel", () => {
  beforeEach(async () => {
    await env.POPULAR.delete(KV_KEY);
  });

  it("is omitted when there is no data", async () => {
    const html = await (await SELF.fetch("https://example.com/")).text();
    expect(html).not.toContain("Most followed");
  });

  it("renders a bar per newsletter, widest first", async () => {
    await env.POPULAR.put(KV_KEY, JSON.stringify(ROWS));
    const html = await (await SELF.fetch("https://example.com/")).text();
    expect(html).toContain("Most followed");
    expect(html).toContain("Alpha");
    expect(html).toContain('href="/alpha-123"');
    expect(html).toContain("width:100%");
    // 120 of 900 is 13%.
    expect(html).toContain("width:13%");
  });

  it("escapes a title rather than trusting it", async () => {
    await env.POPULAR.put(
      KV_KEY,
      JSON.stringify([{ slug: "x", title: "<script>alert(1)</script>", hits: 1 }])
    );
    const html = await (await SELF.fetch("https://example.com/")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("warmPopular", () => {
  const LISTING = `<!DOCTYPE html><html><body><h1>N</h1>
    <a href="https://www.linkedin.com/pulse/one-abc">1</a>
    <a href="https://www.linkedin.com/pulse/two-def">2</a>
  </body></html>`;

  beforeEach(async () => {
    await env.POPULAR.delete(KV_KEY);
  });

  it("does nothing without SITE_URL", async () => {
    expect(await warmPopular({ POPULAR: env.POPULAR })).toEqual({
      warmed: 0,
      skipped: true,
    });
  });

  it("does nothing before the popularity list exists", async () => {
    const result = await warmPopular(
      { POPULAR: env.POPULAR, SITE_URL: "https://s.test" },
      vi.fn()
    );
    expect(result).toEqual({ warmed: 0 });
  });

  it("warms each issue through the /article/ route, not the feed", async () => {
    await env.POPULAR.put(KV_KEY, JSON.stringify([{ slug: "n-1", title: "N", hits: 9 }]));
    const fetchImpl = vi.fn(async (url) =>
      url.includes("/newsletters/") ? new Response(LISTING) : new Response("{}")
    );
    const result = await warmPopular(
      { POPULAR: env.POPULAR, SITE_URL: "https://s.test" },
      fetchImpl
    );
    expect(result).toEqual({ warmed: 2 });

    const urls = fetchImpl.mock.calls.map(([u]) => u);
    expect(urls).toContain("https://s.test/article/one-abc");
    expect(urls).toContain("https://s.test/article/two-def");
    // Requesting the feed itself would be the expensive build we are avoiding.
    expect(urls.some((u) => u === "https://s.test/n-1")).toBe(false);
  });

  it("stays inside the subrequest limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      slug: `n-${i}`,
      title: `N${i}`,
      hits: 100 - i,
    }));
    await env.POPULAR.put(KV_KEY, JSON.stringify(many));
    const fetchImpl = vi.fn(async (url) =>
      url.includes("/newsletters/") ? new Response(LISTING) : new Response("{}")
    );
    await warmPopular({ POPULAR: env.POPULAR, SITE_URL: "https://s.test" }, fetchImpl);
    // WARM_NEWSLETTERS listings plus their issues, against a limit of 50.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(50);
    expect(fetchImpl.mock.calls.length).toBe(WARM_NEWSLETTERS * 3);
  });

  it("carries on when one newsletter fails", async () => {
    await env.POPULAR.put(
      KV_KEY,
      JSON.stringify([
        { slug: "bad", title: "Bad", hits: 9 },
        { slug: "good", title: "Good", hits: 8 },
      ])
    );
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/newsletters/bad")) throw new Error("upstream down");
      if (url.includes("/newsletters/")) return new Response(LISTING);
      return new Response("{}");
    });
    expect(
      await warmPopular({ POPULAR: env.POPULAR, SITE_URL: "https://s.test" }, fetchImpl)
    ).toEqual({ warmed: 2 });
  });
});

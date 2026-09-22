/**
 * Caching and conditional requests.
 *
 * RSS readers poll hard and mostly get the same bytes back. Before this, every
 * poll re-fetched a LinkedIn listing page plus five article pages and reparsed
 * all six, because the feed responses carried no Cache-Control, no ETag and no
 * Last-Modified, and nothing was stored between requests.
 *
 * Three layers, cheapest first:
 *
 *  1. A conditional request answered with 304, which sends no body at all.
 *  2. The feed response in the Cache API, which costs almost no CPU to serve.
 *  3. Each parsed article in the Cache API, so rebuilding a feed reparses only
 *     the issue that is new rather than all five.
 *
 * `caches.default` needs no binding and is free. It is per-datacentre and
 * evictable, so every layer treats a miss as normal.
 */

/** A feed changes when a new issue lands, which is weekly at best. */
export const FEED_TTL = 900; // 15 minutes
// A published LinkedIn article does not change. A long life here is what keeps
// a feed rebuild cheap: the feed copy expires every 15 minutes, but the issues
// it is built from stay parsed, so a rebuild costs 7ms rather than 38ms.
export const ARTICLE_TTL = 86400; // 24 hours
export const PAGE_TTL = 3600; // 1 hour
export const REDIRECT_TTL = 86400; // 1 day

/** Upstream is LinkedIn. A hung fetch must not hold the request open. */
export const UPSTREAM_TIMEOUT_MS = 8000;

/**
 * Internal cache keys live on a hostname we do not serve, so they cannot
 * collide with a real request URL.
 */
const NS = "https://cache.linkedinrss.invalid";

export function articleKey(url, origin) {
  return new Request(
    `${NS}/article?u=${encodeURIComponent(url)}&o=${encodeURIComponent(origin)}`
  );
}

function cacheOrNull() {
  try {
    return caches?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch with a timeout. Without one, a slow LinkedIn response blocks the whole
 * feed; the listing page took 2.3 seconds when this was measured.
 */
export function fetchUpstream(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

/**
 * A strong ETag over the body. SHA-1 runs in native code, so hashing a 130KB
 * feed is far cheaper than rebuilding it, and it is computed once per cache
 * fill rather than once per request.
 */
export async function etagFor(body) {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(body)
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

/**
 * Answer a conditional request. RSS readers send If-None-Match on every poll
 * once they have seen an ETag, so this is where most of the bandwidth goes.
 */
export function notModified(request, response) {
  const etag = response.headers.get("etag");
  if (!etag) return null;
  const candidates = (request.headers.get("if-none-match") || "")
    .split(",")
    .map((s) => s.trim().replace(/^W\//, ""));
  if (!candidates.includes(etag.replace(/^W\//, ""))) return null;

  const headers = new Headers();
  for (const name of ["etag", "cache-control", "last-modified", "vary"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(null, { status: 304, headers });
}

/**
 * Serve `build()` with an ETag, a Cache-Control and a 304 on the way out.
 *
 * `build` returns either a string or `{ body, meta }`. Anything in `meta`
 * becomes a response header, which is how a value known only at build time
 * survives into a cache hit.
 *
 * `store: false` keeps the ETag and the Cache-Control but skips the Cache API.
 * Use it for a page whose content can change underneath us: a stored copy would
 * go on being served until its TTL ran out.
 *
 * `ctx.waitUntil` keeps the cache write off the response path. Without a ctx,
 * which is the case in some tests, the write is awaited instead.
 */
export async function withCache(
  request,
  ctx,
  { ttl, contentType, build, store = true }
) {
  const cache = store ? cacheOrNull() : null;
  const key = new Request(request.url, { method: "GET" });

  let response = cache ? await cache.match(key) : null;
  if (!response) {
    const fresh = await build();
    const body = typeof fresh === "string" ? fresh : fresh.body;
    const headers = new Headers({
      "content-type": contentType,
      "cache-control": `public, max-age=${ttl}`,
      etag: await etagFor(body),
      "last-modified": new Date().toUTCString(),
    });
    for (const [name, value] of Object.entries(fresh?.meta || {})) {
      if (value) headers.set(name, value);
    }
    response = new Response(body, { headers });
    if (cache) {
      const write = cache.put(key, response.clone());
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
  }

  return notModified(request, response) ?? response;
}

/**
 * Read a JSON value previously stored by `putJson`.
 */
export async function getJson(key) {
  const cache = cacheOrNull();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

export function putJson(key, value, ttl, ctx) {
  const cache = cacheOrNull();
  if (!cache) return;
  const write = cache
    .put(
      key,
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttl}`,
        },
      })
    )
    .catch((error) => console.error("Cache write failed:", error.message));
  if (ctx?.waitUntil) ctx.waitUntil(write);
}

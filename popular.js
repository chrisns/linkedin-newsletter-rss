/**
 * What people follow, counted for free.
 *
 * Workers Analytics Engine includes 100,000 data points written and 10,000 read
 * queries per day on the free plan. One data point per feed request is well
 * inside that, and `writeDataPoint` is fire-and-forget.
 *
 * Reading is the expensive half, so the homepage never queries it. A cron
 * trigger runs the SQL once every 15 minutes and writes the result to KV; the
 * homepage reads one key. At 96 writes a day that also stays inside the free
 * KV allowance of 1,000 writes per day.
 *
 * Every binding here is optional. Without them the Worker still serves feeds
 * and the homepage simply omits the panel.
 */

export const KV_KEY = "popular:v1";
export const WINDOW_DAYS = 7;
export const TOP_N = 20;

/** Analytics Engine caps an index at 96 bytes. */
const MAX_INDEX_BYTES = 96;

function clampIndex(slug) {
  let out = slug;
  while (new TextEncoder().encode(out).length > MAX_INDEX_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Record one feed request. Never throws, never delays the response.
 */
export function recordHit(env, ctx, { slug, title, kind }) {
  if (!env?.AE?.writeDataPoint || !slug) return;
  const write = () => {
    try {
      env.AE.writeDataPoint({
        indexes: [clampIndex(slug)],
        blobs: [slug, title || "", kind],
        doubles: [1],
      });
    } catch (error) {
      console.error("Analytics write failed:", error.message);
    }
  };
  if (ctx?.waitUntil) ctx.waitUntil(Promise.resolve().then(write));
  else write();
}

/**
 * The list the homepage renders. Returns [] when the namespace is not bound or
 * the cron has not run yet.
 */
export async function readPopular(env) {
  if (!env?.POPULAR?.get) return [];
  try {
    const rows = await env.POPULAR.get(KV_KEY, "json");
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("Popular read failed:", error.message);
    return [];
  }
}

/**
 * `argMax(blob2, timestamp)` takes the most recent title we saw for a slug,
 * which matters because a newsletter can be renamed. Analytics Engine has no
 * `any()`. `SUM(_sample_interval)` undoes sampling, so the count is an estimate
 * of real requests rather than of rows stored.
 */
export function popularQuery(dataset = "linkedinrss") {
  return `SELECT
  blob1 AS slug,
  argMax(blob2, timestamp) AS title,
  SUM(_sample_interval) AS hits
FROM ${dataset}
WHERE timestamp > NOW() - INTERVAL '${WINDOW_DAYS}' DAY
  AND blob3 = 'newsletter'
  AND blob1 != ''
GROUP BY slug
ORDER BY hits DESC
LIMIT ${TOP_N}
FORMAT JSON`;
}

/**
 * Run the query and store the result. Called from the cron trigger.
 */
export async function refreshPopular(env, fetchImpl = fetch) {
  const account = env?.CF_ACCOUNT_ID;
  const token = env?.CF_ANALYTICS_TOKEN;
  if (!account || !token || !env?.POPULAR?.put) {
    console.log(
      "Popularity refresh skipped: CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN or the POPULAR namespace is not configured."
    );
    return { skipped: true };
  }

  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: popularQuery(),
    }
  );
  if (!response.ok) {
    throw new Error(`Analytics query returned ${response.status}`);
  }

  // ClickHouse FORMAT JSON wraps rows in `data`. Tolerate a bare array in case
  // that changes.
  const payload = await response.json();
  const raw = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(raw)) {
    throw new Error("Analytics query returned an unexpected shape");
  }

  const rows = raw
    .map((row) => ({
      slug: String(row.slug || ""),
      title: String(row.title || ""),
      hits: Number(row.hits) || 0,
    }))
    .filter((row) => row.slug && row.hits > 0);

  await env.POPULAR.put(KV_KEY, JSON.stringify(rows));
  return { count: rows.length };
}

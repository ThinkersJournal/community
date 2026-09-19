/**
 * Purges the CDN's edge cache for specific media URLs (issue #61).
 *
 * ⚠️ DIFFERENT SURFACE FROM `purge.ts`. That module purges `web`'s rendered-
 * HTML cache by TAG, over a Service Binding. Media is served from the
 * `cdn.thinkersjournal.com` R2 custom domain — a zone-level Cloudflare cache
 * with no Worker in front of it — so it can only be purged by URL, through
 * Cloudflare's Cache Purge REST API, with a zone-scoped API token
 * (`CACHE_PURGE_TOKEN` — see the PR description for who creates it and
 * which Worker holds it).
 *
 * ⚠️ THROWS ON FAILURE — THE OPPOSITE CONTRACT FROM `purge.ts`'s `purgeTags`,
 * DELIBERATELY. That module's objects are already publicly unreachable by the
 * time it purges (the DB write already moved them); a page-cache purge miss
 * there just means a stale render for up to 25 hours. HERE, the object is
 * served `cache-control: immutable, max-age=1y` — an unconfirmed purge (a
 * missing/invalid `CACHE_PURGE_TOKEN`, a bad zone id, a Cloudflare 5xx) can
 * leave PUBLICLY-hidden content's edge-cached copy servable for up to a
 * YEAR, silently, which is exactly the exposure #61 exists to close. So this
 * throws, its ONLY caller (`src/media/moves.ts`'s `runMove`) treats that as
 * the whole move failing and retries the move (including this purge) rather
 * than marking it done, and `processPendingMoves` alerts loudly once retries
 * are exhausted. A missing secret must fail LOUDLY, never silently no-op.
 */
const MEDIA_CDN_ORIGIN = "https://cdn.thinkersjournal.com";

export async function purgeMediaUrls(env: Env, r2Keys: readonly string[]): Promise<void> {
  const unique = [...new Set(r2Keys)];
  if (unique.length === 0) return;

  if (!env.CACHE_PURGE_TOKEN || !env.CACHE_PURGE_ZONE_ID) {
    throw new Error("purgeMediaUrls: CACHE_PURGE_TOKEN/CACHE_PURGE_ZONE_ID is not configured");
  }

  const files = unique.map((key) => `${MEDIA_CDN_ORIGIN}/${key}`);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CACHE_PURGE_ZONE_ID}/purge_cache`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CACHE_PURGE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ files }),
    },
  );
  if (!response.ok) {
    throw new Error(`purgeMediaUrls: Cloudflare purge_cache returned ${response.status}`);
  }
}

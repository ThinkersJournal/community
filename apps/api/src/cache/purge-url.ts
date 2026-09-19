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
 * ⚠️ NEVER THROWS, same contract as `purge.ts`'s `purgeTags` — the object has
 * already moved between buckets by the time this runs, so a purge failure
 * must not undo that or fail the caller. Its own retry lives in
 * `src/media/moves.ts` (the whole move, including this call, re-runs on the
 * next attempt if any step fails).
 */
const MEDIA_CDN_ORIGIN = "https://cdn.thinkersjournal.com";

export async function purgeMediaUrls(env: Env, r2Keys: readonly string[]): Promise<void> {
  const unique = [...new Set(r2Keys)];
  if (unique.length === 0) return;

  const files = unique.map((key) => `${MEDIA_CDN_ORIGIN}/${key}`);
  try {
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
      console.error("purgeMediaUrls: Cloudflare purge_cache returned", response.status);
    }
  } catch (err) {
    console.error("purgeMediaUrls: request failed", err);
  }
}

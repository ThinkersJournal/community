/**
 * KV cache for a viewer's followee-id list — the read side of the follow graph
 * behind getFolloweeIds (social/followees.ts). Cache-aside: read here, fall back
 * to Postgres on a miss, populate, and bust on every follow/unfollow.
 *
 * FAIL-OPEN throughout: a KV fault (or a corrupt value) makes readFolloweeCache
 * return null, i.e. "treat as a miss", so the caller degrades to a plain
 * Postgres read — never a failed feed. A failed write/bust is swallowed; the
 * 300s TTL self-heals a lost bust. Values are stored as text and JSON.parse'd by
 * hand, matching auth/session.ts (no "json"-typed KV get anywhere in src).
 */

/** TTL backstop for a cached list (see the design's freshness decision). */
const FOLLOWEE_TTL_SECONDS = 300;

/** The one place the `followees:<userId>` key format lives. */
export function followeeKey(userId: string): string {
  return `followees:${userId}`;
}

/**
 * The cached followee-id list, or null on a miss OR any KV error / corrupt
 * value (fail-open to Postgres). An empty follow set is cached as `[]` and
 * returned as `[]` — a genuine HIT, distinct from null, so zero-follow viewers
 * stop re-hitting Postgres.
 */
export async function readFolloweeCache(env: Env, userId: string): Promise<string[] | null> {
  try {
    const raw = await env.FOLLOWEES.get(followeeKey(userId));
    return raw === null ? null : (JSON.parse(raw) as string[]);
  } catch {
    return null;
  }
}

/** Cache a viewer's followee-id list with the 300s TTL. Swallowed on error. */
export async function writeFolloweeCache(env: Env, userId: string, ids: string[]): Promise<void> {
  try {
    await env.FOLLOWEES.put(followeeKey(userId), JSON.stringify(ids), {
      expirationTtl: FOLLOWEE_TTL_SECONDS,
    });
  } catch {
    // best-effort: a lost write just means the next read misses.
  }
}

/** Invalidate a viewer's cached followee-id list. Swallowed on error. */
export async function bustFolloweeCache(env: Env, userId: string): Promise<void> {
  try {
    await env.FOLLOWEES.delete(followeeKey(userId));
  } catch {
    // best-effort: the 300s TTL backstops a lost bust.
  }
}

/**
 * THE FOLLOWEE-GRAPH SEAM. Every feed read routes its "whose posts?" question
 * through this one function — now cache-aside over KV (followee-cache.ts) with a
 * Postgres fallback, invalidated on follow/unfollow. A hit costs ZERO Postgres;
 * a zero-follow viewer is a cached `[]` that lets the feed skip the posts query
 * entirely. Do not inline this query elsewhere.
 */
import { withClient } from "../db/client";

import { readFolloweeCache, writeFolloweeCache } from "./followee-cache";

export async function getFolloweeIds(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<string[]> {
  const cached = await readFolloweeCache(env, userId);
  if (cached !== null) return cached;

  const ids = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ followee_id: string }>(
      "SELECT followee_id FROM follows WHERE follower_id = $1",
      [userId],
    );
    return rows.map((r) => r.followee_id);
  });
  await writeFolloweeCache(env, userId, ids);
  return ids;
}

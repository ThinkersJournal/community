/**
 * THE FOLLOWEE-GRAPH SEAM. Every feed read routes its "whose posts?" question
 * through this one function. Today it is a single indexed Postgres query; the
 * roadmapped KV followee-list cache (memory: m2-kv-followee-cache-roadmap) drops
 * in HERE — a KV read with a Postgres fallback, invalidated on follow/unfollow —
 * without touching a single feed call site. Do not inline this query elsewhere.
 */
import type { Client } from "pg";

export async function getFolloweeIds(client: Client, userId: string): Promise<string[]> {
  const { rows } = await client.query<{ followee_id: string }>(
    "SELECT followee_id FROM follows WHERE follower_id = $1",
    [userId],
  );
  return rows.map((r) => r.followee_id);
}

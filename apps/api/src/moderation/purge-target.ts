/**
 * The edge-cache tags a moderation visibility change must purge.
 *
 * ⚠️ These are exactly the tags apps/web/src/lib/cache.ts sets on public
 * renders, and the same set a post delete purges (routes/posts.ts). A
 * visibility change that skips the purge leaves hidden content publicly
 * cached for up to PUBLIC_MAX_AGE + PUBLIC_SWR (25 hours). Shared by
 * auto-hide (issue #54) and the moderator decision route (M4 2b-ii).
 *
 * Ids must be the DB-canonical ones from RETURNING, never caller input.
 */
import type { Client } from "pg";

export type PurgeTarget =
  | { readonly kind: "post"; readonly postId: string; readonly authorId: string; readonly tagSlugs: readonly string[] }
  | { readonly kind: "comment"; readonly postId: string };

export function purgeTagsFor(target: PurgeTarget): string[] {
  return target.kind === "post"
    ? [`post:${target.postId}`, `author:${target.authorId}`, "listing", ...target.tagSlugs.map((s) => `tag:${s}`)]
    : [`post:${target.postId}`];
}

/** The slugs of a post's tags, for its `tag:<slug>` purge entries. */
export async function loadPostTagSlugs(c: Client, postId: string): Promise<string[]> {
  const { rows } = await c.query<{ slug: string }>(
    `SELECT t.slug FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = $1`,
    [postId],
  );
  return rows.map((r) => r.slug);
}

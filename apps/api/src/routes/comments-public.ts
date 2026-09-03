/**
 * ANONYMOUS comment read — the post page's SSR source. Like social-public.ts:
 * viewer-independent, HYPERDRIVE_FRESH, NO cache-tag of its own — the EDGE
 * cache of the rendered post page (purged on every comment write) is the cache.
 *
 * Ascending `path` keyset: `ORDER BY path` IS thread order (the materialized-
 * path payoff), so the cursor is simply the last path seen. A page may cut a
 * thread mid-branch; the next page continues it exactly. Tombstones stay IN the
 * stream (their children need anchoring) but ship with no body and no author.
 */
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import type { CommentRow, CommentsPage } from "@thinkersjournal/shared";

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DbRow {
  id: string;
  parentId: string | null;
  depth: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  bodyMarkdown: string;
  path: string;
  authorUserId: string;
  username: string;
  displayName: string | null;
}

export async function handlePublicComments(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const postId = url.searchParams.get("postId") ?? "";
  // Missing and malformed collapse into the same 404 a nonexistent post gets.
  if (!UUID_RE.test(postId)) return errorResponse("NOT_FOUND", 404);
  // '' sorts before every path — the natural first-page sentinel for an ASC keyset.
  const cursor = url.searchParams.get("cursor") ?? "";

  const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const post = await c.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1 AND hidden_at IS NULL",
      [postId],
    );
    // Draft parity — indistinguishable from nonexistent. An auto-hidden post
    // (hidden_at set) is excluded by the query above, so it falls through here
    // too: its comment thread is served no more than the post itself is.
    if (post.rows[0]?.status !== "published") return null;

    const { rows } = await c.query<DbRow>(
      `SELECT c.id, c.parent_id AS "parentId", c.depth,
              c.created_at AS "createdAt", c.edited_at AS "editedAt",
              (c.deleted_at IS NOT NULL) AS deleted,
              c.body_markdown AS "bodyMarkdown", c.path,
              pr.user_id AS "authorUserId", pr.username, pr.display_name AS "displayName"
         FROM comments c
         JOIN profiles pr ON pr.user_id = c.author_id
        -- An auto-hidden comment (hidden_at set) is EXCLUDED entirely — not shown
        -- as a tombstone the way a deleted one is. Its descendants lose their
        -- anchor, but a globally-hidden subtree is exactly what auto-hide intends.
        WHERE c.post_id = $1 AND c.hidden_at IS NULL AND c.path > $2
        ORDER BY c.path
        LIMIT ${PAGE_SIZE + 1}`,
      [postId, cursor],
    );
    const hasMore = rows.length > PAGE_SIZE;
    const slice = rows.slice(0, PAGE_SIZE);
    const comments: CommentRow[] = slice.map((r) =>
      r.deleted
        ? {
            id: r.id, parentId: r.parentId, depth: r.depth,
            createdAt: r.createdAt, editedAt: null, path: r.path,
            deleted: true, bodyMarkdown: "", author: null,
          }
        : {
            id: r.id, parentId: r.parentId, depth: r.depth,
            createdAt: r.createdAt, editedAt: r.editedAt, path: r.path,
            deleted: false, bodyMarkdown: r.bodyMarkdown,
            author: { userId: r.authorUserId, username: r.username, displayName: r.displayName },
          },
    );
    return {
      comments,
      nextCursor: hasMore ? slice[slice.length - 1]!.path : null,
    } satisfies CommentsPage;
  });

  if (page === null) return errorResponse("NOT_FOUND", 404);
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

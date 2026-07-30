/**
 * BROWSER read hop for the LIVE comment-window reconcile (M2.3b-live). When a
 * "comment" nudge arrives over `/api/posts-live`, the client cannot render
 * markdown itself (sanitize-first is server-side only — the SSR pipeline is
 * the ONLY producer of comment HTML, per [handle]/[slug].astro's header), so
 * it re-fetches this endpoint and gets back the same window ALREADY rendered
 * through `renderMarkdown` — the identical sanitize-first pipeline the post
 * page's SSR `renderedComments` uses. This is the client's ONLY HTML sink;
 * the reconcile script assigns `html` straight to `.innerHTML` and nothing
 * else in that script ever does.
 *
 * MIRRORS `[handle]/[slug].astro`'s `renderedComments` mapping field-for-
 * field (id/parentId/depth/authorUsername/authorName/createdAt/edited/
 * deleted/html), plus `path` (for the client's path-ordered DOM insertion —
 * see Task 7) which the SSR page doesn't currently surface as a discrete
 * field. Tombstones NEVER reach `renderMarkdown` — `bodyMarkdown` is already
 * "" on a tombstone (comments-public.ts), but the ternary below is the
 * belt-and-braces guard the source-test pins.
 *
 * ANONYMOUS on purpose, like `/api/comments` (edit-prefill) and the SSR
 * page's own comments read — the api's `GET /public/comments` reads no
 * session, so forwarding the browser's cookie here would buy nothing.
 * markPrivate + no-store: this is a live poll-driven read, never the edge
 * cache (the post page's own cache is untouched by this endpoint).
 */
import { renderMarkdown } from "@thinkersjournal/markdown";

import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { CommentsPage } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const url = new URL(context.request.url);
  const postId = url.searchParams.get("postId") ?? "";
  const cursor = url.searchParams.get("cursor");
  const q = new URLSearchParams({ postId });
  if (cursor !== null) q.set("cursor", cursor);

  // ⚠️ ANONYMOUS — no `request` forwarded, same convention as /api/comments.
  const response = await apiFetch<CommentsPage>(`/public/comments?${q.toString()}`);
  const page: CommentsPage =
    response.status === 200 && response.data !== null
      ? response.data
      : { comments: [], nextCursor: null };

  // READ-TIME RENDER through the same sanitize-first pipeline as the SSR post
  // page — a tombstone's body is NEVER passed to renderMarkdown.
  const comments = await Promise.all(
    page.comments.map(async (c) => ({
      id: c.id,
      parentId: c.parentId,
      depth: c.depth,
      path: c.path,
      authorUsername: c.author?.username ?? "",
      authorName: c.author === null ? null : (c.author.displayName ?? c.author.username),
      createdAt: c.createdAt,
      edited: c.editedAt !== null,
      deleted: c.deleted,
      html: c.deleted ? "" : await renderMarkdown(c.bodyMarkdown),
    })),
  );

  return new Response(JSON.stringify({ comments, nextCursor: page.nextCursor }), {
    status: 200,
    headers,
  });
};

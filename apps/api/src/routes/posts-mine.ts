/**
 * The author's OWN posts, beyond a single one by id (routes/posts.ts):
 *
 *   GET /posts/by-slug?slug=…  — one of the caller's own posts, by slug
 *                                (#78 — the owner-visible fallback on
 *                                [handle]/[slug].astro's public 404)
 *   GET /posts                 — every one of the caller's own posts, ANY
 *                                status (draft, published, hidden — #78's
 *                                "my posts" listing)
 *
 * Both session-authenticated, both scoped to `author_id = session.userId` in
 * the WHERE clause (never a preceding SELECT — same race-safety discipline
 * as posts.ts), never edge-cached (`no-store`) — this is per-author,
 * drafts-included data, exactly like `GET /posts/:id`.
 *
 * ⚠️ ROUTE ORDERING (PM review, #78 condition 2): `GET /posts/by-slug` MUST
 * be registered in routes.ts BEFORE `GET /posts/:id` — both are one path
 * segment under `/posts`, and `findRoute` is first-match-wins (routing.ts's
 * header), so a `:id` registered first would swallow `by-slug` as a literal
 * id value. Exact precedent already in this file's sibling: `/posts/live`
 * before `/posts/:id` (routes.ts). test/posts-mine.test.ts pins this
 * directly (asserts `by-slug` does NOT reach `handleGetPost`), not just by
 * registration order, so a future reorder fails loudly.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { readCurrentSession } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { hiddenReasonCaseSql } from "../moderation/hidden-reason";
import { isInvalidTextRepresentation } from "../db/errors";
import { loadAuthoredPostBy } from "./posts";

import type { AuthoredPostSummary, MyPostsPage } from "@thinkersjournal/shared";
import type { RouteParams } from "../routing";

function loginRequired(extraHeaders: Record<string, string> = {}): Response {
  return errorResponse("LOGIN_REQUIRED", 401, { headers: extraHeaders });
}
function notFound(): Response {
  return errorResponse("NOT_FOUND", 404);
}

export async function handleGetPostBySlug(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  _params: RouteParams,
): Promise<Response> {
  const session = await readCurrentSession(env, request, loginRequired);
  if (session instanceof Response) return session;

  const slug = new URL(request.url).searchParams.get("slug");
  if (slug === null || slug === "") return notFound();

  const post = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    loadAuthoredPostBy(c, session.userId, { slug }),
  );
  if (post === null) return notFound();

  return new Response(JSON.stringify(post), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const PAGE_SIZE = 50;

export async function handleListMyPosts(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  _params: RouteParams,
): Promise<Response> {
  const session = await readCurrentSession(env, request, loginRequired);
  if (session instanceof Response) return session;

  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.title, p.slug, p.status,
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt", p.hidden_at AS "hiddenAt",
                ${hiddenReasonCaseSql("p.id", "p.hidden_at")} AS "hiddenReason"
           FROM posts p
          WHERE p.author_id = $1 AND p.id < $2
          -- v7 ids are time-ordered — newest-first, no created_at index needed.
          -- Deliberately NO status/hidden_at filter: every one of the
          -- caller's own posts, any status, is the whole point of this route.
          ORDER BY p.id DESC
          -- PAGE_SIZE + 1 sentinel — same reasoning as public.ts's listings:
          -- proves a next page exists without a wasted round trip onto an
          -- empty one.
          LIMIT ${PAGE_SIZE + 1}`,
        [session.userId, cursor],
      );
      const posts = rows as AuthoredPostSummary[];
      const hasMore = posts.length > PAGE_SIZE;
      const pageRows = posts.slice(0, PAGE_SIZE);
      return {
        posts: pageRows,
        nextCursor: hasMore ? pageRows[pageRows.length - 1]!.id : null,
      } satisfies MyPostsPage;
    });
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}

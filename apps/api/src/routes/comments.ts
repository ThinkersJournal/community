/**
 * THREADED COMMENTS — the write side. Path/depth are DERIVED HERE, never
 * client-supplied: parent is looked up (same post, not tombstoned, depth < 8)
 * and the child id is minted IN the insert (uuidv7()), so `path` is always
 * `parent.path || '/' || id`. The parent check and the insert share one
 * connection but no explicit transaction: the only race (parent tombstoned
 * between the two) strands a reply under a fresh tombstone — harmless, renders
 * fine, and a transaction would not stop the SAME interleaving one tick earlier.
 *
 * ⚠️ PURGE-ON-WRITE (spec decision 4): comments are CONTENT, SSR'd into the
 * cached post page — every successful write here purges `post:<id>`, exactly
 * like a post edit. ONE call, ONE tag, AFTER the write, AWAITED.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { purgeTags } from "../cache/purge";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { hasChosenUsername } from "../db/onboarding";
import { errorResponse } from "../http/errors";

import { CreateCommentInput, UpdateCommentInput } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 8;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleCreateComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.COMMENT_LIMITER, `comment:${userId}`);
  if (limited !== null) return limited;

  if (!(await hasChosenUsername(env, ctx, userId))) {
    return errorResponse("USERNAME_REQUIRED", 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = CreateCommentInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((i) => i.path.join(".")),
    });
  }
  const { postId, parentId, markdownSource } = parsed.data;

  let outcome: { id: string } | { error: Response };
  try {
    outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // Draft parity: an unpublished post 404s exactly like a nonexistent one.
      const post = await c.query<{ status: string }>(
        "SELECT status FROM posts WHERE id = $1",
        [postId],
      );
      if (post.rows[0]?.status !== "published") {
        return { error: errorResponse("NOT_FOUND", 404) };
      }

      let parentPath: string | null = null;
      let depth = 0;
      if (parentId !== undefined) {
        const parent = await c.query<{ path: string; depth: number; deleted: boolean }>(
          `SELECT path, depth, (deleted_at IS NOT NULL) AS deleted
             FROM comments WHERE id = $1 AND post_id = $2`,
          [parentId, postId],
        );
        const row = parent.rows[0];
        // Cross-post parents 404 identically to nonexistent ones (no probe signal).
        if (row === undefined) return { error: errorResponse("COMMENT_NOT_FOUND", 404) };
        if (row.deleted) return { error: errorResponse("COMMENT_DELETED", 409) };
        if (row.depth >= MAX_DEPTH) return { error: errorResponse("COMMENT_DEPTH_EXCEEDED", 409) };
        parentPath = row.path;
        depth = row.depth + 1;
      }

      const { rows } = await c.query<{ id: string }>(
        `WITH ids AS (SELECT uuidv7() AS id)
         INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
         SELECT ids.id, $1, $2, $3,
                CASE WHEN $4::text IS NULL THEN ids.id::text
                     ELSE $4 || '/' || ids.id::text END,
                $5, $6
           FROM ids
         RETURNING id`,
        [postId, userId, parentId ?? null, parentPath, depth, markdownSource],
      );
      return { id: rows[0]!.id };
    });
  } catch (err) {
    // Post deleted between the status check and the insert → FK 23503.
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if ("error" in outcome) return outcome.error;

  // The write is committed; the cached post page is now stale. One call, one tag.
  await purgeTags(env, [`post:${postId}`]);
  return json({ id: outcome.id }, 201);
}

export async function handleUpdateComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse("INVALID_INPUT", 400, { fields: ["id"] });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = UpdateCommentInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["markdownSource"] });
  }

  // Ownership + liveness in the WHERE (atomic; no existence leak): a not-mine
  // and a not-there answer identically. No username re-check — the author
  // necessarily passed it to create this row (documented deviation 1).
  const postId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ postId: string }>(
      `UPDATE comments SET body_markdown = $3, edited_at = now()
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL
       RETURNING post_id AS "postId"`,
      [id, userId, parsed.data.markdownSource],
    );
    return rows[0]?.postId ?? null;
  });
  if (postId === null) return errorResponse("COMMENT_NOT_FOUND", 404);

  await purgeTags(env, [`post:${postId}`]);
  return json({});
}

export async function handleDeleteComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse("INVALID_INPUT", 400, { fields: ["id"] });

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    // TOMBSTONE, never DELETE: children keep their parent row; the body is
    // genuinely emptied (privacy). Ownership predicate = comment author OR
    // post author (spec decision 7), atomic in the WHERE.
    const { rows } = await c.query<{ postId: string }>(
      `UPDATE comments c
          SET deleted_at = now(), body_markdown = ''
         FROM posts p
        WHERE c.id = $1 AND p.id = c.post_id
          AND c.deleted_at IS NULL
          AND (c.author_id = $2 OR p.author_id = $2)
       RETURNING c.post_id AS "postId"`,
      [id, userId],
    );
    if (rows[0] !== undefined) return { purged: rows[0].postId };

    // Nothing updated: idempotent-success iff it IS tombstoned and this caller
    // COULD have deleted it; anything else (missing, third party) is the same 404.
    const probe = await c.query<{ mine: boolean }>(
      `SELECT (c.author_id = $2 OR p.author_id = $2) AS mine
         FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = $1 AND c.deleted_at IS NOT NULL`,
      [id, userId],
    );
    return probe.rows[0]?.mine === true ? { alreadyGone: true as const } : { notFound: true as const };
  });

  if ("notFound" in outcome) return errorResponse("COMMENT_NOT_FOUND", 404);
  if ("purged" in outcome) await purgeTags(env, [`post:${outcome.purged}`]);
  return json({}); // both fresh-tombstone and already-tombstoned answer 200
}

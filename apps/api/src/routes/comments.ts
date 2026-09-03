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
import { errorResponse } from "../http/errors";
import { isBlockedBy } from "../moderation/is-blocked";
import { notify } from "../notifications/create";
import { notifyPostLive } from "../notifications/post-live";

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
      // An auto-hidden post (moderation review) is also not a valid target, so
      // `hidden_at IS NULL` gives it the SAME NOT_FOUND — never a comment row on
      // hidden content, never a notify() to its author (mirrors reactions.ts).
      // authorId is also the top-level notify recipient (post_comment).
      const post = await c.query<{ status: string; authorId: string }>(
        `SELECT status, author_id AS "authorId" FROM posts WHERE id = $1 AND hidden_at IS NULL`,
        [postId],
      );
      if (post.rows[0]?.status !== "published") {
        return { error: errorResponse("NOT_FOUND", 404) };
      }
      const postAuthorId = post.rows[0].authorId;

      let parentPath: string | null = null;
      let depth = 0;
      let parentAuthorId: string | null = null;
      if (parentId !== undefined) {
        const parent = await c.query<{ path: string; depth: number; deleted: boolean; authorId: string }>(
          `SELECT path, depth, (deleted_at IS NOT NULL) AS deleted, author_id AS "authorId"
             FROM comments WHERE id = $1 AND post_id = $2 AND hidden_at IS NULL`,
          [parentId, postId],
        );
        const row = parent.rows[0];
        // Cross-post AND auto-hidden parents 404 identically to nonexistent ones
        // (no probe signal; mirrors reactions.ts's hidden-comment handling).
        if (row === undefined) return { error: errorResponse("COMMENT_NOT_FOUND", 404) };
        if (row.deleted) return { error: errorResponse("COMMENT_DELETED", 409) };
        if (row.depth >= MAX_DEPTH) return { error: errorResponse("COMMENT_DEPTH_EXCEEDED", 409) };
        parentPath = row.path;
        depth = row.depth + 1;
        parentAuthorId = row.authorId;
      }

      // Block enforcement (design doc §7): the actor is refused if EITHER the
      // post author or (on a reply) the parent commenter has blocked them —
      // both are "the interaction's target" here. Checked on the SAME
      // connection, before the write.
      if (await isBlockedBy(c, postAuthorId, userId)) {
        return { error: errorResponse("BLOCKED", 403) };
      }
      if (parentAuthorId !== null && (await isBlockedBy(c, parentAuthorId, userId))) {
        return { error: errorResponse("BLOCKED", 403) };
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
      const newId = rows[0]!.id;

      // Notify AFTER the comment is committed, on the same connection. Reply →
      // parent commenter; top-level → post author. notify() self-suppresses and
      // never throws, so this cannot affect the 201 the commenter gets.
      if (parentId !== undefined && parentAuthorId !== null) {
        await notify(c, env, ctx, {
          recipientId: parentAuthorId,
          actorId: userId,
          kind: "comment_reply",
          postId,
          commentId: newId,
        });
      } else {
        await notify(c, env, ctx, {
          recipientId: postAuthorId,
          actorId: userId,
          kind: "post_comment",
          postId,
          commentId: newId,
        });
      }
      return { id: newId };
    });
  } catch (err) {
    // Post deleted between the status check and the insert → FK 23503.
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if ("error" in outcome) return outcome.error;

  // The write is committed; the cached post page is now stale. One call, one tag.
  await purgeTags(env, [`post:${postId}`]);
  notifyPostLive(env, ctx, postId, "comment");
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

  // Same limiter, same key shape as handleCreateComment: create/edit/delete
  // collectively share the 10/60s window. Without this, PATCH could loop
  // unbounded on ONE owned comment, each hit firing an awaited purgeTags()
  // and burning the zone's 5-purges/min budget out from under every other
  // author's legitimate edit (see the M2.2 adversarial-review finding).
  const limited = await enforceRateLimit(env.COMMENT_LIMITER, `comment:${userId}`);
  if (limited !== null) return limited;

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
  //
  // ⚠️ NO-OP SAVES ARE NOT EDITS. `body_markdown IS DISTINCT FROM $3` skips a
  // resubmit of identical text: it must not stamp `edited_at` (a false
  // "(edited)"), purge the cached page, or fire a post-live nudge for a change
  // that didn't happen. A 0-row result is then ambiguous — unchanged, or
  // not-the-caller's-live-comment — so a follow-up existence check (only on the
  // rare 0-row path) distinguishes a 200 no-op from a 404.
  type UpdateOutcome =
    | { kind: "changed"; postId: string }
    | { kind: "unchanged" }
    | { kind: "notFound" };
  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c): Promise<UpdateOutcome> => {
    const { rows } = await c.query<{ postId: string }>(
      `UPDATE comments SET body_markdown = $3, edited_at = now()
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL
          AND body_markdown IS DISTINCT FROM $3
       RETURNING post_id AS "postId"`,
      [id, userId, parsed.data.markdownSource],
    );
    if (rows[0]) return { kind: "changed", postId: rows[0].postId };
    const { rows: live } = await c.query(
      `SELECT 1 FROM comments WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    return live[0] ? { kind: "unchanged" } : { kind: "notFound" };
  });
  if (outcome.kind === "notFound") return errorResponse("COMMENT_NOT_FOUND", 404);
  if (outcome.kind === "changed") {
    await purgeTags(env, [`post:${outcome.postId}`]);
    notifyPostLive(env, ctx, outcome.postId, "comment");
  }
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

  // Same limiter/key as create+update — defense-in-depth for symmetry. A
  // second delete of an already-tombstoned comment purges nothing, so this
  // vector was already bounded by the create limiter, but sharing the window
  // means delete can't be used to pad a user's remaining PATCH headroom.
  const limited = await enforceRateLimit(env.COMMENT_LIMITER, `comment:${userId}`);
  if (limited !== null) return limited;

  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse("INVALID_INPUT", 400, { fields: ["id"] });

  // Explicit return-type annotation (not just inference): without it, TS's
  // generic inference for withClient<T> across these three differently-shaped
  // return statements widens `outcome.purged` to `string | undefined` instead
  // of a proper discriminated union — invisible before now only because
  // purgeTags' template literal silently coerces `undefined` to a string.
  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (
    c,
  ): Promise<{ purged: string } | { alreadyGone: true } | { notFound: true }> => {
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
  if ("purged" in outcome) {
    await purgeTags(env, [`post:${outcome.purged}`]);
    notifyPostLive(env, ctx, outcome.purged, "comment");
  }
  return json({}); // both fresh-tombstone and already-tombstoned answer 200
}

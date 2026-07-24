/**
 * REACTION TOGGLES — idempotent by construction, both directions:
 * on = INSERT … ON CONFLICT (reactions_target_unique) DO NOTHING; off = an
 * unconditional DELETE of the matching row. NO PURGE on either (spec decision 5):
 * reaction counts live in a client island, never in cached HTML — purging the
 * post page per toggle would be a purge storm against a 5/min zone budget.
 * Removal skips target-state validation on purpose: a user must always be able
 * to retract, even from a since-tombstoned comment.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { hasChosenUsername } from "../db/onboarding";
import { errorResponse } from "../http/errors";
import { notify } from "../notifications/create";

import { REACTION_KINDS, ReactionInput } from "@thinkersjournal/shared";

import type { MyReactions, PublicReactions, ReactionCounts, ReactionKind } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isKind(v: string): v is ReactionKind {
  return (REACTION_KINDS as readonly string[]).includes(v);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleAddReaction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.REACTION_LIMITER, `reaction:${userId}`);
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
  const parsed = ReactionInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["postId", "commentId", "kind"] });
  }
  const { postId, commentId, kind } = parsed.data;
  if (!isKind(kind)) return errorResponse("INVALID_REACTION_KIND", 400);

  let error: Response | null = null;
  try {
    error = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      let recipientId: string | null = null;
      let notifPostId: string | undefined;
      let notifCommentId: string | undefined;
      if (postId !== undefined) {
        const post = await c.query<{ status: string; authorId: string }>(
          `SELECT status, author_id AS "authorId" FROM posts WHERE id = $1`,
          [postId],
        );
        if (post.rows[0]?.status !== "published") return errorResponse("NOT_FOUND", 404);
        recipientId = post.rows[0].authorId;
        notifPostId = postId;
      } else {
        // A comment target must be live AND sit on a published post (draft parity).
        const comment = await c.query<{ deleted: boolean; authorId: string; postId: string }>(
          `SELECT (c.deleted_at IS NOT NULL) AS deleted, c.author_id AS "authorId", c.post_id AS "postId"
             FROM comments c JOIN posts p ON p.id = c.post_id AND p.status = 'published'
            WHERE c.id = $1`,
          [commentId],
        );
        const row = comment.rows[0];
        if (row === undefined) return errorResponse("COMMENT_NOT_FOUND", 404);
        if (row.deleted) return errorResponse("COMMENT_DELETED", 409);
        recipientId = row.authorId;
        notifPostId = row.postId;
        notifCommentId = commentId;
      }

      await c.query(
        `INSERT INTO reactions (user_id, post_id, comment_id, kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT reactions_target_unique DO NOTHING`,
        [userId, postId ?? null, commentId ?? null, kind],
      );

      // Notify the target's author. Dedup on the notification natural key means a
      // repeat same-tone reaction adds nothing; a different tone is a new event.
      if (recipientId !== null) {
        await notify(c, {
          recipientId,
          actorId: userId,
          kind: postId !== undefined ? "post_reaction" : "comment_reaction",
          postId: notifPostId,
          commentId: notifCommentId,
          reactionKind: kind,
        });
      }
      return null;
    });
  } catch (err) {
    // Target deleted between check and insert → FK 23503; same answer as "never there".
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if (error !== null) return error;
  return json({}, 201);
}

export async function handleRemoveReaction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.REACTION_LIMITER, `reaction:${userId}`);
  if (limited !== null) return limited;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "";
  const postId = url.searchParams.get("postId");
  const commentId = url.searchParams.get("commentId");
  if (!isKind(kind)) return errorResponse("INVALID_REACTION_KIND", 400);
  const oneTarget = (postId === null) !== (commentId === null);
  const target = postId ?? commentId ?? "";
  if (!oneTarget || !UUID_RE.test(target)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["postId", "commentId"] });
  }

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    postId !== null
      ? c.query("DELETE FROM reactions WHERE user_id=$1 AND kind=$2 AND post_id=$3", [userId, kind, postId])
      : c.query("DELETE FROM reactions WHERE user_id=$1 AND kind=$2 AND comment_id=$3", [userId, kind, commentId]),
  );
  return json({});
}

function zeroCounts(): ReactionCounts {
  return { insightful: 0, curious: 0, agree: 0, challenging: 0 };
}

/** Shared 404-parity gate for the two reads. Returns true iff postId names a published post. */
async function postIsPublished(env: Env, ctx: ExecutionContext, postId: string): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [postId],
    );
    return rows[0]?.status === "published";
  });
}

export async function handlePublicReactions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const postId = new URL(request.url).searchParams.get("postId") ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("NOT_FOUND", 404);
  if (!(await postIsPublished(env, ctx, postId))) return errorResponse("NOT_FOUND", 404);

  const body = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const post = await c.query<{ kind: ReactionKind; n: number }>(
      "SELECT kind, count(*)::int AS n FROM reactions WHERE post_id = $1 GROUP BY kind",
      [postId],
    );
    const comments = await c.query<{ commentId: string; kind: ReactionKind; n: number }>(
      `SELECT r.comment_id AS "commentId", r.kind, count(*)::int AS n
         FROM reactions r JOIN comments c2 ON c2.id = r.comment_id
        WHERE c2.post_id = $1
        GROUP BY r.comment_id, r.kind`,
      [postId],
    );
    const result: PublicReactions = { post: zeroCounts(), comments: {} };
    for (const row of post.rows) result.post[row.kind] = row.n;
    for (const row of comments.rows) {
      (result.comments[row.commentId] ??= zeroCounts())[row.kind] = row.n;
    }
    return result;
  });
  return json(body);
}

export async function handleMyReactions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const postId = new URL(request.url).searchParams.get("postId") ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("NOT_FOUND", 404);
  if (!(await postIsPublished(env, ctx, postId))) return errorResponse("NOT_FOUND", 404);

  const body = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const post = await c.query<{ kind: ReactionKind }>(
      "SELECT kind FROM reactions WHERE user_id = $1 AND post_id = $2",
      [session.userId, postId],
    );
    const comments = await c.query<{ commentId: string; kind: ReactionKind }>(
      `SELECT r.comment_id AS "commentId", r.kind
         FROM reactions r JOIN comments c2 ON c2.id = r.comment_id
        WHERE r.user_id = $1 AND c2.post_id = $2`,
      [session.userId, postId],
    );
    const result: MyReactions = { post: post.rows.map((r) => r.kind), comments: {} };
    for (const row of comments.rows) (result.comments[row.commentId] ??= []).push(row.kind);
    return result;
  });
  return json(body);
}

/**
 * BLOCK / UNBLOCK — interaction-control between two users. This task only
 * writes/removes the `blocks` row and tears down the relationship's follow
 * state; the ENFORCEMENT (rejecting follow/comment/react, feed filtering,
 * notification suppression) is a later M4 task and lives elsewhere.
 *
 * Idempotent by construction, mirroring follows.ts: the block itself is
 * `INSERT ... ON CONFLICT DO NOTHING` against migration 0012's
 * `blocks_pair_unique`, and the unblock DELETE is keyed by the pair (0 rows
 * affected -> `NOT_BLOCKED`, not a silent success, since unlike follow this
 * is a deliberate moderation action the caller should get real feedback on).
 *
 * A block tears down ANY pre-existing follow edge between the pair, in
 * EITHER direction — blocking someone you follow (or who follows you) must
 * not leave a stale edge enforcement would otherwise have to special-case.
 * Both users' cached followee lists are busted afterward (best-effort, same
 * fail-open reasoning as bustFolloweeCache's own header).
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { bustFolloweeCache } from "../social/followee-cache";

import { BlockInput } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleBlock(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.BLOCK_LIMITER, `block:${userId}`);
  if (limited !== null) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = BlockInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["blockedId"] });
  }
  const { blockedId } = parsed.data;

  if (blockedId === userId) return errorResponse("CANNOT_BLOCK_SELF", 400);

  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      await c.query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
           ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [userId, blockedId],
      );
      // Tear down any pre-existing follow edge between the pair, either
      // direction — a block must not leave a stale follow for later
      // enforcement to special-case.
      await c.query(
        `DELETE FROM follows
           WHERE (follower_id = $1 AND followee_id = $2)
              OR (follower_id = $2 AND followee_id = $1)`,
        [userId, blockedId],
      );
    });
  } catch (err) {
    // blocked_id references a nonexistent user -> FK violation (23503).
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  // Both users' follow graphs changed (the block insert conceptually, and the
  // follow teardown above concretely) — invalidate both cached copies.
  // Best-effort (the 300s TTL backstops a lost delete); never blocks the write.
  ctx.waitUntil(bustFolloweeCache(env, userId));
  ctx.waitUntil(bustFolloweeCache(env, blockedId));
  return new Response(null, { status: 201 });
}

export async function handleUnblock(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const blockedId = params.blockedId ?? "";
  // The router decodes but does not validate the segment's shape — reject a
  // non-uuid before the DB throws 22P02 on it (matches follows.ts's
  // handleUnfollow discipline).
  if (!UUID_RE.test(blockedId)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["blockedId"] });
  }

  const rowCount = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const result = await c.query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [
      userId,
      blockedId,
    ]);
    return result.rowCount ?? 0;
  });
  if (rowCount === 0) return errorResponse("NOT_BLOCKED", 404);

  ctx.waitUntil(bustFolloweeCache(env, userId));
  ctx.waitUntil(bustFolloweeCache(env, blockedId));
  return new Response(null, { status: 204 });
}

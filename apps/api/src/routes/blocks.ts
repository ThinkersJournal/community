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
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
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
  // 200, not 204: this codebase returns 200 for every mutation, DELETEs
  // included (handleUnfollow follows.ts:96, handleDeletePost posts.ts). A lone
  // 204 here would make unblock the one DELETE a uniform client must special-case.
  return new Response(null, { status: 200 });
}

/**
 * GET /blocks/status?id=<uuid>&id=<uuid>… — for the signed-in viewer, which of
 * the given ids they have blocked. Mirrors follows.ts's handleFollowStatus
 * exactly (same GET/no-CSRF/readCurrentSession shape, same bounded id list) —
 * this is what lets a profile page render Block vs. Unblock without a write.
 */
const STATUS_MAX_IDS = 100;

export async function handleBlockStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const ids = new URL(request.url).searchParams
    .getAll("id")
    .filter((id) => UUID_RE.test(id))
    .slice(0, STATUS_MAX_IDS);

  if (ids.length === 0) {
    return new Response(JSON.stringify({ blocked: [], viewerId: session.userId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const blocked = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ blocked_id: string }>(
      `SELECT blocked_id FROM blocks
        WHERE blocker_id = $1 AND blocked_id = ANY($2::uuid[])`,
      [session.userId, ids],
    );
    return rows.map((r) => r.blocked_id);
  });
  return new Response(JSON.stringify({ blocked, viewerId: session.userId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /blocks — every user the signed-in viewer has blocked, most recent
 * first. The only way to reach "unblock" WITHOUT already knowing the blocked
 * user's handle (endpoint/UI audit, 2026-09-24: block without this is a
 * one-way door for anyone who can't find their way back to that profile).
 */
export async function handleListBlocks(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const users = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{
      user_id: string;
      username: string;
      display_name: string | null;
    }>(
      `SELECT p.user_id, p.username, p.display_name
         FROM blocks b
         JOIN profiles p ON p.user_id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC`,
      [session.userId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
    }));
  });
  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

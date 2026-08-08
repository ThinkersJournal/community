/**
 * FOLLOW / UNFOLLOW — the write side of the social graph. Idempotent by
 * construction: the edge is `INSERT ... ON CONFLICT DO NOTHING` and the delete
 * is unconditional, so a double-tap or a retry is never an error. Self-follow is
 * blocked in the app AND by the DB CHECK (defense in depth). The verified-email
 * soft gate and the username-onboarding gate both apply before any write.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isCheckViolation, isForeignKeyViolation } from "../db/errors";
import { hasChosenUsername } from "../db/onboarding";
import { errorResponse } from "../http/errors";
import { notify } from "../notifications/create";
import { bustFolloweeCache } from "../social/followee-cache";

import { FollowInput } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleFollow(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.FOLLOW_LIMITER, `follow:${userId}`);
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
  const parsed = FollowInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["followeeId"] });
  }
  const { followeeId } = parsed.data;

  if (followeeId === userId) return errorResponse("CANNOT_FOLLOW_SELF", 400);

  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      await c.query(
        `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
           ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [userId, followeeId],
      );
      // Notify the followee. Dedup means a follow/unfollow/re-follow loop cannot
      // spam their bell (anti-harassment). self-follow is already rejected above.
      await notify(c, env, ctx, { recipientId: followeeId, actorId: userId, kind: "follow" });
    });
  } catch (err) {
    // followee_id references a nonexistent user → FK violation (23503).
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    // Backstop for the app guard above: zod's uuid regex accepts mixed-case
    // hex and Postgres normalizes case at cast time, so a same-user uuid
    // submitted in a different case slips past `followeeId === userId` and
    // trips the `follows_no_self` CHECK instead (23514).
    if (isCheckViolation(err)) return errorResponse("CANNOT_FOLLOW_SELF", 400);
    throw err;
  }
  // The follower's followee list changed — invalidate their cached copy.
  // Best-effort (the 300s TTL backstops a lost delete); never blocks the write.
  ctx.waitUntil(bustFolloweeCache(env, userId));
  return new Response(null, { status: 201 });
}

export async function handleUnfollow(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const followeeId = params.followeeId ?? "";
  // The router decodes but does not validate the segment's shape — reject a
  // non-uuid before the DB throws 22P02 on it (matches the public-reads cursor
  // discipline).
  if (!UUID_RE.test(followeeId)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["followeeId"] });
  }

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [userId, followeeId]),
  );
  ctx.waitUntil(bustFolloweeCache(env, userId));
  return new Response(null, { status: 200 });
}

/**
 * GET /follows/status?id=<uuid>&id=<uuid>… — for the signed-in viewer, which of
 * the given ids they already follow. A GET (not POST) so it needs no CSRF and is
 * not held to the mutating default-deny; it authenticates via readCurrentSession.
 * Bounded so an over-long query string can't fan out an unbounded IN-list.
 */
const STATUS_MAX_IDS = 100;

export async function handleFollowStatus(
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
    return new Response(JSON.stringify({ following: [], viewerId: session.userId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const following = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ followee_id: string }>(
      `SELECT followee_id FROM follows
        WHERE follower_id = $1 AND followee_id = ANY($2::uuid[])`,
      [session.userId, ids],
    );
    return rows.map((r) => r.followee_id);
  });
  return new Response(JSON.stringify({ following, viewerId: session.userId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * FOLLOW / UNFOLLOW — the write side of the social graph. Idempotent by
 * construction: the edge is `INSERT ... ON CONFLICT DO NOTHING` and the delete
 * is unconditional, so a double-tap or a retry is never an error. Self-follow is
 * blocked in the app AND by the DB CHECK (defense in depth). The verified-email
 * soft gate and the username-onboarding gate both apply before any write.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { errorResponse } from "../http/errors";

import { FollowInput } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** true iff this user has chosen a durable handle (onboarding gate). */
async function hasChosenUsername(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.username_chosen === true;
  });
}

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
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(
        `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
           ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [userId, followeeId],
      ),
    );
  } catch (err) {
    // followee_id references a nonexistent user → FK violation (23503).
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
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
  // The router does not decode/validate the shape — reject a non-uuid before the
  // DB throws 22P02 on it (matches the public-reads cursor discipline).
  if (!UUID_RE.test(followeeId)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["followeeId"] });
  }

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [userId, followeeId]),
  );
  return new Response(null, { status: 200 });
}

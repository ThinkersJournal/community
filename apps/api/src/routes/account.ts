/**
 * Account deletion (board item 59 = Option C): request / cancel / status.
 *
 * ⚠️ REQUESTING DELETION DOES NOT SCRUB ANYTHING AND DOES NOT LOG THE USER
 * OUT. It only stamps `deletion_requested_at`. CireSnave's 30-day grace period
 * must be exercisable: an account that locked itself out at request time
 * would let anyone with a live session deny the real owner the very grace
 * period they are entitled to, for 30 days, with no way back in to cancel.
 * The actual scrub runs later, once the window has passed with no cancel —
 * see src/auth/anonymise-accounts.ts, the daily cron that does it.
 *
 * Idempotent both ways, same discipline as follows.ts/blocks.ts: requesting
 * deletion twice just restamps `deletion_requested_at` to the newer `now()`
 * (harmless — it only pushes the 30-day clock out, never in); cancelling
 * when nothing is pending is a no-op 200, not a 404, since there is no
 * moderation-style "you must already be in the state you're undoing"
 * reasoning here the way there is for unblock.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

export async function handleAccountStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const deletionRequestedAt = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ deletion_requested_at: Date | null }>(
      "SELECT deletion_requested_at FROM users WHERE id = $1",
      [session.userId],
    );
    return rows[0]?.deletion_requested_at ?? null;
  });

  return new Response(
    JSON.stringify({
      deletionRequestedAt: deletionRequestedAt === null ? null : deletionRequestedAt.toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function handleRequestDeletion(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query("UPDATE users SET deletion_requested_at = now() WHERE id = $1", [userId]);
  });

  return new Response(null, { status: 200 });
}

export async function handleCancelDeletion(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  // ⚠️ `AND anonymised_at IS NULL`: once the scrub has already run, there is
  // no "cancel" — the row is anonymised, the handle is on its own 30-day
  // clock toward release, and this must not silently un-scrub anything (it
  // can't; the scrub is one-way by construction, but the guard states that
  // rather than leaving it implied).
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query(
      "UPDATE users SET deletion_requested_at = NULL WHERE id = $1 AND anonymised_at IS NULL",
      [userId],
    );
  });

  return new Response(null, { status: 200 });
}

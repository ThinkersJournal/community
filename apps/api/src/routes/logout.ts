/**
 * `POST /auth/logout` and `POST /auth/logout-all` — end a session (or, for
 * the latter, EVERY session belonging to its user).
 *
 * Both routes run the full mutating pipeline (src/auth/pipeline.ts): origin ->
 * session -> CSRF -> epoch. An attacker must not be able to CSRF a victim into
 * being logged out — and especially not into a global `logout-all` — so both
 * need the same origin+CSRF+epoch protection every other mutating route gets.
 *
 * ⚠️ BOTH OPT OUT of `requireVerifiedEmail`. That gate exists for CONTENT
 * mutation (Task 13); it must never apply here. An unverified user still has
 * a real session and must be able to end it — gating logout on email
 * verification would trap them in a session they have no way to close.
 *
 * `logout-all` ORDERING: bump the epoch BEFORE destroying the caller's own
 * session, and unconditionally (not inside a try/catch that could skip it).
 * This is the fail-safe direction: if `bumpEpoch` succeeds but the
 * subsequent `destroySession` were to throw, every session for this user
 * (including the caller's) is already revoked — the caller's own cookie
 * would simply fail its next epoch check rather than staying valid. The
 * reverse order would risk the opposite: a destroyed local session but a
 * failed bump, leaving every OTHER session (the actual point of "log out
 * everywhere") untouched.
 *
 * ⚠️ THAT ORDERING IS ONLY OBSERVABLE WHEN THE BUMP FAILS — on the success path
 * both orders behave identically, so no ordinary test can distinguish them, and
 * for a while none did (inverting this left the suite passing 9/9). It is now
 * pinned by "leaves the caller's session INTACT if logout-all's epoch bump
 * fails" in test/logout.test.ts, which fault-injects the DO via
 * test/helpers/broken-bump.ts. src/routes/signup.ts's step 5 documents the same
 * revoke-then-mutate rule and is pinned the same way; if you add a third such
 * site, pin it too.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { destroySession } from "../auth/session";

/** Handle `POST /auth/logout`: end only the calling session. */
export async function handleLogout(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx);
  if (result instanceof Response) {
    return result;
  }

  const { cookie } = await destroySession(env, request);
  return new Response(null, { status: 200, headers: { "Set-Cookie": cookie } });
}

/**
 * Handle `POST /auth/logout-all`: revoke EVERY session for this user (bump
 * the security epoch) and end the calling session too.
 */
export async function handleLogoutAll(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx);
  if (result instanceof Response) {
    return result;
  }
  const { session } = result;

  // Bump BEFORE destroying the current session — see the file header.
  await env.USER_SECURITY.getByName(session.userId).bumpEpoch();
  const { cookie } = await destroySession(env, request);

  return new Response(null, { status: 200, headers: { "Set-Cookie": cookie } });
}

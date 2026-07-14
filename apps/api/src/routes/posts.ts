/**
 * Content routes (M1). For Task 13 this file holds ONLY the minimal STUB
 * wiring needed to exercise the soft email-verification gate
 * (`requireVerifiedEmail`, src/auth/pipeline.ts):
 *
 *   POST /posts  — gated: readSession (401 if no session) ->
 *                  requireVerifiedEmail (its 403 if the email is unverified)
 *                  -> stub success. No real post is created yet (YAGNI) —
 *                  that lands in M1.
 *   GET  /posts  — a stub feed, deliberately NOT gated: reads stay open to
 *                  unverified users. No DB read yet either; a real feed
 *                  would use HYPERDRIVE_CACHED, not built here.
 *
 * Task 16 replaces this ad hoc session/gate wiring with the full mutating
 * pipeline (origin -> session -> CSRF -> epoch -> verified-email ->
 * rate-limit -> handler) shared across all content-mutation routes. This
 * stub exists only so `requireVerifiedEmail` has a real route to gate.
 */
import { requireVerifiedEmail } from "../auth/pipeline";
import { readSession } from "../auth/session";

/** The one 401 every content-mutation route returns for a missing session. */
function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

/**
 * Handle `POST /posts` — gated by the soft email-verification requirement.
 * A verified session gets a trivial stub success; real post creation
 * (validation + DB insert) is out of scope for Task 13.
 */
export async function handleCreatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readSession(env, request);
  if (session === null) {
    return unauthorized();
  }

  const gated = await requireVerifiedEmail(env, ctx, session);
  if (gated !== null) {
    return gated;
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Handle `GET /posts` — a stub feed. Deliberately NOT gated by
 * `requireVerifiedEmail`: reads stay open to unverified users per the soft
 * gate's policy. A real feed (M1) would query via `HYPERDRIVE_CACHED`.
 */
export async function handleListPosts(): Promise<Response> {
  return new Response(JSON.stringify({ posts: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Content routes (M1). This file still holds only STUB handlers — no real post
 * is created or read yet (YAGNI; that lands in M1) — but the AUTH around them
 * is real:
 *
 *   POST /posts  — runs the full mutating pipeline (src/auth/pipeline.ts):
 *                  origin -> session -> CSRF -> epoch -> verified-email ->
 *                  handler. Opts INTO `requireVerifiedEmail` because creating
 *                  a post is content mutation, which the soft gate (Task 13)
 *                  reserves for verified users. It does NOT opt into rate
 *                  limiting: M0 has no posts limiter binding, and inventing
 *                  one here is out of scope.
 *   GET  /posts  — a stub feed, deliberately NOT gated and NOT run through the
 *                  pipeline: reads stay open to unverified (and anonymous)
 *                  users, so there is no session to require. No DB read yet
 *                  either; a real feed would use HYPERDRIVE_CACHED.
 */
import { runMutatingPipeline } from "../auth/pipeline";

/**
 * Handle `POST /posts`. Every auth check lives in the pipeline — this handler
 * only ever runs for a request that is same-origin, authenticated, CSRF-valid,
 * unrevoked, and email-verified, and it receives that validated session rather
 * than re-reading one.
 */
export async function handleCreatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, {
    requireVerifiedEmail: true,
  });
  if (result instanceof Response) {
    return result;
  }

  // The stub success. `authorId` comes from the PIPELINE's validated session —
  // never from the request body, which a caller controls: this is the shape a
  // real M1 insert would take (`INSERT ... (author_id) VALUES (session.userId)`).
  return new Response(
    JSON.stringify({ ok: true, authorId: result.session.userId }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

/**
 * Handle `GET /posts` — a stub feed. Deliberately open: reads stay available
 * to unverified and anonymous users per the soft gate's policy, so this route
 * intentionally has no session, CSRF, or epoch requirement. A real feed (M1)
 * would query via `HYPERDRIVE_CACHED`.
 */
export async function handleListPosts(): Promise<Response> {
  return new Response(JSON.stringify({ posts: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

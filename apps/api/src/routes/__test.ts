/**
 * TEST-ONLY routes, gated on the `TEST_ROUTES` var.
 *
 * ⚠️ SECURITY — READ BEFORE TOUCHING THIS FILE ⚠️
 *
 * `GET /__test/last-verify-token` returns the last RAW verification token
 * issued by this Worker. That token verifies an arbitrary account, so if this
 * route ever answered in production it would be a full account-takeover vector.
 *
 * Three layers keep that from happening:
 *   1. `TEST_ROUTES` is set ONLY in the gitignored `.dev.vars` (local dev) and
 *      in `miniflare.bindings` in vitest.config.ts (tests). It is deliberately
 *      NOT in wrangler.jsonc's `vars`, so a deploy cannot carry it along.
 *   2. This handler refuses to match at all unless `env.TEST_ROUTES` is truthy,
 *      returning `null` so the caller falls through to its ordinary 404 —
 *      making the route byte-for-byte indistinguishable from a path that does
 *      not exist. It does not 403, which would confirm the route exists.
 *   3. `createVerificationToken` only writes the stash when `TEST_ROUTES` is
 *      set, so in production the KV key this route reads never exists anyway.
 *
 * test/email-verify.test.ts covers both states, including the unset-TEST_ROUTES
 * 404.
 */
import { TEST_LAST_TOKEN_KEY } from "../auth/email-verify";

/**
 * Handle a `/__test/*` request, or return `null` to mean "no such route" —
 * either because `TEST_ROUTES` is unset (production) or because the path is not
 * one of the test routes. The caller MUST treat `null` as its normal 404.
 */
export async function handleTestRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  // THE GATE. Unset TEST_ROUTES ⇒ these routes do not exist.
  if (!env.TEST_ROUTES) {
    return null;
  }

  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/__test/last-verify-token") {
    const token = await env.SESSIONS.get(TEST_LAST_TOKEN_KEY);
    if (token === null) {
      return new Response("No verification token has been issued", {
        status: 404,
      });
    }
    return new Response(token, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  return null;
}

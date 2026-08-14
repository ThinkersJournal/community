/**
 * TEST-ONLY routes, gated on the `TEST_ROUTES` var.
 *
 * ⚠️ SECURITY — READ BEFORE TOUCHING THIS FILE ⚠️
 *
 * `GET /__test/last-verify-token` returns the last RAW verification token
 * issued by this Worker. That token verifies an arbitrary account, so if this
 * route ever answered in production it would be a full account-takeover vector.
 *
 * `POST /__test/reap-unverified` (handle-at-signup Task 8) invokes the daily
 * unverified-account reaper (src/auth/reap-unverified.ts) on demand and
 * returns how many rows it deleted — a test seam for exercising a cron-only
 * code path from an ordinary HTTP request. Lower blast radius than the token
 * route (it only deletes accounts that are ALREADY 7+ days unverified), but
 * it is still an unthrottled DELETE trigger and gets the same gate.
 *
 * `POST /__test/reap-orphan-media` (content-deletion + media-reclamation,
 * Task 4) is the same test seam for the daily orphan-media reclaimer
 * (src/media/reap-orphan-media.ts) — invokes it on demand and returns
 * `{ rows, objects }`. Same blast-radius reasoning as reap-unverified above
 * (it only frees `media` rows that are ALREADY unreferenced and past their
 * 24h grace window), and the same gate.
 *
 * Three layers keep all three from reaching production:
 *   1. `TEST_ROUTES` is set ONLY in the gitignored `.dev.vars` (local dev) and
 *      in `miniflare.bindings` in vitest.config.ts (tests). It is deliberately
 *      NOT in wrangler.jsonc's `vars`, so a deploy cannot carry it along.
 *   2. This handler refuses to match at all unless `env.TEST_ROUTES` is exactly
 *      `"1"`, returning `null` so the caller falls through to its ordinary 404 —
 *      making the route byte-for-byte indistinguishable from a path that does
 *      not exist. It does not 403, which would confirm the route exists.
 *   3. `createVerificationToken` only writes the stash under the same `=== "1"`
 *      condition, so in production the KV key the token route reads never
 *      exists.
 *
 * test/email-verify.test.ts covers both states for the token route, including
 * the unset-TEST_ROUTES 404. `POST /__test/reap-unverified` and `POST
 * /__test/reap-orphan-media` additionally run `checkOrigin` inline (same as
 * signup/login — see src/auth/csrf.ts) so each carries the SAME default-deny
 * shape as every other mutating route in src/routes.ts, even though
 * `TEST_ROUTES` already makes it unreachable outside dev/test.
 */
import { checkOrigin } from "../auth/csrf";
import { TEST_LAST_TOKEN_KEY } from "../auth/email-verify";
import { reapUnverifiedAccounts } from "../auth/reap-unverified";
import { errorResponse, notFoundResponse } from "../http/errors";
import { reapOrphanMedia } from "../media/reap-orphan-media";

/**
 * Handle a `/__test/*` request, or return `null` to mean "no such route" —
 * either because `TEST_ROUTES` is unset (production) or because the path is not
 * one of the test routes. The caller MUST treat `null` as its normal 404.
 */
export async function handleTestRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // THE GATE. Anything other than exactly "1" ⇒ these routes do not exist.
  //
  // An EXPLICIT allowlist, NOT a truthiness check: wrangler vars are always
  // strings, so `TEST_ROUTES="0"` and `TEST_ROUTES="false"` are both TRUTHY —
  // someone setting "0" to mean "off" would have switched this token-exposure
  // route ON. Given the blast radius (full account takeover), the only value
  // that enables these routes is the literal "1". Fail closed on everything
  // else. Keep this identical to the stash gate in auth/email-verify.ts.
  if (env.TEST_ROUTES !== "1") {
    return null;
  }

  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/__test/last-verify-token") {
    const token = await env.SESSIONS.get(TEST_LAST_TOKEN_KEY);
    if (token === null) {
      return notFoundResponse();
    }
    return new Response(token, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // A mutating (POST) test seam, so it carries the same inline origin check
  // every other pipeline-exempt mutating route does (see src/routes.ts's
  // PIPELINE_EXEMPT and test/route-protection.test.ts) — TEST_ROUTES already
  // makes this unreachable in production, but there is no reason to make it
  // the one mutating route in this codebase with no CSRF defense at all.
  if (request.method === "POST" && pathname === "/__test/reap-unverified") {
    if (!checkOrigin(env, request)) {
      return errorResponse("FORBIDDEN", 403);
    }
    const reaped = await reapUnverifiedAccounts(env, ctx);
    return new Response(JSON.stringify({ reaped }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Same test-seam shape as reap-unverified above, for the daily orphan-media
  // reclaimer (content-deletion + media-reclamation, Task 4). See
  // src/media/reap-orphan-media.ts.
  if (request.method === "POST" && pathname === "/__test/reap-orphan-media") {
    if (!checkOrigin(env, request)) {
      return errorResponse("FORBIDDEN", 403);
    }
    const result = await reapOrphanMedia(env, ctx);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return null;
}

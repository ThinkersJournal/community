/**
 * The MUTATING-REQUEST PIPELINE (M0, Task 16) — the one composition every
 * non-GET, session-bearing route runs before its handler sees a request, plus
 * the soft email-verification gate it grew out of (Task 13).
 *
 * `runMutatingPipeline` is the entry point; `requireVerifiedEmail` remains
 * exported as its own step (Task 13's tests pin it directly).
 *
 * ⚠️ GET/HEAD DO NOT BELONG IN `runMutatingPipeline`. It requires a session and
 * would 401 every anonymous read; anonymous reads stay open
 * (src/routes/public.ts). A GET that needs a session uses `readCurrentSession`
 * below — the session+epoch half, without the Origin/CSRF steps that pass
 * GET/HEAD by design. `GET /verify-email` still does its own inline, because its
 * steps interleave (see that file).
 *
 * ⚠️ NEITHER DO SIGNUP/LOGIN. See `runMutatingPipeline`'s own note.
 */
import { checkCsrf, checkOrigin } from "./csrf";
import { enforceRateLimit } from "./ratelimit";
import { destroySession, readSession } from "./session";
import { errorResponse } from "../http/errors";
import { withClient } from "../db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * The exact 403 response for an unverified session. The `code` value is
 * load-bearing — the web app keys off this exact string to show its
 * "verify your email" prompt, so it must not be renamed or reworded.
 */
function emailNotVerifiedResponse(): Response {
  return errorResponse("EMAIL_NOT_VERIFIED", 403);
}

/**
 * Gate for content-mutation routes. Resolves `null` ("allowed, proceed")
 * when `session`'s user has a verified email (`users.email_verified_at IS
 * NOT NULL`), or the 403 `Response` above otherwise — including when the
 * user row is somehow missing, which fails closed rather than throwing.
 *
 * Signature note: the task brief describes this as `(env, session)`, but the
 * DB read requires an `ExecutionContext` to satisfy `withClient`'s 3-arg
 * signature (`ctx.waitUntil(client.end())` — the same reconciliation Task 6
 * made for every other DB-touching helper in this Worker). `ctx` is threaded
 * as the second parameter here.
 *
 * Reads via `HYPERDRIVE_FRESH` (cache-disabled) — NEVER `HYPERDRIVE_CACHED`.
 * Hyperdrive never invalidates on write, so a cached read here would keep
 * denying (or granting) access based on a stale `email_verified_at` for up
 * to 60s after `GET /verify-email` runs — a real security bug.
 *
 * ⚠️ RESIDUAL RISK (issue #35, not fixed here): design spec
 * `2026-09-06-m4-moderation-queue-design.md:174` binds BOTH login and this
 * mutating pipeline to refuse a barred user. This branch does login only —
 * the pipeline half is deliberately out of scope, a later module's work.
 * The intended cover in the meantime is `security_epoch`: bumping it kills
 * every live session. But nothing bumps it today — the only way to SET
 * `disabled_at`/`suspended_until`/`disabled_reason` right now is a human
 * running raw SQL, and that human will not also bump an epoch. So a
 * manually-disabled user is barred from RE-ENTRY (login refuses them) but
 * keeps acting on whatever session they already hold, indefinitely, until it
 * expires on its own. This `SELECT` already reads `users` by `session.userId`
 * on every mutating request — widening it to also select
 * `suspended_until`/`disabled_at` and refusing here is the near-free place to
 * close this gap.
 *
 * ⚠️ TRACKED AS ISSUE #50, which carries the fix and its acceptance criteria.
 * This paragraph used to end "when that work is scheduled" — and nothing
 * scheduled it. A deferral written only in a code comment has no scheduler:
 * it is visible to whoever next opens this function and to no board, no
 * tracker and no query. If #50 is closed without this SELECT widening, this
 * comment is wrong and should be deleted, not left standing.
 */
export async function requireVerifiedEmail(
  env: Env,
  ctx: ExecutionContext,
  session: SessionData,
): Promise<Response | null> {
  const verifiedAt = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email_verified_at: Date | null }>(
      "SELECT email_verified_at FROM users WHERE id = $1",
      [session.userId],
    );
    return rows[0]?.email_verified_at ?? null;
  });

  return verifiedAt === null ? emailNotVerifiedResponse() : null;
}

/** The generic 403 for a rejected origin or a failed CSRF token. */
function forbidden(): Response {
  return errorResponse("FORBIDDEN", 403);
}

/**
 * The generic 401 for "no usable session". `extraHeaders` carries the cleared
 * cookie on the revocation path.
 *
 * ⚠️ Byte-identical across "no session at all" and "revoked session" — the two
 * are deliberately indistinguishable to the client. The web app's handling is
 * the same either way (send the user to log in), so distinguishing them would
 * only tell a caller holding a stolen-but-revoked cookie that it was once real.
 *
 * ⚠️ `Record<string, string>`, DELIBERATELY NARROWER THAN `HeadersInit`. This
 * parameter is SPREAD into the headers object below, and spreading is only
 * meaningful for a plain object: spreading a `Headers` INSTANCE yields `{}`
 * (its entries live behind an iterator, not on own enumerable properties) and
 * spreading a `string[][]` yields index keys (`{"0": [...]}`). Both are valid
 * `HeadersInit`, both type-check, and both would SILENTLY DROP the revocation
 * path's `Set-Cookie` — leaving the browser replaying a dead session token with
 * no error anywhere. The narrower type makes those two shapes unrepresentable
 * rather than merely unused.
 */
function unauthorized(extraHeaders: Record<string, string> = {}): Response {
  return errorResponse("UNAUTHORIZED", 401, { headers: extraHeaders });
}

/**
 * The GET-side counterpart to `runMutatingPipeline`: resolve an authenticated,
 * UNREVOKED session, or the `Response` to return verbatim.
 *
 * No Origin and no CSRF check — `checkOrigin`/`checkCsrf` pass GET/HEAD by
 * design (src/auth/csrf.ts), so running them here would be theatre. What a
 * session-bearing GET DOES owe is the epoch check: `readSession` ALONE IS NOT
 * ENOUGH, even on a route that mutates nothing. A session's KV record OUTLIVES
 * revocation — bumping a user's epoch (re-signup, "log out everywhere")
 * invalidates every outstanding session WITHOUT enumerating them, which is
 * exactly what makes revocation O(1). So a revoked-but-still-in-KV session
 * resolves through `readSession` perfectly well.
 *
 * Without the epoch check, such a session gets a 200 while a garbage cookie gets
 * a 401 — reintroducing precisely the oracle `runMutatingPipeline` goes out of
 * its way to suppress (it makes "no session" and "revoked session"
 * indistinguishable), and leaving the dead cookie in the browser to be replayed.
 *
 * `onFailure` is the CALLER's response factory rather than a fixed body: the
 * post routes answer LOGIN_REQUIRED and the pipeline answers UNAUTHORIZED, and
 * both are wire contracts the web app branches on. Passing it in is what lets
 * this be one implementation instead of a third hand-rolled copy of the same
 * two steps.
 *
 * ⚠️ `GET /verify-email` deliberately does NOT use this: it must resolve the
 * token's owner BETWEEN the session read and the epoch check (the token is what
 * says who is being verified), so its steps are interleaved rather than
 * sequential. See that file's header.
 *
 * ⚠️ `Record<string, string>` on `onFailure`, deliberately narrower than
 * `HeadersInit` — see `unauthorized` above for why the distinction silently
 * drops a `Set-Cookie`.
 */
export async function readCurrentSession(
  env: Env,
  request: Request,
  onFailure: (extraHeaders?: Record<string, string>) => Response,
): Promise<SessionData | Response> {
  const session = await readSession(env, request);
  if (session === null) return onFailure();

  const currentEpoch = await env.USER_SECURITY.getByName(session.userId).getEpoch();
  if (currentEpoch !== session.securityEpoch) {
    // Destroy rather than merely reject: the KV record is dead server-side from
    // here, and the cleared cookie (`Max-Age=0`) stops the browser replaying a
    // token that can never succeed again.
    const { cookie } = await destroySession(env, request);
    return onFailure({ "Set-Cookie": cookie });
  }
  return session;
}

/** Per-route opt-ins for `runMutatingPipeline`. Everything here is OPTIONAL. */
export interface MutatingPipelineOptions {
  /**
   * Opt a CONTENT-mutation route into the soft email-verification gate
   * (step 5). Auth routes (logout) leave this off: an unverified user must
   * still be able to end their session.
   */
  requireVerifiedEmail?: boolean;
  /**
   * Opt a SENSITIVE route into rate limiting (step 6). Modelled as one object
   * rather than the brief's separate `limiter`/`limiterKey` parameters so the
   * two cannot be supplied independently — a limiter with no key (or a key
   * with no limiter) is not a state a caller can reach, rather than one that
   * silently skips the limit at runtime.
   */
  rateLimit?: { limiter: RateLimit; key: string };
}

/**
 * The security spine for every non-GET, session-bearing route. Resolves EITHER
 * a short-circuit `Response` the caller must return verbatim, OR the validated
 * `session` to hand the handler:
 *
 *   const result = await runMutatingPipeline(request, env, ctx, opts);
 *   if (result instanceof Response) return result;
 *   // result.session is authenticated, unrevoked, and CSRF-checked.
 *
 * ⚠️ THE ORDER BELOW IS LOAD-BEARING — do not reorder:
 *
 *   1. checkOrigin       -> 403. FIRST: the cheapest check, and it must run
 *                           before any KV/DO/DB touch so a cross-site request
 *                           cannot make us spend I/O (or probe timing) at all.
 *   2. readSession       -> 401 if absent. Everything below needs a session.
 *   3. checkCsrf         -> 403. Needs the session (the token is derived from
 *                           its `csrfSecret`), so it cannot precede step 2 —
 *                           but it comes before the epoch/DB reads below so a
 *                           forged cross-site request stops at the cheapest
 *                           point that can still reject it.
 *   4. checkSecurityEpoch-> 401 + cleared cookie. Before ANY authorization
 *                           decision: a revoked session must not be able to
 *                           act, so nothing downstream may run for one.
 *   5. requireVerifiedEmail (opt-in) -> its 403. Authorization, and the first
 *                           step that touches Postgres — deliberately last
 *                           among the checks, behind every cheaper rejection.
 *   6. rate limit (opt-in) -> its 429. Last: quota is spent only by a request
 *                           that is otherwise fully entitled to proceed, so
 *                           unauthenticated noise cannot burn a real user's
 *                           budget.
 *   7. hand the validated session to the handler.
 *
 * ⚠️ `POST /auth/signup` and `POST /auth/login` MUST NOT ROUTE THROUGH THIS.
 * They are how a session comes to EXIST, so they have none at request time:
 * step 2 would 401 every signup and login outright, and steps 3-4 have no
 * `csrfSecret` and no user to read an epoch for. Those two routes run their
 * own `checkOrigin` (the only step that applies pre-session) inline, along
 * with their own rate limiting and Turnstile. `POST /auth/logout` (Task 17)
 * DOES belong here — it has a session — but WITHOUT `requireVerifiedEmail`.
 */
export async function runMutatingPipeline(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  opts: MutatingPipelineOptions = {},
): Promise<Response | { session: SessionData }> {
  // ---- 1. Origin — before any I/O -----------------------------------------
  if (!checkOrigin(env, request)) {
    return forbidden();
  }

  // ---- 2. Session -----------------------------------------------------------
  const session = await readSession(env, request);
  if (session === null) {
    return unauthorized();
  }

  // ---- 3. CSRF double-submit token -----------------------------------------
  if (!(await checkCsrf(request, session))) {
    return forbidden();
  }

  // ---- 4. Security epoch (revocation) --------------------------------------
  // The session's `securityEpoch` was stamped when it was issued. If the
  // user's CURRENT epoch has moved (re-signup taking the account over, and
  // later: password change / "log out everywhere"), this session predates that
  // event and is revoked — regardless of its KV record still being live. This
  // is what makes revocation O(1): one DO counter invalidates every
  // outstanding session for a user without enumerating any of them.
  //
  // Read fresh from the DO on EVERY mutating request, never cached: a
  // revocation that took effect a cache-TTL later would be exactly the window
  // an attacker with a stolen cookie needs.
  const currentEpoch = await env.USER_SECURITY.getByName(
    session.userId,
  ).getEpoch();
  if (currentEpoch !== session.securityEpoch) {
    // Destroy it rather than merely rejecting it: the KV record is dead
    // server-side from here on, and the cleared cookie (`Max-Age=0`) stops the
    // browser replaying a token that can never succeed again.
    const { cookie } = await destroySession(env, request);
    return unauthorized({ "Set-Cookie": cookie });
  }

  // ---- 5. Verified email (content routes only) ------------------------------
  if (opts.requireVerifiedEmail === true) {
    const gated = await requireVerifiedEmail(env, ctx, session);
    if (gated !== null) {
      return gated;
    }
  }

  // ---- 6. Rate limit (sensitive routes only) --------------------------------
  if (opts.rateLimit !== undefined) {
    const limited = await enforceRateLimit(
      opts.rateLimit.limiter,
      opts.rateLimit.key,
    );
    if (limited !== null) {
      return limited;
    }
  }

  // ---- 7. Hand off to the handler -------------------------------------------
  return { session };
}

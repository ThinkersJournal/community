/**
 * `GET /verify-email?token=…` — redeem an emailed verification token and mark
 * the user's address as verified.
 *
 * ⚠️ THIS ROUTE REQUIRES AUTHENTICATION. Verification must prove knowledge of
 * the account's CURRENT password, not merely possession of a link that was
 * emailed at some point in the past. Holding the link is NOT enough.
 *
 * WHY (the account-takeover chain this closes):
 *   1. A victim signs up   -> user row U with the victim's password, unverified;
 *                             token T1 is emailed to the victim.
 *   2. An attacker re-signs-up the same address. That address is still
 *      UNVERIFIED, so it has no proven owner and signup legitimately takes it
 *      over (src/routes/signup.ts): U's password_hash becomes the ATTACKER's,
 *      and T2 is emailed to the victim.
 *   3. The victim clicks T1 — the email they were expecting.
 *
 * If step 3 verified U unconditionally, the victim's own click would promote an
 * account holding the ATTACKER's password to VERIFIED: the attacker owns a
 * verified account and the victim is locked out. Epoch-stamping the tokens does
 * not help — T2 is mailed to the victim too and stays live.
 *
 * The fix is to make verification require a session that proves the CURRENT
 * password, which re-signup invalidates by bumping the security epoch. Three
 * checks, all load-bearing:
 *   1. A session must exist.
 *   2. It must belong to the token's OWN user.
 *   3. It must NOT be stale (`securityEpoch` still matches the user's DO).
 *
 * ⚠️ CHECK 3 IS WHAT MAKES THIS WORK. Without it the victim's pre-takeover
 * session S1 — issued at step 1, still valid, still for U — satisfies checks 1
 * and 2 by itself, and the takeover above stands unchanged. It is the epoch bump
 * on re-signup (step 6 of src/routes/signup.ts) plus this check that together
 * force whoever verifies to have authenticated with the password U holds NOW.
 * test/signup.test.ts pins the whole chain; do not weaken either half.
 */
import {
  deleteVerificationToken,
  peekVerificationToken,
} from "../auth/email-verify";
import { readSession } from "../auth/session";
import { withClient } from "../db/client";

/**
 * The single failure response for EVERY unhappy TOKEN path: a missing token, an
 * unknown token, an expired token, and an already-used token all return this
 * exact response. Deliberately generic — distinguishing "expired" from "never
 * existed" would confirm to an attacker that a guessed token was once real.
 */
function invalidToken(): Response {
  return new Response("Invalid or expired verification link", { status: 400 });
}

/**
 * The single failure response for EVERY unhappy AUTH path: no session, a session
 * for a different user, and a stale session all return this same generic body.
 * The `code` value is load-bearing — the web app keys off this exact string to
 * show a login prompt and re-follow the link afterwards (Task 18) — so it must
 * not be renamed or reworded.
 *
 * ⚠️ The body is IDENTICAL across all three cases on purpose: a distinct
 * "that token isn't yours" would let an attacker probe whose token they hold.
 * The status differs (401 = authenticate, 403 = authenticated but not permitted)
 * only to keep normal HTTP semantics for the client.
 *
 * ⚠️ BE HONEST ABOUT WHAT THE STATUS LEAKS. The identical body does NOT make this
 * a non-oracle — the STATUS ITSELF is one. An authenticated caller submitting a
 * guessed token learns, from the code alone, which of two worlds they are in:
 * 403 means the token is REAL but belongs to someone else, while 400
 * (`invalidToken`) means no such token exists. That distinction is exactly what a
 * probe wants. It is unexploitable for ONE reason only: tokens are 256 bits of
 * CSPRNG output (src/auth/email-verify.ts), so an attacker never gets a hit to
 * read the oracle's answer about. The defense is the ENTROPY, not the response
 * shape. If token generation is ever weakened — shorter, derived, sequential,
 * user-influenced — this split becomes a live enumeration primitive and the two
 * paths must collapse to one status. Do not cite the matching bodies as the
 * reason this is safe.
 */
function loginRequired(status: 401 | 403): Response {
  return new Response(JSON.stringify({ code: "LOGIN_REQUIRED" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Handle `GET /verify-email`. Authenticates the caller (see the file header),
 * then consumes the token and stamps `email_verified_at`.
 *
 * The UPDATE goes through `HYPERDRIVE_FRESH` (cache-disabled): Hyperdrive never
 * invalidates on write, so any verify/auth path touching `HYPERDRIVE_CACHED`
 * would be a real security bug.
 */
export async function handleVerifyEmail(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (token === null || token === "") {
    return invalidToken();
  }

  // ---- 1. A session must exist --------------------------------------------
  // Checked BEFORE the token is even looked up, so an unauthenticated caller
  // cannot use this endpoint to probe whether a guessed token is real.
  const session = await readSession(env, request);
  if (session === null) {
    return loginRequired(401);
  }

  // ---- 2. The token must belong to the session's user ----------------------
  // PEEK, never consume: the token must survive every rejection below. A
  // legitimate user who clicks the link before signing in gets a 401, logs in,
  // and clicks the SAME link again — burning it here would strand them with no
  // way to verify (there is no resend endpoint until M1).
  const tokenUserId = await peekVerificationToken(env, token);
  if (tokenUserId === null) {
    return invalidToken();
  }

  if (session.userId !== tokenUserId) {
    return loginRequired(403);
  }

  // ---- 3. The session must not be stale ------------------------------------
  // ⚠️ LOAD-BEARING — see the file header. A session issued before the user's
  // last `bumpEpoch()` (re-signup taking the account over, and later: password
  // change / "log out everywhere") proves knowledge of a password that is no
  // longer current, so it must not be able to verify.
  const currentEpoch = await env.USER_SECURITY.getByName(
    session.userId,
  ).getEpoch();
  if (currentEpoch !== session.securityEpoch) {
    return loginRequired(401);
  }

  // ---- 4. Redeem ------------------------------------------------------------
  // Only NOW is the token burned: every rejection above left it intact, and this
  // is the one path that actually verifies, so it stays one-time on success.
  await deleteVerificationToken(env, token);

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [
      tokenUserId,
    ]),
  );

  return new Response("Email verified", { status: 200 });
}

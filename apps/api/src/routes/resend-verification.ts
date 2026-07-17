/**
 * `POST /auth/resend-verification` — mint and mail a fresh verification token.
 *
 * ⚠️ WHY THIS EXISTS NOW. M1 makes a verified email a HARD REQUIREMENT for
 * posting, and Postmark sends fail SILENTLY BY DESIGN (src/auth/email-verify.ts
 * never throws, so a mail outage cannot 500 a signup). Without this route, one
 * dropped email is a permanently unusable account whose only recovery is
 * re-signup — which works, but is not a flow anyone will find.
 *
 * ⚠️ SESSION-REQUIRED, NOT EMAIL-IN-THE-BODY, AND THIS IS THE WHOLE DESIGN.
 * A `{ email }` endpoint would be (a) a mail-bombing gun aimed at any address an
 * attacker names — from OUR confirmed sender, i.e. our deliverability
 * reputation — and (b) an enumeration oracle if it answered differently for a
 * registered address. Requiring the session means the only address anyone can
 * trigger mail to is the one on the account they already hold, which is exactly
 * the address that already received one.
 *
 * ⚠️ UNVERIFIED-ONLY. A verified account has nothing to verify, so a 409 is the
 * honest answer and it leaks nothing: the caller already IS that account.
 *
 * ⚠️ THE OLD TOKEN IS NOT BURNED. "Resend" is pressed most often because the
 * first mail was SLOW, not lost — invalidating it would break the link the user
 * is about to click. Both tokens stay live until their own 24h TTL, and each is
 * independently one-time. That is safe because possessing a token is not
 * sufficient to verify: GET /verify-email also requires an authenticated,
 * epoch-current session for the token's OWN user (see its header).
 */
import { runMutatingPipeline } from "../auth/pipeline";
import {
  createVerificationToken,
  sendVerificationEmail,
  verificationLinkOrigin,
} from "../auth/email-verify";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

export async function handleResendVerification(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Origin -> session -> CSRF -> epoch. Deliberately NOT `requireVerifiedEmail`:
  // this route is FOR the unverified, so the gate would reject exactly its users.
  const result = await runMutatingPipeline(request, env, ctx);
  if (result instanceof Response) return result;
  const { userId } = result.session;

  // ---- Rate limit — after auth, per the pipeline's rule -------------------
  // Keyed on the SESSION's user: the only identity that can trigger mail here,
  // and one an attacker cannot rotate the way they can an IP. This is a MAIL
  // SEND, so the ceiling is tighter than the auth routes' (3/60s).
  const limited = await enforceRateLimit(env.RESEND_LIMITER, `resend:${userId}`);
  if (limited !== null) return limited;

  // FRESH: a permission read, and a read-after-write against GET /verify-email.
  const user = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email: string; email_verified_at: Date | null }>(
      "SELECT email, email_verified_at FROM users WHERE id = $1",
      [userId],
    );
    return rows[0] ?? null;
  });
  // A session for a user row that no longer exists: fail closed.
  if (user === null) return errorResponse("UNAUTHORIZED", 401);
  if (user.email_verified_at !== null) return errorResponse("ALREADY_VERIFIED", 409);

  const token = await createVerificationToken(env, userId);
  // ⚠️ THE SAME `verificationLinkOrigin` SIGNUP USES — one function, one rule.
  // It keeps a `www.` user on `www.` and falls back to the apex for everything
  // else, and it is NEVER `new URL(request.url).origin` (Host-derived, i.e. a
  // link to an attacker's host mailed from OUR confirmed sender). This route
  // first shipped with a private `CANONICAL_ORIGIN` copy that matched signup's
  // security property but not its behaviour — always mailing an apex link. See
  // the function's own header in src/auth/email-verify.ts.
  const verifyUrl = `${verificationLinkOrigin(request)}/verify-email?token=${encodeURIComponent(token)}`;
  // NEVER throws (src/auth/email-verify.ts) — a Postmark outage must not 500 a
  // request whose whole purpose is to work around a Postmark outage.
  await sendVerificationEmail(env, user.email, verifyUrl);

  // 202, not 200: the send is best-effort by construction, and claiming 200
  // would assert a delivery we deliberately do not verify.
  return new Response(null, { status: 202 });
}

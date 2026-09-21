/**
 * `POST /auth/forgot-password` — request a password-reset link (#70).
 *
 * ⚠️ ORIGIN CHECK RUNS BEFORE PARSING/VALIDATION, UNLIKE SIGNUP/LOGIN. Those
 * two validate first ("reject garbage before spending any quota") because
 * `test/route-protection.test.ts`'s shared `probeBody()` was built to satisfy
 * both their schemas, so validation-then-origin still lets an origin-less
 * probe reach (and fail at) the origin check. This route's schema
 * (`ForgotPasswordInput`: email + turnstileToken) happens to also accept that
 * shared probe body — but `reset-password.ts`'s does not (it needs `token`),
 * and that route's "no Origin -> 403" test would otherwise 400 at validation
 * first and never exercise the origin check at all. Both new routes put
 * `checkOrigin` first for the SAME reason and to stay consistent with each
 * other, even though it costs this route nothing either way.
 *
 * ⚠️ MUST NOT LEAK WHETHER AN ADDRESS IS REGISTERED. Two defenses, both
 * required — same shape as `login.ts`'s "NO USER ENUMERATION" note, which
 * this route models directly:
 *
 *   (a) BODY/STATUS: this route ALWAYS answers 202 with an empty body,
 *       whether the address is registered or not. There is no
 *       distinguishing error for "no such account" — same style as
 *       resend-verification's UNVERIFIED-only 409, except here even a 409
 *       would leak, so there is no such branch at all.
 *   (b) TIMING: a byte-identical body is not sufficient alone (see
 *       `login.ts`'s DUMMY_HASH comment for why). The dominant asymmetric
 *       cost here is the Postmark HTTP call on the found path — network
 *       latency, not a fixed CPU cost like Argon2id, so it cannot be
 *       equalized with a dummy call the way login equalizes a hash. Instead
 *       it is dispatched via `ctx.waitUntil` rather than awaited on the
 *       response path, so it costs the RESPONSE nothing at all on either
 *       path. The residual gap is the found path's one extra `INSERT` into
 *       `password_reset_tokens` (a few ms, DB-timing noise) versus the
 *       not-found path's bare `SELECT` — smaller and noisier than a network
 *       round trip, and honestly a residual rather than a claim of perfect
 *       closure (same honesty as `ratelimit.ts`'s "not an exact counter").
 *
 * Rate limiting is the signup/login TWO-BUCKET shape (ip:email, email:), NOT
 * resend-verification's single session-keyed bucket — this route has no
 * session (it exists precisely for someone who cannot authenticate), so it
 * cannot reuse resend-verification's "the only address anyone can trigger
 * mail to is the one on the account they hold" structural defense. See
 * `login.ts`'s rate-limit comment for why BOTH buckets are required.
 */
import { ForgotPasswordInput } from "@thinkersjournal/shared";

import { verificationLinkOrigin } from "../auth/email-verify";
import { checkOrigin } from "../auth/csrf";
import { createResetToken, sendPasswordResetEmail } from "../auth/password-reset";
import { enforceRateLimit } from "../auth/ratelimit";
import { verifyTurnstile } from "../auth/turnstile";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

/** The one 202 this route ever answers, on every reachable path. */
function accepted(): Response {
  return new Response(null, { status: 202 });
}

export async function handleForgotPassword(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---- 1. Origin (CSRF) — before ANY parsing, see the file header ----------
  if (!checkOrigin(env, request)) {
    return errorResponse("FORBIDDEN", 403);
  }

  // ---- 2. Parse + validate --------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = ForgotPasswordInput.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }
  const { email, turnstileToken } = parsed.data;

  // ---- 3. Rate limit — two buckets, same reasoning as signup/login ----------
  const clientIp = request.headers.get("CF-Connecting-IP");
  const ipLimited = await enforceRateLimit(
    env.RESET_LIMITER,
    `${clientIp ?? "unknown"}:${email}`,
  );
  if (ipLimited !== null) return ipLimited;
  const emailLimited = await enforceRateLimit(env.RESET_LIMITER, `email:${email}`);
  if (emailLimited !== null) return emailLimited;

  // ---- 4. Turnstile — runs UNCONDITIONALLY, before the lookup below, so it
  // never itself becomes a registered/unregistered timing signal ------------
  let turnstileOk: boolean;
  try {
    turnstileOk = await verifyTurnstile(env, turnstileToken, clientIp ?? undefined);
  } catch (err) {
    console.error("turnstile verification errored", err);
    turnstileOk = false;
  }
  if (!turnstileOk) {
    return errorResponse("FORBIDDEN", 403);
  }

  // ---- 5. Lookup (FRESH) — see the file header's NO USER ENUMERATION note --
  const user = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE email = $1",
      [email],
    );
    return rows[0] ?? null;
  });

  // Not found: answer identically to the found path, spending nothing further.
  if (user === null) {
    return accepted();
  }

  // ---- 6. Mint + mail — the mail send is DISPATCHED, not awaited -----------
  // See the file header: awaiting it here would make the response itself
  // carry the network-latency gap between "found" and "not found".
  const token = await createResetToken(env, ctx, user.id);
  const resetUrl = `${verificationLinkOrigin(request)}/reset-password?token=${encodeURIComponent(token)}`;
  ctx.waitUntil(sendPasswordResetEmail(env, user.email, resetUrl));

  return accepted();
}

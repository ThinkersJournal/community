/**
 * `GET /verify-email?token=…` — redeem an emailed verification token and mark
 * the user's address as verified.
 */
import { consumeVerificationToken } from "../auth/email-verify";
import { withClient } from "../db/client";

/**
 * The single failure response for EVERY unhappy path: a missing token, an
 * unknown token, an expired token, and an already-used token all return this
 * exact response. Deliberately generic — distinguishing "expired" from "never
 * existed" would confirm to an attacker that a guessed token was once real.
 */
function invalidToken(): Response {
  return new Response("Invalid or expired verification link", { status: 400 });
}

/**
 * Handle `GET /verify-email`. Consumes the token (one-time — see
 * src/auth/email-verify.ts) and, on success, stamps `email_verified_at`.
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

  const userId = await consumeVerificationToken(env, token);
  if (userId === null) {
    return invalidToken();
  }

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [
      userId,
    ]),
  );

  return new Response("Email verified", { status: 200 });
}

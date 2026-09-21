/**
 * `POST /auth/reset-password` — redeem a token from `forgot-password.ts` for
 * a new, chosen password (#70).
 *
 * ⚠️ NO SESSION REQUIRED — see `src/auth/password-reset.ts`'s header for the
 * full derivation of why this is safe and why it differs from
 * `GET /verify-email`'s login requirement. The token itself, 32 bytes of
 * CSPRNG output, single-use and time-boxed, IS the identity proof.
 *
 * ⚠️ ORIGIN CHECK RUNS BEFORE PARSING/VALIDATION — see `forgot-password.ts`'s
 * header for why: `test/route-protection.test.ts`'s shared probe body has no
 * `token` field, so validation-before-origin would 400 an origin-less probe
 * before the origin check ever ran, and that suite's "PIPELINE_EXEMPT routes
 * still 403 with no Origin" assertion would fail for the wrong reason.
 *
 * ⚠️ NO CSRF DOUBLE-SUBMIT TOKEN, and no rate limit either — neither
 * applies here, and both are absences with reasons, not omissions:
 *   - CSRF: there is no session yet to hold a `csrfSecret` to check against.
 *     The reset token is the unguessable, single-use, time-boxed secret
 *     bound to this action — the same trust model `GET /verify-email`'s
 *     token already carries, and that route has no CSRF check either.
 *   - Rate limit: guessing a 256-bit token is not a viable attack regardless
 *     of how many attempts are allowed — `verify-email.ts`'s own comment
 *     says it plainly: "the defense is the ENTROPY, not the response shape."
 *     `GET /verify-email` has no rate limit for the identical reason.
 *
 * ⚠️ ONE TRANSACTION, consume-then-mutate, so a failure between the token
 * redemption and the password change ROLLS BACK BOTH — same reasoning as
 * `signup.ts`'s guarded upsert: a token consumed but not acted on would
 * strand the user with a burned link and no password change, for no better
 * reason than an unlucky mid-request failure. Consuming the token INSIDE the
 * same transaction as the password write means either both happen or
 * neither does, and the user can safely retry the same link if it fails
 * before COMMIT.
 *
 * ⚠️ EPOCH BUMP IS INSIDE THE TRANSACTION, BEFORE THE COMMIT — the exact
 * order `signup.ts`'s re-signup path uses and explains at length: bumping
 * first means a failed bump rolls back the whole transaction (old password
 * stays live, nothing granted, harmless), while bumping after a successful
 * password write would leave a window where the new password is live but
 * old sessions are not yet revoked. `logout-all`'s revocation mechanism
 * (`USER_SECURITY` Durable Object epoch counter) is reused verbatim — this
 * is not a new revocation concept.
 *
 * ⚠️ MARKS THE ADDRESS VERIFIED ON SUCCESS. See
 * `src/auth/password-reset.ts`'s header for why: redeeming this token proves
 * the exact fact `GET /verify-email` exists to prove, via an equally strong
 * token, so a user who resets is never left unverified having just
 * demonstrated the very thing verification requires — and if an unverified
 * account was ever taken over via the re-signup chain `verify-email.ts`
 * documents, the real owner completing a reset is what ends that chain
 * permanently. `COALESCE`d, exactly like the re-signup path's `hidden_at`
 * idiom elsewhere in this codebase: never rewrite an EARLIER verification
 * timestamp that already exists.
 */
import { ResetPasswordInput } from "@thinkersjournal/shared";

import { checkOrigin } from "../auth/csrf";
import { base64urlEncode, sha256Hex } from "../auth/encoding";
import { hashPassword } from "../auth/password";
import { createSession } from "../auth/session";
import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
import { errorResponse } from "../http/errors";

function invalidToken(): Response {
  return errorResponse("INVALID_RESET_TOKEN", 400);
}

export async function handleResetPassword(
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
  const parsed = ResetPasswordInput.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }
  const { token, password } = parsed.data;

  // Hashed OUTSIDE the transaction, same reasoning as signup.ts: Argon2id is
  // deliberately slow, and holding a Hyperdrive connection open across it
  // would burn a pooled connection for the duration of every reset.
  const passwordHash = await hashPassword(password);
  // Same SHA-256-of-token lookup key `createResetToken`/`consumeResetToken`
  // use (src/auth/password-reset.ts) — computed here, in JS, rather than
  // inline SQL, so this route does not depend on pgcrypto being installed.
  const tokenHash = await sha256Hex(token);

  // ---- 3. Consume the token + write the new password, ONE transaction -----
  // ⚠️ INLINES the same UPDATE `consumeResetToken` runs, rather than calling
  // it, because it must run on THIS connection/transaction — see the file
  // header on why the consume and the password write must be atomic together.
  const userId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query(BEGIN_BOUNDED_TX);
    try {
      const { rows } = await c.query<{ user_id: string }>(
        `UPDATE password_reset_tokens
            SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
        [tokenHash],
      );
      const row = rows[0];
      if (row === undefined) {
        await c.query("ROLLBACK");
        return null;
      }

      await c.query(
        `UPDATE users
            SET password_hash = $1,
                email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $2`,
        [passwordHash, row.user_id],
      );

      // ---- Epoch bump — BEFORE THE COMMIT, see the file header ------------
      await env.USER_SECURITY.getByName(row.user_id).bumpEpoch();

      await c.query("COMMIT");
      return row.user_id;
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("ROLLBACK after a failed password-reset transaction failed", rollbackErr);
      }
      throw err;
    }
  });

  if (userId === null) {
    return invalidToken();
  }

  // ---- 4. Security epoch — read AFTER the bump, same reasoning as signup ---
  const securityEpoch = await env.USER_SECURITY.getByName(userId).getEpoch();

  // ---- 5. Session — log the user back in with their new password ----------
  const { cookie } = await createSession(env, {
    userId,
    roles: [],
    securityEpoch,
    csrfSecret: base64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: Date.now(),
  });

  return new Response(null, { status: 200, headers: { "Set-Cookie": cookie } });
}

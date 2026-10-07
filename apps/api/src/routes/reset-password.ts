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
 * ⚠️ NO CSRF DOUBLE-SUBMIT TOKEN — an absence with a reason, not an omission:
 * there is no session yet to hold a `csrfSecret` to check against. The reset
 * token is the unguessable, single-use, time-boxed secret bound to this
 * action — the same trust model `GET /verify-email`'s token already carries,
 * and that route has no CSRF check either.
 *
 * ⚠️ RATE LIMIT, AND TOKEN-BEFORE-ARGON2 (brute-force audit 2026-10-06, #4).
 * This header used to say no limiter was needed because a 256-bit token cannot
 * be guessed. That is still true of GUESSING, but it missed the COST: the route
 * ran a full Argon2id hash of the submitted password BEFORE looking at the
 * token, so any made-up token bought 19 MiB × 2 passes of CPU, unauthenticated
 * and unthrottled. Two fixes, each sufficient against a different attacker:
 *   - Step 2c peeks the token first; only a live token reaches Argon2id.
 *   - Step 2b bounds each IP to RESET_REDEEM_LIMITER's 10/60s (per Cloudflare
 *     location). A real user redeems one link, maybe twice after a typo, so 10
 *     leaves room for several people behind one NAT; it caps one host's peeks
 *     and keeps the `security:` log of refused tokens readable.
 * Every refused token and every 429 is logged (`security:` prefix).
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
import { ResetPasswordInput, logSecurityEvent } from "@thinkersjournal/shared";

import { isBarred } from "../auth/account-status";
import { checkOrigin } from "../auth/csrf";
import { base64urlEncode, sha256Hex } from "../auth/encoding";
import { hashPassword } from "../auth/password";
import { enforceRateLimit } from "../auth/ratelimit";
import { createSession } from "../auth/session";
import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
import { clientIp } from "../http/client-ip";
import { errorResponse } from "../http/errors";

import type { AccountStatusRow } from "../auth/account-status";

/** This route, as its `security:` log lines name it. */
const ROUTE = "/auth/reset-password";

/**
 * The ONE refusal for every bad-token case (unknown, expired, spent, anonymised
 * account), each logged as a `security: auth_failure` line with the IP — never
 * the token or the password.
 */
function invalidToken(ip: string | null): Response {
  logSecurityEvent({ kind: "auth_failure", route: ROUTE, reason: "invalid_reset_token", ip });
  return errorResponse("INVALID_RESET_TOKEN", 400);
}

/** The Argon2id hash this route uses — `hashPassword` in production. */
export type PasswordHasher = (password: string) => Promise<string>;

/**
 * Build the handler around `hash`. Production uses `handleResetPassword` below
 * (`hashPassword`); the factory exists so test/reset-password.test.ts can hand in
 * a SPY and prove an invalid token never reaches Argon2id. The pool runs real
 * workerd, where an ES module's exports cannot be spied on, and the router's
 * fourth argument is already `params`, so the hasher cannot ride along there.
 */
export function makeResetPasswordHandler(hash: PasswordHasher) {
  return (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    resetPassword(request, env, ctx, hash);
}

export const handleResetPassword = makeResetPasswordHandler(hashPassword);

async function resetPassword(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  hash: PasswordHasher,
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

  // ---- 2b. Per-IP rate limit -------------------------------------------------
  // See the file header's RATE LIMIT note. Keyed on the IP alone (there is no
  // email or session here), on its own RESET_REDEEM_LIMITER. An UNKNOWN IP skips
  // it rather than sharing one "unknown" bucket that a single caller could spend
  // for every user mid-reset; step 2c still keeps Argon2id off that path.
  const ip = clientIp(request);
  if (ip !== null) {
    const limited = await enforceRateLimit(env.RESET_REDEEM_LIMITER, `ip:${ip}`, {
      route: ROUTE,
      bucket: "ip",
      ip,
    });
    if (limited !== null) {
      return limited;
    }
  }

  // Same SHA-256-of-token lookup key `createResetToken`/`consumeResetToken`
  // use (src/auth/password-reset.ts) — computed here, in JS, rather than
  // inline SQL, so this route does not depend on pgcrypto being installed.
  const tokenHash = await sha256Hex(token);

  // ---- 2c. Peek the token BEFORE Argon2id -----------------------------------
  // ⚠️ ORDER IS THE DEFENSE. Argon2id (19 MiB, two passes) is the most expensive
  // thing this Worker does, and this route is unauthenticated: hashing first let
  // anyone spend that per request with a made-up token. A cheap indexed SELECT
  // on the token hash now gates it, so only a token that is live AT THIS MOMENT
  // ever reaches the hash. The same conditions as step 3's consume, plus the
  // anonymised-account check step 3 applies to the user row.
  //
  // This is a PEEK, not the redemption: step 3 still consumes the token and
  // writes the password in ONE transaction, re-checking every condition, so a
  // token spent (or an account anonymised) between here and there still loses
  // the race cleanly with the same generic 400. Validity is no new oracle: the
  // response already says 400 vs 200.
  const live = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      `SELECT 1
         FROM password_reset_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
          AND u.anonymised_at IS NULL`,
      [tokenHash],
    );
    return rows.length > 0;
  });
  if (!live) {
    return invalidToken(ip);
  }

  // Hashed OUTSIDE the transaction, same reasoning as signup.ts: Argon2id is
  // deliberately slow, and holding a Hyperdrive connection open across it
  // would burn a pooled connection for the duration of every reset.
  const passwordHash = await hash(password);

  // ---- 3. Consume the token + write the new password, ONE transaction -----
  // ⚠️ INLINES the same UPDATE `consumeResetToken` runs, rather than calling
  // it, because it must run on THIS connection/transaction — see the file
  // header on why the consume and the password write must be atomic together.
  const redeemed = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
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

      // RETURNING the barring columns from the row just written, so step 5's
      // bar check judges the same row state this transaction saw.
      // `anonymised_at IS NULL`: a token minted just before the reaper's scrub
      // committed must not write a working password onto a deleted account
      // (account-legal-hold spec §4a, PM ruling B). 0 rows: roll back (the
      // token stays unspent, and useless) and answer the generic invalid token,
      // with no epoch bump and no session.
      const { rows: updated } = await c.query<AccountStatusRow>(
        `UPDATE users
            SET password_hash = $1,
                email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $2 AND anonymised_at IS NULL
        RETURNING suspended_until, disabled_at`,
        [passwordHash, row.user_id],
      );
      if (updated.length === 0) {
        await c.query("ROLLBACK");
        return null;
      }

      // ---- Epoch bump — BEFORE THE COMMIT, see the file header ------------
      await env.USER_SECURITY.getByName(row.user_id).bumpEpoch();

      await c.query("COMMIT");
      return { userId: row.user_id, account: updated[0] ?? null };
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("ROLLBACK after a failed password-reset transaction failed", rollbackErr);
      }
      throw err;
    }
  });

  if (redeemed === null) {
    return invalidToken(ip);
  }
  const { userId, account } = redeemed;

  // ---- 3b. Barred account (issue #50) — NO session, the SAME 200 ------------
  // Before this, forgot -> reset was a working way around #35's login refusal:
  // it handed a barred account a fresh session. PM ruling on #50 (Q3): the
  // password change above STANDS (the token proved control of the address, and
  // the epoch bump killed every older session, which is only good here), but
  // no session is minted. The status and body match the success path; only the
  // cookie is missing. The caller holds the address's own token, so that
  // absence tells them nothing about someone else.
  if (account !== null && isBarred(account)) {
    return new Response(null, { status: 200 });
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

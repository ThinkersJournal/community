/**
 * Password-reset tokens (#70) — a single-use, expiring, server-side token
 * delivered to the address being proven, redeemed to set a NEW password the
 * redeemer chooses.
 *
 * ⚠️ NOT THE SESSIONS KV NAMESPACE. src/auth/email-verify.ts's own header
 * warns that its peek/delete pair is a non-atomic race, safe there only
 * because a double-redeem is harmless (an idempotent restamp). A password
 * reset GRANTS something on redemption, so it needs a REAL atomic
 * compare-and-set — `password_reset_tokens` (migration 0018), consumed via
 * `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING
 * user_id`, not KV's non-atomic pair.
 *
 * Only the SHA-256 hash of the token is ever stored — same discipline as
 * sessions and verification tokens — so a leaked/dumped table row never
 * reveals a usable reset link.
 *
 * ⚠️ NO SESSION REQUIRED TO REDEEM, AND THIS IS DELIBERATE — unlike
 * `GET /verify-email` (see that file's header for the account-takeover chain
 * it closes: a victim signs up, an attacker re-signs-up the same still-
 * UNVERIFIED address and takes over `password_hash`, and the victim's OWN
 * click on their original token would otherwise promote the attacker's
 * account to verified). Password reset has no analogue to that chain. Trace
 * the same shape: the token is delivered to the address, and redeeming it
 * sets a password the REDEEMER chooses. If an attacker requests the reset,
 * the mail goes to the VICTIM's mailbox, not the attacker's — the attacker
 * never sees the token. If the victim redeems it, the victim sets the
 * password and takes the account back. There is no step where the victim's
 * action benefits the attacker, which is the entire engine of the
 * verify-email chain. Possession of the emailed token IS mailbox control,
 * and mailbox control is the identity proof a reset is FOR. Requiring a
 * session here would also be incoherent: the user is here precisely because
 * they cannot authenticate.
 *
 * Redeeming also proves the SAME fact `GET /verify-email` exists to prove
 * (mailbox control) via an equally strong token (32 bytes of CSPRNG,
 * single-use, time-boxed) — so `handleResetPassword` marks the address
 * verified on success too. This is not a side effect grabbed for
 * convenience: if an unverified account was ever taken over via the
 * re-signup chain above, the real owner completing a reset is what ends
 * that chain permanently, by the same proof standard verification already
 * requires.
 */
import { base64urlEncode, sha256Hex } from "./encoding";
import { escapeHtml } from "./email-verify";
import { postmarkSend } from "./postmark";
import { withClient } from "../db/client";

/**
 * Deliberately SHORTER than email verification's 24h: this token grants a
 * password change (and, per this file's header, a verification restamp),
 * not merely a confirmation — a narrower window bounds how long a
 * momentarily-exposed link (an email preview pane, a shared inbox) stays
 * live.
 */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * The fixed KV key under which the most recently issued RAW reset token is
 * stashed for `GET /__test/last-reset-token` (src/routes/__test.ts) to hand
 * back to the E2E suite — the SAME test-seam shape `TEST_LAST_TOKEN_KEY`
 * (src/auth/email-verify.ts) uses for verification tokens, for the identical
 * reason: E2E's Postmark is configured with a dummy token so the real send
 * fails by design, and this stash stands in for reading the inbox. The stash
 * itself lives in KV even though the token's REAL storage is
 * `password_reset_tokens` (Postgres) — this is test scaffolding only, not a
 * second source of truth. See email-verify.ts's header for the full
 * three-layer gate this mirrors.
 *
 * Written ONLY when `env.TEST_ROUTES === "1"`, identical condition to every
 * other test-only gate in this Worker.
 */
export const TEST_LAST_RESET_TOKEN_KEY = "__test:last-reset-token";

/**
 * Mint a reset token for `userId`: a 32-byte random value, stored (as its
 * SHA-256 hash) in `password_reset_tokens` with a 1h expiry. Returns the RAW
 * token — the only copy — for embedding in the emailed reset link.
 */
export async function createResetToken(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<string> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    ),
  );

  // TEST-ONLY — see TEST_LAST_RESET_TOKEN_KEY's own comment.
  if (env.TEST_ROUTES === "1") {
    await env.SESSIONS.put(TEST_LAST_RESET_TOKEN_KEY, token, {
      expirationTtl: Math.ceil(RESET_TOKEN_TTL_MS / 1000),
    });
  }

  return token;
}

/**
 * Atomically redeem a reset token: single-use, expiry-checked, a real
 * compare-and-set. Returns the token's user id on success, or `null` for an
 * unknown/expired/already-used token — deliberately one generic outcome,
 * matching `GET /verify-email`'s "one failure response for every unhappy
 * token path" reasoning (distinguishing "expired" from "never existed" would
 * confirm to an attacker that a guessed token was once real).
 */
export async function consumeResetToken(
  env: Env,
  ctx: ExecutionContext,
  token: string,
): Promise<string | null> {
  const tokenHash = await sha256Hex(token);
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ user_id: string }>(
      `UPDATE password_reset_tokens
          SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
      [tokenHash],
    );
    return rows[0] ?? null;
  });
  return row?.user_id ?? null;
}

/**
 * Send the password-reset email through Postmark, on the "outbound"
 * (transactional) stream — same sender and stream as email verification, so
 * no new sender needs confirming.
 *
 * NEVER THROWS (`postmarkSend`'s own contract) — a Postmark outage must not
 * fail the request that triggered it. Callers should dispatch this via
 * `ctx.waitUntil` rather than awaiting it inline on the response path: see
 * `routes/forgot-password.ts`'s header for why (closing the network-latency
 * half of the "does this email exist" timing oracle).
 */
export async function sendPasswordResetEmail(
  env: Env,
  email: string,
  url: string,
): Promise<void> {
  await postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to: email,
    subject: "Reset your Thinkers Journal password",
    textBody: `Someone requested a password reset for this Thinkers Journal account.\n\nTo choose a new password, open this link:\n\n${url}\n\nThe link expires in 1 hour and can only be used once. If you did not request this, you can safely ignore this email — your password will not change.`,
    htmlBody: `<p>Someone requested a password reset for this Thinkers Journal account.</p><p>To choose a new password, open this link:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>The link expires in 1 hour and can only be used once. If you did not request this, you can safely ignore this email — your password will not change.</p>`,
    stream: "outbound",
  });
}

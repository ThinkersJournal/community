/**
 * Email-verification tokens + the Postmark send for the `api` Worker.
 *
 * A verification token is a random, unguessable, ONE-TIME value emailed to the
 * address being proven. It follows the same hash-before-store property as
 * sessions (src/auth/session.ts): KV holds only the SHA-256 hash of the token,
 * so a leaked/dumped KV namespace never reveals a usable verification link.
 * Consuming a token DELETES its key, so a replayed link cannot re-verify.
 *
 * Tokens live in the `SESSIONS` KV namespace under a `verify-email:` prefix,
 * with a 24h TTL.
 */

const VERIFY_TTL_SECONDS = 86_400; // 24h

/**
 * The fixed KV key under which the most recently issued RAW token is stashed
 * for `GET /__test/last-verify-token` (src/routes/__test.ts) to hand back to
 * the E2E suite. Written ONLY when `env.TEST_ROUTES` is set.
 *
 * ⚠️ The `__test:` prefix marks it as test-only scaffolding; nothing in the
 * production path reads or writes it, because `TEST_ROUTES` is unset in prod.
 */
export const TEST_LAST_TOKEN_KEY = "__test:last-verify-token";

/** Base64url-encode (URL-safe, no padding) raw bytes — RFC 4648 §5. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex-encode the SHA-256 digest of `value`, used as the KV key suffix. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The KV key holding the user id for a given raw verification token. */
async function verifyKey(token: string): Promise<string> {
  return `verify-email:${await sha256Hex(token)}`;
}

/**
 * Mint a verification token for `userId`: a 32-byte random value, stored in KV
 * under its SHA-256 hash with a 24h TTL. Returns the RAW token — the only copy
 * of it — for embedding in the emailed verification link.
 */
export async function createVerificationToken(
  env: Env,
  userId: string,
): Promise<string> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

  await env.SESSIONS.put(await verifyKey(token), userId, {
    expirationTtl: VERIFY_TTL_SECONDS,
  });

  // TEST-ONLY: stash the raw token so the gated `__test` route can return it to
  // the E2E suite. Guarded so production (TEST_ROUTES unset) never writes a raw
  // token to KV at all — the stash simply does not exist there.
  if (env.TEST_ROUTES) {
    await env.SESSIONS.put(TEST_LAST_TOKEN_KEY, token, {
      expirationTtl: VERIFY_TTL_SECONDS,
    });
  }

  return token;
}

/**
 * Redeem a verification token, returning the user id it was minted for, or
 * `null` if it is unknown/expired/already used.
 *
 * ONE-TIME: a successful lookup deletes the key before returning, so a replayed
 * link (a forwarded email, a link in browser history, a leaked referrer) cannot
 * verify the account a second time.
 */
export async function consumeVerificationToken(
  env: Env,
  token: string,
): Promise<string | null> {
  const key = await verifyKey(token);

  const userId = await env.SESSIONS.get(key);
  if (userId === null) {
    return null;
  }

  await env.SESSIONS.delete(key);
  return userId;
}

/**
 * Send the verification email through Postmark's transactional API.
 *
 * `From` MUST stay `noreply@thinkersjournal.com`: Postmark silently drops mail
 * from a sender signature that is not confirmed on the account, so changing
 * this without confirming the new sender first breaks signup in production with
 * no visible error.
 */
export async function sendVerificationEmail(
  env: Env,
  email: string,
  url: string,
): Promise<void> {
  await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      From: "noreply@thinkersjournal.com",
      To: email,
      Subject: "Verify your Thinkers Journal email address",
      TextBody: `Welcome to Thinkers Journal.\n\nConfirm your email address by opening this link:\n\n${url}\n\nThe link expires in 24 hours and can only be used once. If you did not create an account, you can ignore this email.`,
      HtmlBody: `<p>Welcome to Thinkers Journal.</p><p>Confirm your email address by opening this link:</p><p><a href="${url}">${url}</a></p><p>The link expires in 24 hours and can only be used once. If you did not create an account, you can ignore this email.</p>`,
      MessageStream: "outbound",
    }),
  });
}

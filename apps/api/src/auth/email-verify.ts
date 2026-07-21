/**
 * Email-verification tokens + the Postmark send for the `api` Worker.
 *
 * A verification token is a random, unguessable, ONE-TIME value emailed to the
 * address being proven. It follows the same hash-before-store property as
 * sessions (src/auth/session.ts): KV holds only the SHA-256 hash of the token,
 * so a leaked/dumped KV namespace never reveals a usable verification link.
 * Redeeming a token DELETES its key, so a replayed link cannot re-verify.
 *
 * Tokens live in the `SESSIONS` KV namespace under a `verify-email:` prefix,
 * with a 24h TTL.
 *
 * ⚠️ LOOKUP AND DELETE ARE DELIBERATELY SEPARATE (`peekVerificationToken` /
 * `deleteVerificationToken`) rather than one `consume` call. `GET /verify-email`
 * must resolve a token to its user id BEFORE it can run its authentication
 * checks (the token is what says WHO is being verified), but a request that
 * fails those checks must NOT burn the token: a legitimate user who clicks the
 * link before signing in has to be able to click that same link again after
 * logging in. The route therefore peeks, authenticates, and only then deletes —
 * keeping the token one-time ON SUCCESS while leaving it usable after a
 * rejected attempt. Do not recombine these into a single consume-on-lookup.
 */

import { base64urlEncode, sha256Hex } from "./encoding";

const VERIFY_TTL_SECONDS = 86_400; // 24h

/**
 * The origin verification links point at unless the request proves it came from
 * another PRODUCTION origin (see `verificationLinkOrigin`).
 *
 * ⚠️ NOT `new URL(request.url).origin`: that is derived from the client-supplied
 * `Host` header, which would let an attacker point the verification link in mail
 * sent from OUR confirmed sender at a host they control — a phishing/token-theft
 * vector (see the escaping note on `escapeHtml` below).
 */
const CANONICAL_ORIGIN = "https://community.thinkersjournal.com";

/**
 * The ONLY origins an emailed verification link may point at.
 *
 * ⚠️ Deliberately NARROWER than `checkOrigin`'s allowlist (src/auth/csrf.ts), and
 * deliberately a SEPARATE list rather than an import — the two answer different
 * questions and must be free to diverge. `checkOrigin` asks "may this browser
 * submit this form?", for which allowing `http://localhost:8787` is fine: a
 * remote attacker's browser cannot forge that Origin against a developer's
 * machine. This list asks "where may we send a real user's verification link?",
 * and localhost is NOT fine there, because a NON-BROWSER client (curl, a script)
 * can set any Origin it likes against production, pass `checkOrigin`, and get a
 * `http://localhost:8787/verify-email?token=…` link delivered into the victim's
 * inbox — a link that can never work, i.e. verification-denial griefing.
 *
 * Consequence for LOCAL DEV: a signup at localhost gets a link pointing at
 * production. That is intentional. Local flows use the gated
 * `GET /__test/last-verify-token` route (src/routes/__test.ts) to fetch the raw
 * token instead — do NOT re-add localhost here to make dev email links clickable.
 */
const VERIFICATION_LINK_ORIGINS: Set<string> = new Set([
  "https://community.thinkersjournal.com",
]);

/**
 * The origin to build a verification link on: the request's `Origin` when it is
 * a production origin (so a signup on `www.` keeps the user on `www.`), and
 * `CANONICAL_ORIGIN` for EVERYTHING else — a missing Origin, a `Referer`-only
 * request, and any non-production origin `checkOrigin` tolerates.
 *
 * Fails SAFE by construction: the only values that can ever be returned are the
 * members of `VERIFICATION_LINK_ORIGINS` and `CANONICAL_ORIGIN`, none of which
 * are attacker-influenced. `Referer` is deliberately NOT consulted — it is a
 * weaker signal than `Origin` and every value it could contribute is already
 * covered by the canonical fallback.
 *
 * ⚠️ LIVES HERE, NOT IN src/routes/signup.ts, SO THAT "WHICH ORIGIN MAY WE MAIL
 * A LINK TO" IS ONE RULE WITH ONE IMPLEMENTATION. It was signup's private
 * helper until Task 10 added a SECOND route that mails the same link
 * (src/routes/resend-verification.ts). That route first shipped with a bare
 * `CANONICAL_ORIGIN` constant and a docstring claiming it was "identical to
 * signup's" — true of the SECURITY property (neither is Host-derived) but NOT of
 * the behaviour: signup keeps a `www.` user on `www.`, while the copy always
 * mailed an apex link. That is precisely the drift two copies of a rule produce,
 * so there is now one function and both callers use it.
 */
export function verificationLinkOrigin(request: Request): string {
  const origin = request.headers.get("Origin");
  return origin !== null && VERIFICATION_LINK_ORIGINS.has(origin)
    ? origin
    : CANONICAL_ORIGIN;
}

/**
 * The fixed KV key under which the most recently issued RAW token is stashed
 * for `GET /__test/last-verify-token` (src/routes/__test.ts) to hand back to
 * the E2E suite. Written ONLY when `env.TEST_ROUTES` is exactly `"1"`.
 *
 * ⚠️ The `__test:` prefix marks it as test-only scaffolding; nothing in the
 * production path reads or writes it, because `TEST_ROUTES` is unset in prod.
 */
export const TEST_LAST_TOKEN_KEY = "__test:last-verify-token";

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
  // the E2E suite. Guarded so production never writes a raw token to KV at all —
  // the stash simply does not exist there.
  //
  // An EXPLICIT `=== "1"` allowlist, not a truthiness check: vars are always
  // strings, so `TEST_ROUTES="0"` / `"false"` are truthy and would have turned
  // the stash ON for someone editing `.dev.vars` to mean "off". Keep this
  // condition identical to the gate in routes/__test.ts.
  if (env.TEST_ROUTES === "1") {
    await env.SESSIONS.put(TEST_LAST_TOKEN_KEY, token, {
      expirationTtl: VERIFY_TTL_SECONDS,
    });
  }

  return token;
}

/**
 * Look up a verification token WITHOUT consuming it, returning the user id it
 * was minted for, or `null` if it is unknown/expired/already redeemed.
 *
 * Does NOT delete: the caller decides whether the token was actually redeemed.
 * `GET /verify-email` (src/routes/verify-email.ts) needs the user id to run its
 * auth checks, and must leave the token intact when those checks fail — see the
 * file header. Callers that DO redeem the token MUST follow up with
 * `deleteVerificationToken` to keep it one-time.
 */
export async function peekVerificationToken(
  env: Env,
  token: string,
): Promise<string | null> {
  return await env.SESSIONS.get(await verifyKey(token));
}

/**
 * Delete a verification token's key, making it unusable. Idempotent — deleting
 * an unknown/already-deleted token is a no-op.
 *
 * ONE-TIME: the redeeming caller invokes this on its success path, so a replayed
 * link (a forwarded email, a link in browser history, a leaked referrer) cannot
 * verify the account a second time.
 *
 * ⚠️ NOT ATOMIC with `peekVerificationToken`: that peek-then-delete pair means
 * two requests racing the same token can both observe it before either delete
 * lands, and both will succeed. That is harmless HERE because the only effect is
 * an idempotent `UPDATE users SET email_verified_at = now()` — a double-verify
 * just restamps the column — and because both racers must independently pass the
 * route's authentication checks, so a race grants an attacker nothing. Do NOT
 * reuse this pair for password reset, invites, single-use payment/credit
 * operations, or anything where a double-redeem grants something: those need a
 * real atomic compare-and-delete (e.g. a DO or a conditional SQL UPDATE), which
 * KV cannot provide.
 */
export async function deleteVerificationToken(
  env: Env,
  token: string,
): Promise<void> {
  await env.SESSIONS.delete(await verifyKey(token));
}

/** The subset of Postmark's send response this module inspects. */
interface PostmarkResponse {
  ErrorCode?: number;
  Message?: string;
}

/**
 * Escape text for interpolation into HTML (both element text and a
 * double-quoted attribute value). `&` MUST be replaced first or the other
 * replacements' ampersands would be double-escaped.
 *
 * The `url` this is applied to is a caller-supplied string. It is safe today,
 * but a later task builds the verification URL from a request `Host`/`Origin`
 * header — at which point unescaped interpolation would let an attacker-
 * controlled host break out of the `href` attribute and inject markup into an
 * email we send from our own confirmed sender.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send the verification email through Postmark's transactional API.
 *
 * `From` MUST stay `noreply@thinkersjournal.com`: Postmark silently drops mail
 * from a sender signature that is not confirmed on the account, so changing
 * this without confirming the new sender first breaks signup in production with
 * no visible error.
 *
 * NEVER THROWS. A failed send must not fail the signup that triggered it: the
 * account exists, and the user can request another verification email. Every
 * failure mode — a network error, a non-2xx, or a 200 carrying a non-zero
 * `ErrorCode` (which is how the unconfirmed-sender misconfiguration above
 * surfaces) — is detected and logged to Workers Logs (`observability.enabled`
 * is set in wrangler.jsonc) instead of propagating.
 *
 * ⚠️ The logs deliberately carry only status/ErrorCode/Message — NEVER `email`
 * or `url`. The url embeds the raw verification token, so logging it would
 * write an account-takeover credential into the log stream.
 */
export async function sendVerificationEmail(
  env: Env,
  email: string,
  url: string,
): Promise<void> {
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
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
        HtmlBody: `<p>Welcome to Thinkers Journal.</p><p>Confirm your email address by opening this link:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>The link expires in 24 hours and can only be used once. If you did not create an account, you can ignore this email.</p>`,
        MessageStream: "outbound",
      }),
    });

    if (!res.ok) {
      console.error("postmark send failed", {
        status: res.status,
        body: await res.text(),
      });
      return;
    }

    const { ErrorCode, Message } = (await res.json()) as PostmarkResponse;
    if (ErrorCode !== 0) {
      console.error("postmark rejected send", { ErrorCode, Message });
    }
  } catch (err) {
    // A network blip (or a non-JSON body) must NOT propagate: it would 500 the
    // signup this send is a side effect of.
    console.error("postmark request threw", err);
  }
}

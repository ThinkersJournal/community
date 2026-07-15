/**
 * Opaque KV session primitive for the `api` Worker.
 *
 * The session cookie holds nothing but a random, unguessable token — never the
 * user id, roles, or any other claim. The KV STORE holds the actual
 * `SessionData` (userId/roles/securityEpoch/csrfSecret/createdAt), keyed by the
 * SHA-256 hash of the token (never the raw token itself), so a leaked/dumped
 * KV namespace never reveals a forgeable cookie value.
 *
 * Cookie lifetime and KV `expirationTtl` are both 30 days (2_592_000 seconds).
 */
import { COOKIE_DOMAIN, SESSION_COOKIE_NAME } from "@thinkersjournal/shared";

import type { SessionData } from "@thinkersjournal/shared";

const SESSION_TTL_SECONDS = 2_592_000; // 30 days

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

/** The KV key under which a session's data is stored, given its raw cookie token. */
async function sessionKey(token: string): Promise<string> {
  return `sess:${await sha256Hex(token)}`;
}

/**
 * Parse the `tj_session` value out of a request's `Cookie` header. Hand-rolled
 * (rather than a full cookie-parsing library) because we only ever need one
 * name/value pair out of a `; `-separated list.
 */
function parseSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = trimmed.slice(0, eq);
    if (name === SESSION_COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

/**
 * Build the `Set-Cookie` string carrying `token` (or the clearing value).
 *
 * ⚠️ THE ATTRIBUTES ARE ENVIRONMENT-DEPENDENT, AND THAT IS DELIBERATE.
 *
 * Production emits `Domain=.thinkersjournal.com; Secure` — the Global
 * Constraint, and non-negotiable there: `Secure` keeps the session token off
 * plaintext http, and the `Domain` scopes it across our subdomains.
 *
 * But those same two attributes make the cookie IMPOSSIBLE to store in local
 * dev. At `http://127.0.0.1:8787` a browser rejects `Secure` (not https) and
 * rejects a `Domain` the origin does not belong to — so it silently drops the
 * cookie, `readSession` returns null on the next request, and every
 * authenticated flow 401s. No session can exist at all: a real-browser E2E is
 * impossible, and a human clicking through localhost cannot stay logged in.
 * So dev omits EXACTLY those two attributes and nothing else — `HttpOnly`,
 * `SameSite=Lax`, `Path`, and `Max-Age` are identical in both modes.
 *
 * ⚠️ WHY THIS IS KEYED ON `TEST_ROUTES` AND MUST NOT GET ITS OWN FLAG.
 * `TEST_ROUTES` is already the most deploy-gated var in the system: it gates
 * `GET /__test/last-verify-token` (src/routes/__test.ts), which hands out a
 * live account-takeover credential. It is therefore set ONLY in the gitignored
 * `.dev.vars` and vitest's `miniflare.bindings`, is deliberately absent from
 * wrangler.jsonc's `vars` so a deploy cannot carry it, and the deploy gate
 * already asserts its absence. Reusing it means the relaxed cookie is
 * unreachable in production for the SAME reason the test route is, checked by
 * the SAME gate. A second flag would be a second thing to get wrong, and its
 * failure mode — a production session cookie quietly losing `Secure` — is a
 * plaintext-interception bug that no test would catch.
 *
 * An EXPLICIT `=== "1"` allowlist, NOT a truthiness check: wrangler vars are
 * always strings, so `TEST_ROUTES="0"` and `"false"` are both TRUTHY, and a
 * truthiness check would strip `Secure` in production for anyone who set "0"
 * to mean "off". Fail closed on everything but the literal "1". Keep this
 * condition identical to the gates in routes/__test.ts and auth/email-verify.ts.
 *
 * BOTH modes are pinned by test/session.test.ts — including the exact
 * production string — because the suite itself runs with `TEST_ROUTES="1"`, so
 * the production shape would otherwise go entirely unexercised.
 */
function buildCookie(env: Env, token: string, maxAge: number): string {
  // DEV/CI ONLY — omits Domain + Secure. Unreachable in production: see above.
  if (env.TEST_ROUTES === "1") {
    return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  // PRODUCTION. Both branches are spelled out in full rather than assembled
  // from shared fragments, so each string is readable (and greppable) exactly
  // as the browser will receive it.
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Domain=${COOKIE_DOMAIN}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * Create a new session: generates a random opaque token, stores `data` in KV
 * under the token's SHA-256 hash (with a 30-day TTL), and returns the
 * `Set-Cookie` string for the raw token. `data` (userId/roles/securityEpoch/
 * csrfSecret) is never placed in the cookie — only the opaque token is.
 */
export async function createSession(
  env: Env,
  data: SessionData,
): Promise<{ cookie: string }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64urlEncode(tokenBytes);
  const key = await sessionKey(token);

  await env.SESSIONS.put(key, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return { cookie: buildCookie(env, token, SESSION_TTL_SECONDS) };
}

/**
 * Read the session tied to the `tj_session` cookie on `request`, if any.
 * Returns `null` when there is no cookie or the token is unknown/expired.
 */
export async function readSession(
  env: Env,
  request: Request,
): Promise<SessionData | null> {
  const token = parseSessionCookie(request);
  if (token === null) {
    return null;
  }

  const key = await sessionKey(token);
  const stored = await env.SESSIONS.get(key);
  if (stored === null) {
    return null;
  }

  return JSON.parse(stored) as SessionData;
}

/**
 * Destroy the session tied to `request`'s `tj_session` cookie (deleting its KV
 * entry) and return a cleared `Set-Cookie` string (`Max-Age=0`, empty value)
 * so the browser drops the cookie.
 */
export async function destroySession(
  env: Env,
  request: Request,
): Promise<{ cookie: string }> {
  const token = parseSessionCookie(request);
  if (token !== null) {
    const key = await sessionKey(token);
    await env.SESSIONS.delete(key);
  }

  // ⚠️ Built with the SAME `env`, so the cleared cookie carries the same
  // Domain/Path/Secure as the one that set it — a browser only drops a cookie
  // when those match. A mismatch would leave a dead session cookie in place.
  return { cookie: buildCookie(env, "", 0) };
}

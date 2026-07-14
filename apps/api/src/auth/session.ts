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

/** Build the `Set-Cookie` string carrying `token` (or the clearing value). */
function buildCookie(token: string, maxAge: number): string {
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

  return { cookie: buildCookie(token, SESSION_TTL_SECONDS) };
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

  return { cookie: buildCookie("", 0) };
}

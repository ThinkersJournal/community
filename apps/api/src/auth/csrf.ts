/**
 * CSRF defense for the `api` Worker, enforced on every non-GET request before
 * it touches the DB (wired into the request pipeline elsewhere). Two
 * independent layers, both required:
 *
 *   1. `checkOrigin` — an Origin/Referer allowlist check. Cheap, and defeats
 *      the vast majority of cross-site form/fetch submissions outright.
 *   2. `checkCsrf` — a per-session double-submit token. The client must echo
 *      back `sha256Hex(session.csrfSecret)` in an `X-CSRF-Token` header. A
 *      cross-site attacker can trigger a request but (same-origin policy)
 *      cannot READ this value, so they cannot supply it.
 *
 * The token handed to the client is the HASH of the session's `csrfSecret`,
 * never the secret itself — even if the token leaks (e.g. via an XSS bug
 * elsewhere, or logging), it cannot be used to derive the secret or forge
 * anything beyond a matching CSRF header.
 */
import type { SessionData } from "@thinkersjournal/shared";

/**
 * Origins allowed to make non-GET requests. Production hosts plus a tight set
 * of local dev-server origins (both `localhost` and `127.0.0.1` spellings on
 * the wrangler dev port, 8787). Including localhost here is low-risk: a
 * remote attacker's browser cannot forge an `Origin: http://localhost:8787`
 * header for a request actually reaching a developer's machine, and even a
 * matching Origin is insufficient on its own — `checkCsrf`'s per-session
 * token is still required. This function takes no `env`, so the allowlist is
 * a single static set rather than gated by environment.
 */
const ALLOWED_ORIGINS: Set<string> = new Set([
  "https://thinkersjournal.com",
  "https://www.thinkersjournal.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/** Hex-encode the SHA-256 digest of `value`. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison: accumulates XOR differences over the
 * FULL length of both strings (no early return on the first mismatch), so
 * the time taken does not leak how many leading characters matched. Callers
 * are expected to pass fixed-length strings (64-char hex digests); a length
 * mismatch itself is reported immediately (its own length check does not
 * leak useful timing information about digest content) but no character
 * comparison short-circuits.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Origin/Referer allowlist check. Safe methods (GET/HEAD) always pass — they
 * carry no CSRF risk under this app's semantics (no state-changing GET/HEAD
 * endpoints). For any other method: the `Origin` header must be present and
 * in `ALLOWED_ORIGINS`; if `Origin` is absent, fall back to the origin parsed
 * out of `Referer`. Missing BOTH headers, or a value not in the allowlist
 * (including an unparseable `Referer`), fails closed (`false`).
 */
export function checkOrigin(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") {
    return true;
  }

  const origin = request.headers.get("Origin");
  if (origin !== null) {
    return ALLOWED_ORIGINS.has(origin);
  }

  const referer = request.headers.get("Referer");
  if (referer === null) {
    return false;
  }

  try {
    return ALLOWED_ORIGINS.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

/**
 * The CSRF token a client must echo back in `X-CSRF-Token` for `session`:
 * `sha256Hex(session.csrfSecret)`. This is the value delivered to the client
 * (delivery mechanism is a separate concern) — the secret itself never
 * leaves the server.
 */
export async function csrfTokenFor(session: SessionData): Promise<string> {
  return sha256Hex(session.csrfSecret);
}

/**
 * Double-submit token check. Safe methods (GET/HEAD) always pass. For any
 * other method: the `X-CSRF-Token` header must be present and match
 * `csrfTokenFor(session)` under a timing-safe comparison. A missing header
 * fails closed (`false`).
 */
export async function checkCsrf(
  request: Request,
  session: SessionData,
): Promise<boolean> {
  if (request.method === "GET" || request.method === "HEAD") {
    return true;
  }

  const submitted = request.headers.get("X-CSRF-Token");
  if (submitted === null) {
    return false;
  }

  const expected = await csrfTokenFor(session);
  return timingSafeEqual(submitted, expected);
}

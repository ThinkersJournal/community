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
import { timingSafeEqual } from "@thinkersjournal/shared";

import { sha256Hex } from "./encoding";

import type { SessionData } from "@thinkersjournal/shared";

/** The origins allowed to make non-GET requests in PRODUCTION. */
const PRODUCTION_ORIGINS = ["https://community.thinkersjournal.com"] as const;

/**
 * The local dev-server origins, added to the allowlist ONLY when
 * `TEST_ROUTES === "1"`. Both spellings are required and are DIFFERENT origins:
 * a browser sends whichever the developer typed. They are load-bearing for
 * `wrangler dev` and for the E2E suite, which drives a real browser against
 * `http://localhost:8787` / `http://127.0.0.1:8787`.
 */
const DEV_ORIGINS = ["http://localhost:8787", "http://127.0.0.1:8787"] as const;

/**
 * ⚠️ THE DEV ORIGINS ARE GATED, AND THE GATE IS THE POINT.
 *
 * Shipping `http://localhost:8787` in the PRODUCTION allowlist is low-risk but
 * not zero: mutations still need `checkCsrf`'s per-session double-submit token,
 * which a cross-site attacker cannot read, and a localhost login-CSRF cannot
 * stick the resulting cookie because production emits a HOST-ONLY cookie
 * (no `Domain` attribute), scoped to exactly `community.thinkersjournal.com`.
 * It was, however, the ONE env-dependent security
 * affordance in this Worker NOT behind `TEST_ROUTES` — inconsistent with the
 * branch's own principle that dev-only relaxations must be unreachable in
 * production for one reason, checked by one gate.
 *
 * So it reuses the EXISTING, already-deploy-gated `TEST_ROUTES` var rather than
 * inventing a fourth flag — the same reasoning (spelled out at length) as
 * src/auth/session.ts's environment-aware cookie: `TEST_ROUTES` is absent from
 * wrangler.jsonc's `vars`, lives only in the gitignored `.dev.vars` and the test
 * harnesses, and the deploy gate + scripts/deploy-smoke.mjs already assert its
 * absence. One flag, one gate, cannot drift.
 *
 * An EXPLICIT `=== "1"` allowlist, NOT a truthiness check: wrangler vars are
 * always strings, so `TEST_ROUTES="0"` and `"false"` are both TRUTHY and a
 * truthiness check would widen the production allowlist for anyone who set "0"
 * to mean "off". Fail closed on everything but the literal "1". Keep this
 * condition identical to the gates in routes/__test.ts, auth/email-verify.ts
 * and auth/session.ts.
 *
 * Both sets are built ONCE at module scope, not per request: this runs on the
 * hot path of every mutating request, and a per-call `new Set([...])` would
 * allocate on each one for no benefit. test/csrf.test.ts pins BOTH modes —
 * including that the dev origins are REJECTED with `TEST_ROUTES` unset, which
 * the suite would otherwise never exercise (it runs with `TEST_ROUTES="1"`).
 */
const PRODUCTION_ONLY_ORIGINS: ReadonlySet<string> = new Set(PRODUCTION_ORIGINS);
const PRODUCTION_AND_DEV_ORIGINS: ReadonlySet<string> = new Set([
  ...PRODUCTION_ORIGINS,
  ...DEV_ORIGINS,
]);

/** The allowlist in force for `env` — see the note above. */
function allowedOrigins(env: Env): ReadonlySet<string> {
  return env.TEST_ROUTES === "1"
    ? PRODUCTION_AND_DEV_ORIGINS
    : PRODUCTION_ONLY_ORIGINS;
}

/**
 * Origin/Referer allowlist check. Safe methods (GET/HEAD) always pass. For any
 * other method: the `Origin` header must be present and in the allowlist for
 * `env` (see `allowedOrigins` — the dev origins are `TEST_ROUTES`-gated); if
 * `Origin` is absent, fall back to the origin parsed out of `Referer`.
 * Missing BOTH headers, or a value not in the allowlist (including an
 * unparseable `Referer`), fails closed (`false`).
 *
 * ⚠️ GET/HEAD PASSING IS NOT "GET IS ALWAYS SAFE" — there IS one state-changing,
 * session-bearing GET in this app: `GET /verify-email` (src/routes/verify-email.ts)
 * stamps `email_verified_at`. It is a DELIBERATE exception, and safe for reasons
 * specific to it, not because of its method:
 *   - The session cookie is `SameSite=Lax` (src/auth/session.ts), so it does NOT
 *     ride along on cross-site SUB-RESOURCE GETs — an `<img>`/`fetch` from
 *     evil.com reaches the route with no session and gets a 401. Lax attaches the
 *     cookie only to TOP-LEVEL navigations, which is exactly the intended flow:
 *     the user clicking the link in their own inbox.
 *   - Even when forced, the EFFECT is not an attack. The route requires a session
 *     that owns the token and matches the user's current security epoch, so the
 *     most a cross-site trigger can accomplish is causing a user to verify their
 *     OWN address with a token that was emailed to them — the thing they were
 *     going to do anyway.
 * A future state-changing GET would NOT automatically inherit that reasoning.
 * Do not add one without redoing it.
 *
 * ⚠️ M2.3b's `GET /notifications/ws` (src/routes/notifications-ws.ts) IS such a
 * case, and it is why `isAllowedOrigin` below exists: a WebSocket upgrade is a
 * GET that establishes a live, cookie-authenticated connection, and — unlike an
 * ordinary GET — is NOT covered by CORS (the classic "cross-site WebSocket
 * hijacking" vector). That route calls `isAllowedOrigin` directly, never
 * `checkOrigin`; going through `checkOrigin` would make its origin check a
 * silent no-op, since GET always passes here.
 */
export function checkOrigin(env: Env, request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") {
    return true;
  }

  return isAllowedOrigin(env, request);
}

/**
 * The Origin/Referer allowlist check ON ITS OWN, with NO exemption for "safe"
 * HTTP methods — `checkOrigin` above is this PLUS the GET/HEAD bypass that is
 * correct for ordinary CSRF defense but wrong for a route where GET is not
 * actually safe (see the doc comment on `checkOrigin` for why, and the one
 * caller that needs this today).
 */
export function isAllowedOrigin(env: Env, request: Request): boolean {
  const allowed = allowedOrigins(env);

  const origin = request.headers.get("Origin");
  if (origin !== null) {
    return allowed.has(origin);
  }

  const referer = request.headers.get("Referer");
  if (referer === null) {
    return false;
  }

  try {
    return allowed.has(new URL(referer).origin);
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

/**
 * `GET /auth/csrf` — hand the authenticated caller the CSRF token their session
 * must echo in `X-CSRF-Token` on every mutating request (src/auth/csrf.ts).
 *
 * WHY THIS ROUTE EXISTS: the token is `sha256Hex(session.csrfSecret)`, and
 * `csrfSecret` lives ONLY in this Worker's KV session record — the `web` Worker
 * (which renders the forms) can never compute it. Something has to deliver it,
 * and the constraint is that it reach the page over an authenticated,
 * same-origin channel and NEVER via a readable cookie (a cookie the page's JS
 * can read is a cookie an XSS payload can read, and it would also be attached
 * to cross-site requests, defeating the double-submit entirely). So: `web`
 * fetches this over the Service Binding, forwarding the browser's session
 * cookie, and embeds the result in the HTML it renders.
 *
 * ⚠️ Deliberately NOT run through the mutating pipeline (src/auth/pipeline.ts).
 * It is a GET, and the pipeline's CSRF step would demand the very token this
 * route exists to issue. Authentication here is `readSession` PLUS the epoch
 * check below — see that step's note for why `readSession` alone was not enough.
 *
 * ⚠️ Being a GET is safe, and the reasoning is load-bearing — do not "harden"
 * this into something that leaks:
 *   • A cross-site fetch/XHR cannot carry the session cookie (`SameSite=Lax`,
 *     see src/auth/session.ts), so it reads an unauthenticated 401, not a token.
 *   • A top-level cross-site NAVIGATION does carry the cookie, but it lands the
 *     JSON in a document on THIS origin; same-origin policy stops the attacker's
 *     JS from reading it back, and no CORS header is ever sent.
 * Adding `Access-Control-Allow-Origin` here, or relaxing the cookie to
 * `SameSite=None`, would break both of those at once.
 */
import { csrfTokenFor } from "../auth/csrf";
import { destroySession, readSession } from "../auth/session";
import { errorResponse } from "../http/errors";

/**
 * The ONE 401 for every "no usable session" case here: no cookie, an unknown
 * cookie, and a REVOKED session all return this identical status + body.
 *
 * ⚠️ The sameness is the point, and it mirrors src/auth/pipeline.ts's
 * `unauthorized()` exactly: distinguishing "never had a session" from "had one,
 * it was revoked" would tell a caller holding a stolen-but-dead cookie that it
 * was once real. `extraHeaders` carries the cleared cookie on the revocation
 * path — the same accepted asymmetry the pipeline makes (a `Set-Cookie` is
 * observable, but the alternative is leaving the browser to replay a dead token
 * forever, which is worse for the legitimate user and useless to an attacker
 * who already holds the cookie).
 *
 * `Record<string, string>` rather than `HeadersInit`, for the reason spelled out
 * at pipeline.ts's `unauthorized`: this is SPREAD, and spreading a `Headers`
 * instance silently yields `{}` — dropping the cleared cookie with no error.
 */
function loginRequired(extraHeaders: Record<string, string> = {}): Response {
  return errorResponse("LOGIN_REQUIRED", 401, { headers: extraHeaders });
}

/**
 * Handle `GET /auth/csrf`. No usable session -> 401; otherwise 200 with the token.
 *
 * Only the HASH of `csrfSecret` is returned, never the secret: even if the
 * rendered page leaks (logs, a cached HTML response, an XSS read), the secret
 * itself stays server-side and the token cannot be worked back into it.
 */
export async function handleCsrf(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env, request);
  if (session === null) {
    return loginRequired();
  }

  // ---- Security epoch (revocation) ------------------------------------------
  // ⚠️ `readSession` ALONE IS NOT ENOUGH, even though this route is a GET that
  // mutates nothing. Its KV record outlives revocation — bumping a user's epoch
  // (re-signup, "log out everywhere") invalidates every outstanding session
  // WITHOUT enumerating them, which is exactly what makes revocation O(1). So a
  // revoked-but-still-in-KV session resolves here perfectly well.
  //
  // Without this check that session got a 200 + a valid token while a garbage
  // cookie got a 401 — reintroducing, on this route, precisely the oracle
  // src/auth/pipeline.ts goes out of its way to suppress (it makes "no session"
  // and "revoked session" indistinguishable). The token itself was never the
  // risk: it is inert, because any mutation carrying it dies at the pipeline's
  // own epoch step. The leak was the STATUS, plus leaving the dead cookie in the
  // browser to be replayed.
  //
  // Same reasoning, same fix as `GET /verify-email` (src/routes/verify-email.ts),
  // which is the other session-bearing GET and checks the epoch inline for the
  // same reason. Read fresh from the DO, never cached — a revocation honored a
  // cache-TTL late is the window a stolen cookie needs.
  const currentEpoch = await env.USER_SECURITY.getByName(
    session.userId,
  ).getEpoch();
  if (currentEpoch !== session.securityEpoch) {
    // Destroy it rather than merely rejecting it: the KV record is dead
    // server-side from here on, and the cleared cookie (`Max-Age=0`) stops the
    // browser replaying a token that can never succeed again.
    const { cookie } = await destroySession(env, request);
    return loginRequired({ "Set-Cookie": cookie });
  }

  return new Response(JSON.stringify({ csrfToken: await csrfTokenFor(session) }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Per-session and authenticated: never let a shared cache hold it.
      "cache-control": "no-store",
    },
  });
}

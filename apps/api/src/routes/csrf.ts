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
 * route exists to issue. Authentication here is `readSession` and nothing else.
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
import { readSession } from "../auth/session";

/**
 * Handle `GET /auth/csrf`. No session -> 401; otherwise 200 with the token.
 *
 * Only the HASH of `csrfSecret` is returned, never the secret: even if the
 * rendered page leaks (logs, a cached HTML response, an XSS read), the secret
 * itself stays server-side and the token cannot be worked back into it.
 */
export async function handleCsrf(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env, request);
  if (session === null) {
    return new Response(JSON.stringify({ code: "LOGIN_REQUIRED" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
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

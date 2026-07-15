/**
 * The ONLY way this app talks to the `api` Worker.
 *
 * Every call goes over the `API` Service Binding (wrangler.jsonc), i.e.
 * Worker-to-Worker inside Cloudflare — never over the public internet. The api
 * has no public route; this binding is the whole surface.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  1. COOKIE FORWARDING (browser -> api). `env.API.fetch()` builds a BRAND NEW
 *     request; it does not inherit anything from the request the browser made
 *     to us. If we don't copy the `Cookie` header across, the api sees an
 *     anonymous request and `readSession` returns null — every authenticated
 *     call silently 401s.
 *  2. Set-Cookie PROPAGATION (api -> browser). The api is what mints and clears
 *     the session cookie (`Set-Cookie` on signup/login/logout). That header
 *     lands on the response the api hands back to US; unless we copy it onto
 *     the response Astro returns, the browser never receives the cookie and
 *     login "succeeds" while leaving the user logged out. `Set-Cookie` can also
 *     legitimately appear MORE THAN ONCE, so it must be copied with
 *     `getSetCookie()` / `headers.append` — `headers.set(...)` would collapse
 *     multiple cookies into one malformed value.
 *
 * ⚠️ WHERE THE BINDING COMES FROM. `env` is imported from `cloudflare:workers`,
 * NOT read off `Astro.locals.runtime.env` — that property was REMOVED in Astro
 * v6 and THROWS on access under the installed astro@7 ("Astro.locals.runtime.env
 * has been removed in Astro v6. Use `import { env } from "cloudflare:workers"`
 * instead."). Most @astrojs/cloudflare tutorials still show the old form; they
 * are wrong for v14. Importing it here also keeps the binding out of the pages,
 * so there is exactly one place to change if it moves again.
 */
import { env } from "cloudflare:workers";

/** What every call through this module returns. */
export interface ApiResponse<T> {
  status: number;
  /**
   * The parsed JSON body, or `null` when the response had no body / a non-JSON
   * body. ⚠️ `null` is NOT an error signal — `POST /auth/logout` answers 200
   * with a genuinely EMPTY body, so a 2xx with `data: null` is a success. Check
   * `status`, never truthiness of `data`.
   */
  data: T | null;
  /**
   * The RAW response body, exactly as the api sent it. The api's plain-text
   * responses (`GET /health` -> "ok", `GET /verify-email` -> "Email verified")
   * have no JSON to parse, so `data` is null for them and this is the only way
   * to see what actually came back.
   */
  text: string;
  /**
   * Every `Set-Cookie` the api emitted, in order. The caller MUST pass these to
   * `applyCookies` (or copy them onto the outgoing response itself) or the
   * session cookie never reaches the browser.
   */
  setCookies: string[];
}

/**
 * The host used for the URL passed to `env.API.fetch`. A Service Binding
 * dispatches on the BINDING, not on DNS, so this hostname is never resolved and
 * never leaves the runtime — but `fetch` still demands a well-formed absolute
 * URL, so we need some origin. It is deliberately NOT a real domain: nothing
 * should be tempted to point it at one.
 *
 * ⚠️ It is NOT the `Origin` header the api's allowlist checks — that is set
 * separately by `apiFetch`'s callers via `origin`. Do not conflate them.
 */
const SERVICE_ORIGIN = "https://api.internal";

/** Options for a single api call. */
export interface ApiFetchOptions {
  method?: string;
  /** Serialized as a JSON body with the matching content-type. */
  body?: unknown;
  /**
   * The incoming browser request. Its `Cookie` header is forwarded verbatim so
   * the api can resolve the session (see point 1 in the file header). Omitting
   * this makes the call anonymous — only correct for genuinely public reads.
   */
  request?: Request;
  /**
   * Value for the `Origin` header. REQUIRED by the api for any non-GET
   * (apps/api/src/auth/csrf.ts `checkOrigin` fails closed without it, since a
   * Service-Binding request carries no Origin of its own). Pass the web app's
   * own origin — `new URL(Astro.request.url).origin`.
   */
  origin?: string;
  /** The api's per-session CSRF token, echoed as `X-CSRF-Token`. */
  csrfToken?: string;
}

/**
 * Call the api over the Service Binding.
 *
 * Returns the status, the parsed body (or null), and any `Set-Cookie`s. It does
 * NOT throw on non-2xx: the api's error statuses (401/403/409/429) are all
 * meaningful to the pages, which branch on `status` themselves.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<ApiResponse<T>> {
  const { method = "GET", body, request, origin, csrfToken } = options;

  const headers = new Headers();

  // (1) Forward the browser's session cookie. Verbatim and whole: the api parses
  // out `tj_session` itself (apps/api/src/auth/session.ts), and re-serializing
  // only invites subtle corruption of the cookie value.
  const cookie = request?.headers.get("Cookie");
  if (cookie !== null && cookie !== undefined) {
    headers.set("Cookie", cookie);
  }

  // The api's `checkOrigin` allowlist. A Service-Binding request has no Origin
  // unless we set one; without it every non-GET fails closed with a 403.
  if (origin !== undefined) {
    headers.set("Origin", origin);
  }

  if (csrfToken !== undefined) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  // THE Service-Binding hop: dispatched Worker-to-Worker, never over the wire.
  const response = await env.API.fetch(`${SERVICE_ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  // The body can only be consumed ONCE, so read it as text and parse from that
  // string — calling `.json()` here would make `text` unreadable afterwards.
  const text = await response.text();

  return {
    status: response.status,
    data: parseJson<T>(text),
    text,
    // (2) `getSetCookie()` preserves MULTIPLE Set-Cookie headers as distinct
    // entries; `headers.get("Set-Cookie")` would join them with ", " into one
    // unparseable string.
    setCookies: response.headers.getSetCookie(),
  };
}

/**
 * Parse a JSON body, tolerating the ones that aren't.
 *
 * ⚠️ Never assume a 2xx carries JSON. `POST /auth/logout` and
 * `POST /auth/logout-all` return 200 with an EMPTY body, and `GET /health` /
 * `GET /verify-email` return plain text — `response.json()` throws on all of
 * them ("Unexpected end of JSON input"), which would turn a successful logout
 * into a 500. Returns null instead; callers branch on `status`.
 */
function parseJson<T>(text: string): T | null {
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Copy the api's `Set-Cookie`s onto the response Astro is about to return, so
 * the browser actually receives them (see point 2 in the file header).
 *
 * `append`, never `set`: the api may emit more than one cookie, and each needs
 * its own header line.
 *
 * The cookie's own attributes (`HttpOnly; Secure; SameSite=Lax; Domain=...`)
 * are chosen by the api and passed through untouched — do not rewrite them
 * here. In particular `HttpOnly` is why the session cookie (`tj_session`) is
 * invisible to page JS, and the CSRF token is delivered as HTML instead
 * (see src/pages/new-post.astro).
 */
export function applyCookies(headers: Headers, setCookies: string[]): void {
  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie);
  }
}

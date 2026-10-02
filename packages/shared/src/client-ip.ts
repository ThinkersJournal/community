/**
 * Header the `web` Worker sets, on every call over the `API` Service Binding,
 * carrying the ORIGINAL BROWSER'S IP across that hop.
 *
 * ⚠️ WHY THIS EXISTS. `CF-Connecting-IP` does not survive `env.API.fetch()`:
 * that call builds a brand-new Request, so the api sees `headers: {}` for the
 * IP and every rate limiter that keys on it falls back to "unknown" — in
 * production this collapsed `SEARCH_LIMITER` into one global 30/min bucket
 * shared by every client. See apps/web/src/lib/api.ts (sets it) and
 * apps/api/src/http/client-ip.ts (reads it).
 *
 * Declared once, here, so both Workers agree on the literal spelling — the
 * same reasoning as SESSION_COOKIE_NAME in ./cookie.
 */
export const CLIENT_IP_HEADER = 'X-TJ-Client-IP';

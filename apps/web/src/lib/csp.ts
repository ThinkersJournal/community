/**
 * The Content-Security-Policy for public, CACHED pages.
 *
 * ⚠️ WHY THIS FILE MATTERS MORE THAN IT LOOKS. src/pages/[handle]/[slug].astro
 * renders ATTACKER-AUTHORED Markdown, and its output is edge-cached for hours and
 * served to everyone. rehype-sanitize is the first line of defense. This policy
 * is the second — and it is the only one still standing on the day the first has
 * a bug.
 *
 * ⚠️ NO NONCES, AND THE REASON IS THE CACHE. Every viewer of a cached render
 * receives the SAME nonce, so a nonce-based CSP on this page is pure theatre —
 * an attacker reads the nonce out of the cached HTML like anyone else. Cached
 * pages get an ALLOWLIST policy or nothing.
 *
 * ⚠️ `script-src 'self'` — NO 'unsafe-inline'. This is the directive the whole
 * policy exists for, and the layer that still holds if rehype-sanitize ever
 * fails. Astro bundles `<script>` into external modules by default, so nothing
 * here needs inline script. Never add 'unsafe-inline' to this directive.
 *
 * ⚠️ `script-src` ALSO CARRIES `https://static.cloudflareinsights.com`
 * (2026-09-24), and here is the honest accounting for why that does not
 * contradict this file's own "stays minimal because the post pages render
 * attacker-authored markdown" reasoning above: it doesn't stay minimal on
 * that page anymore, and CireSnave chose that trade KNOWINGLY.
 *
 * The origin is Cloudflare's OWN zone-level Web Analytics "Automatic Setup"
 * feature — enabled on this zone in the dashboard (Analytics & Logs > Web
 * Analytics), it auto-injects a `<script type="module"
 * src="https://static.cloudflareinsights.com/beacon.min.js/...">` into every
 * HTML response at the EDGE, after this Worker's response leaves our code.
 * Confirmed by isolating the trigger: it is gated purely on the client's
 * `Accept` header claiming an HTML document (a plain `curl` with no headers
 * never gets it; adding only `Accept: text/html` does — cookies, session,
 * and User-Agent are irrelevant). Confirmed ZONE-WIDE: it appears even on a
 * 404, so it reaches every page this app serves, including
 * `[handle]/[slug].astro`'s attacker-authored-markdown render.
 *
 * PM recommended turning OFF Automatic Setup instead (no CSP change, no
 * trust-surface expansion) — CireSnave chose to widen `script-src` and keep
 * the analytics. **Do not relitigate this**: it is his call, made with the
 * zone-wide/attacker-page reach above stated plainly, not discovered later.
 * If it is ever revisited, disabling Automatic Setup in the dashboard is
 * still the alternative that needs no code change here.
 *
 * ⚠️ `style-src` DOES carry 'unsafe-inline', deliberately. Shiki emits an inline
 * `style` attribute on every token span, and CSP has NO hash/nonce mechanism for
 * style ATTRIBUTES (CSP3's 'unsafe-hashes' would mean enumerating every token
 * colour). This is safe ONLY because of a property of the sanitizer: defaultSchema
 * has no `style` in `attributes`, so USER CONTENT CAN NEVER CARRY ONE — every
 * inline style on the page is app-generated, after sanitize. If that ever changes,
 * this line becomes wrong. Eliminating it (via @shikijs/transformers'
 * transformerStyleToClass + a static stylesheet) is recorded in the plan's
 * Deferred section. test/csp.test.ts pins that 'unsafe-inline' appears in
 * style-src AND NOWHERE ELSE, so the concession cannot quietly spread.
 */

/**
 * The subset of the `Astro` global this helper touches.
 *
 * ⚠️ NOT `APIContext`, and that is a CORRECTION, not a style preference. The
 * plan's text types this as `APIContext` — but `response` is declared on
 * `AstroGlobal` (astro@7.0.9 dist/types/public/context.d.ts:27), NOT on
 * `APIContext`, which starts at :148 and whose own docstring calls it "a subset
 * of the `Astro` global object". `setPublicPageCsp(context: APIContext)` reading
 * `context.response` therefore does not typecheck at all.
 *
 * A structural type is the fix, and it matches the precedent set by
 * src/lib/cache.ts's `CacheContext`: it states exactly what this module touches,
 * it is assignable from the real `Astro` global, and it lets test/csp.test.ts
 * build one without standing up a renderer.
 */
export interface CspContext {
  response: { headers: Headers };
}

/**
 * Cloudflare Turnstile's host — the widget's script (`api.js`), its challenge
 * iframe, and its XHRs all come from here. ONLY the signup page loads Turnstile,
 * so this is added to that page's policy alone (see setPublicPageCsp's
 * `turnstile` opt-in). The shared PUBLIC_PAGE_CSP — which also guards the cached,
 * ATTACKER-AUTHORED post page — stays exactly as tight as it was.
 */
const TURNSTILE_HOST = "https://challenges.cloudflare.com";

/**
 * Cloudflare's own Web Analytics beacon host — see this file's header for
 * the full accounting. Unconditional (unlike `TURNSTILE_HOST`, which is
 * signup-page-only): the zone injects this into EVERY HTML response, so it
 * belongs on both policies or the tighter one would still violate on every
 * page it guards.
 */
const CLOUDFLARE_INSIGHTS_HOST = "https://static.cloudflareinsights.com";

function buildCsp(turnstile: boolean): string {
  return [
    "default-src 'self'",
    // ⚠️ STILL no 'unsafe-inline'. Turnstile's api.js and the Cloudflare
    // Insights beacon are both EXTERNAL scripts (a `src`, not inline code),
    // so a host allowance is all either needs — the property this file
    // exists for is preserved.
    `script-src 'self' ${CLOUDFLARE_INSIGHTS_HOST}${turnstile ? ` ${TURNSTILE_HOST}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Post images come from the R2 custom domain and nowhere else. No `data:`:
    // packages/markdown's schema blocks data: URLs in `src` outright, so allowing
    // them here would only widen what a sanitizer failure could reach.
    "img-src 'self' https://cdn.thinkersjournal.com",
    "font-src 'self'",
    `connect-src 'self'${turnstile ? ` ${TURNSTILE_HOST}` : ""}`,
    // `frame-src` exists ONLY when Turnstile is loaded (its challenge iframe);
    // absent otherwise, so frames fall back to `default-src 'self'`.
    ...(turnstile ? [`frame-src ${TURNSTILE_HOST}`] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Public pages. `buildCsp(false)` — byte-identical to before Turnstile existed. */
export const PUBLIC_PAGE_CSP = buildCsp(false);

/** The signup page only: PUBLIC_PAGE_CSP plus the Turnstile host in
 * script-/connect-/frame-src. */
export const SIGNUP_PAGE_CSP = buildCsp(true);

/**
 * Apply the public-page security headers. Every SSR public page calls this.
 *
 * ⚠️ TOUCHES NO CACHE HEADER, EVER. Cacheability is src/lib/cache.ts's decision
 * and nothing else's — two modules writing cache headers is how a `public`
 * CDN-targeted directive lands on a response nobody meant to cache, and nothing
 * on a response can rescue an edge leak once that happens.
 * test/page-cache-inventory.test.ts (sweep B) enforces this across all of src/.
 */
export function setPublicPageCsp(context: CspContext, opts: { turnstile?: boolean } = {}): void {
  context.response.headers.set(
    "content-security-policy",
    opts.turnstile ? SIGNUP_PAGE_CSP : PUBLIC_PAGE_CSP,
  );
  // Belt-and-braces for the media path too: never let a browser sniff a served
  // byte stream into something executable.
  context.response.headers.set("x-content-type-options", "nosniff");
  context.response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
}

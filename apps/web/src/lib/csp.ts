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

export const PUBLIC_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Post images come from the R2 custom domain and nowhere else. No `data:`:
  // packages/markdown's schema blocks data: URLs in `src` outright, so allowing
  // them here would only widen what a sanitizer failure could reach.
  "img-src 'self' https://cdn.thinkersjournal.com",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Apply the public-page security headers. Every SSR public page calls this.
 *
 * ⚠️ TOUCHES NO CACHE HEADER, EVER. Cacheability is src/lib/cache.ts's decision
 * and nothing else's — two modules writing cache headers is how a `public`
 * CDN-targeted directive lands on a response nobody meant to cache, and nothing
 * on a response can rescue an edge leak once that happens.
 * test/page-cache-inventory.test.ts (sweep B) enforces this across all of src/.
 */
export function setPublicPageCsp(context: CspContext): void {
  context.response.headers.set("content-security-policy", PUBLIC_PAGE_CSP);
  // Belt-and-braces for the media path too: never let a browser sniff a served
  // byte stream into something executable.
  context.response.headers.set("x-content-type-options", "nosniff");
  context.response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
}

/**
 * CACHEABILITY — the ONE place this app decides what the edge may hold.
 *
 * ⚠️⚠️ COOKIE IS NOT IN THE WORKERS CACHE KEY AND DOES NOT TRIGGER BYPASS. ⚠️⚠️
 *
 * That single fact is why this file exists. A logged-in SSR render that does not
 * happen to set a cookie WILL BE CACHED AND SERVED TO EVERYONE — a mass session
 * leak out of a page whose code looks completely ordinary. `Set-Cookie` on the
 * response DOES force a bypass, but relying on that makes correctness depend on
 * a side effect a page has no reason to produce.
 *
 * ⚠️ THE REAL DEFENSE IS ARCHITECTURAL, NOT THIS FILE. Public pages render FULLY
 * ANONYMOUS: they call the api WITHOUT forwarding the browser's Cookie (see
 * src/lib/api.ts's `request` option — omitting it is what makes a call
 * anonymous), so there is no viewer-specific value in the render to leak in the
 * first place. Viewer state (the Edit link, reactions) hydrates CLIENT-SIDE.
 * `markPublicCacheable` refusing to cache a cookie-bearing request is
 * BELT-AND-BRACES for the day someone forgets — not the defense.
 *
 * Its cost is real and accepted: a logged-in viewer forces a render on every
 * public page view. Logged-in traffic is a small fraction of SEO traffic, and
 * the alternative is a session leak.
 *
 * ⚠️ THE ONLY THING THAT PREVENTS AN EDGE LEAK IS NEVER EMITTING A `public`
 * CDN-TARGETED DIRECTIVE. Once `Cloudflare-CDN-Cache-Control: public, …` is on a
 * response, nothing else on that response can rescue it: CF's header precedence
 * puts that header HIGHEST and `Cache-Control` LOWEST, so a `private, no-store`
 * beside it is simply ignored at the edge. Hence the inventory forbids
 * `cache.set(` ANYWHERE under src/ but here — including in COMPONENTS, which can
 * reach `Astro.cache` too and whose opt-in would silently overwrite a page's
 * refusal (`set(false)` is not sticky — see below).
 *
 * ⚠️ CACHEABILITY IS A DECLARED PROPERTY, NOT AN ACCIDENT OF OMISSION. Every
 * page calls EXACTLY ONE of the three helpers below, enforced by
 * test/page-cache-inventory.test.ts. Silence is not permitted — but silence is
 * also SAFE, twice over, because both backstops fail closed:
 *   • at test time, the inventory fails the build for an undeclared page;
 *   • at run time, the @astrojs/cloudflare adapter stamps
 *     `Cloudflare-CDN-Cache-Control: no-store` on any response that never
 *     called `Astro.cache.set(...)` (dist/utils/handler.js, pinned in
 *     test/workers-cache.test.ts). An undeclared page is therefore UNCACHED,
 *     not heuristically cached for two hours.
 *
 * ⚠️ NEVER `s-maxage`. `s-maxage`, `must-revalidate` and `proxy-revalidate`
 * SILENTLY DISABLE stale-while-revalidate (RFC 9111 §4.2.4) — revalidation goes
 * foreground and the cost lever dies with no error anywhere. TTLs are chosen
 * HERE and nowhere else; test/page-cache-inventory.test.ts enforces that.
 *
 * ⚠️ NEVER hand a TTL-less options object to the provider. `set({ tags })` with
 * no `maxAge` emits a BARE `public`, which means RFC 9111 heuristic freshness
 * (two hours) AND defeats Cloudflare's automatic `Authorization` bypass. Both
 * helpers below always pass an explicit `maxAge` + `swr`. Pinned in
 * test/workers-cache.test.ts.
 *
 * ⚠️ NO NONCES. Every viewer of a cached render receives the SAME nonce, so a
 * nonce-based CSP is theatre here.
 */
import { PIPELINE_VERSION } from "@thinkersjournal/markdown";
import { SESSION_COOKIE_NAME } from "@thinkersjournal/shared";

/**
 * The subset of `APIContext` / the `Astro` global these helpers need. Structural
 * rather than importing Astro's type, so the unit tests can build one without a
 * renderer — and so this module states exactly what it touches.
 *
 * Verified assignable from the real `Astro` global (astro@7.0.9): `cache` is
 * `CacheLike`, whose `set` accepts `CacheOptions | CacheHint | LiveDataEntry |
 * false` — a strict superset of what we pass.
 */
export interface CacheContext {
  request: Request;
  response: { headers: Headers };
  cache: { set: (value: false | { maxAge: number; swr: number; tags: string[] }) => void };
}

/**
 * PURGE-INVALIDATED pages (post, profile). Long is CORRECT here precisely
 * because purge exists: a viral post at 1M views/day costs ~24 renders/day
 * (99.998%) instead of ~1440 at a 60s window, and an edit is reflected by a
 * near-instant global purge rather than by waiting out the TTL. That ~24 figure
 * holds ONLY because those pages subscribe to their OWN `post:`/`author:` tags
 * and NOT the platform-wide `listing` tag — subscribing to `listing` would evict
 * them on every platform-wide write, collapsing the ratio back toward per-write.
 */
export const PUBLIC_MAX_AGE = 3600;
export const PUBLIC_SWR = 86400;

/**
 * UNTAGGED, TTL-only pages (sitemap.xml, rss.xml) — the spec's decision #20
 * values. ⚠️ These are the ONLY renders whose api reads may use
 * HYPERDRIVE_CACHED, and the reason is exactly that nothing purges them: a 60s
 * Hyperdrive window is a subset of the 60s staleness already accepted here. Tag
 * one of these pages and that stops being true.
 */
export const FEED_MAX_AGE = 60;
export const FEED_SWR = 600;

/**
 * Whether this request carries per-viewer identity.
 *
 * Deliberately a COOKIE-PRESENCE check, not a session lookup: it must be free,
 * it must not add a Service-Binding hop to every public render, and "might be
 * logged in" is exactly the right question — the safe answer to a maybe is
 * don't cache.
 */
export function hasViewerState(context: CacheContext): boolean {
  const cookie = context.request.headers.get("Cookie");
  if (cookie === null) return false;
  // Name-boundary aware: a bare `includes("tj_session=")` would also match
  // `not_tj_session=x` and silently disable caching for anyone who has one.
  return cookie.split(/;\s*/).some((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`));
}

/**
 * Whether this render is MINTING a session — the request looked anonymous, but
 * the response is handing out a cookie (a successful login/signup).
 *
 * ⚠️ `hasViewerState` CANNOT SEE THIS. It reads the REQUEST, and on a login there
 * is no session yet, so the request is genuinely cookie-free. Cloudflare does
 * bypass its cache when a response carries `Set-Cookie` — but this module's
 * header says relying on that makes correctness depend on a side effect a page
 * has no reason to produce, and depending on it in precisely the case it warns
 * about would be incoherent. So we refuse on our own terms.
 *
 * ⚠️ CALL-TIME, NOT RESPONSE-TIME — know what this does not buy. It sees the
 * response only as it is when the helper runs. Pages declare at the top of
 * frontmatter and apply cookies later, so a cookie minted AFTER the declaration
 * is invisible here and the render is still marked cacheable (pinned in
 * test/cache.test.ts). This closes the gap when the cookie is already applied;
 * it does NOT make "a public page may mint a session" safe. The defense that
 * actually holds is structural: a page that mints a session is markPrivate, and
 * public pages render fully anonymous and never mint cookies at all. A
 * response-time guarantee would need middleware, not a call-time helper.
 */
function mintsSession(context: CacheContext): boolean {
  return context.response.headers.has("set-cookie");
}

/** Whether this render is viewer-specific in any way we can detect. */
function isViewerSpecific(context: CacheContext): boolean {
  return hasViewerState(context) || mintsSession(context);
}

/**
 * Refuse to cache, and say so on the response itself.
 *
 * Two mechanisms, with VERY different reach — do not confuse them:
 *
 *   • `cache.set(false)` is the one that protects the EDGE. It stops the Astro
 *     provider emitting `Cloudflare-CDN-Cache-Control`, so the adapter's
 *     default-deny stamp writes `no-store` instead. This is the real defense.
 *
 *   • ⚠️ The explicit `cache-control` header protects BROWSERS AND INTERMEDIARIES
 *     ONLY — it gives ZERO edge protection, and an earlier version of this
 *     comment overstated it ("covers every cache that never sees that stamp").
 *     Per Cloudflare's documented header precedence,
 *     `Cloudflare-CDN-Cache-Control` is HIGHEST (consumed and stripped by CF)
 *     and `Cache-Control` is LOWEST. So if anything ever emits a `public`
 *     CDN-targeted directive on this response, the edge honours THAT and ignores
 *     the `private, no-store` sitting right beside it.
 *
 * ⚠️ NOTHING ON THE RESPONSE CAN RESCUE AN EDGE LEAK ONCE THE CDN HEADER SAYS
 * `public`. There is no second line of defense at that point. That is why
 * test/page-cache-inventory.test.ts forbids `cache.set(` everywhere under src/
 * except here: preventing the `public` directive from ever being emitted is the
 * only thing that works.
 */
function refuse(context: CacheContext): void {
  context.cache.set(false);
  context.response.headers.set("cache-control", "private, no-store");
}

/**
 * Mark an ANONYMOUS public render cacheable under `tags`. Returns whether it was
 * actually marked — false means a session cookie was present and the render was
 * refused (see the header).
 *
 * ⚠️ THE `pipeline:` TAG IS A PURGE HANDLE, NOT A CACHE-KEY COMPONENT. An
 * earlier draft of this comment claimed that folding `PIPELINE_VERSION` into the
 * tags is what makes "a sanitizer fix is a DEPLOY, not a backfill" true. That
 * reasoning is WRONG and worth correcting in place, because it would invite
 * someone to lean on a guarantee the tag does not provide: a Cache-Tag is an
 * invalidation HANDLE you can purge BY, not an input to the cache key, so
 * changing its value does not by itself strand or invalidate a single entry.
 *
 * The guarantee is real but TRANSITIVE, and it comes from somewhere else: the
 * Worker VERSION is part of the Workers Cache key by default
 * (`cross_version_cache` is set nowhere — pinned in test/workers-cache.test.ts),
 * and the markdown pipeline is bundled INTO this Worker. So bumping
 * PIPELINE_VERSION changes the bundle, which changes the version, which changes
 * the key, and every prior render goes cold on deploy. The tag is not what
 * saves you there.
 *
 * What the tag DOES buy: an explicit lever. It lets a pipeline-wide purge be
 * issued deliberately (T14's hop) WITHOUT a deploy — which the version-in-key
 * mechanism cannot do, since it only acts when you ship.
 */
export function markPublicCacheable(context: CacheContext, tags: string[]): boolean {
  if (isViewerSpecific(context)) {
    refuse(context);
    return false;
  }
  context.cache.set({ maxAge: PUBLIC_MAX_AGE, swr: PUBLIC_SWR, tags: [...tags, `pipeline:${PIPELINE_VERSION}`] });
  return true;
}

/** Mark an UNTAGGED, short-TTL public render cacheable (sitemap.xml, rss.xml). */
export function markFeedCacheable(context: CacheContext): boolean {
  if (isViewerSpecific(context)) {
    refuse(context);
    return false;
  }
  context.cache.set({ maxAge: FEED_MAX_AGE, swr: FEED_SWR, tags: [] });
  return true;
}

/** Declare a page per-viewer and uncacheable. Every authed page calls this. */
export function markPrivate(context: CacheContext): void {
  refuse(context);
}

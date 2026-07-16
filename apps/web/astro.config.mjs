// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import { defineConfig } from "astro/config";

/**
 * The `web` Worker: server-rendered Astro on Cloudflare, talking to the `api`
 * Worker over the `API` Service Binding (see wrangler.jsonc + src/lib/api.ts).
 *
 * ⚠️ VERSION NOTES — verified against the INSTALLED astro@7.0.9 /
 * @astrojs/cloudflare@14.1.3, not against tutorials, which are mostly still
 * written for adapter v9–v12 and are wrong here:
 *
 *   • `platformProxy: { enabled: true }` DOES NOT EXIST in adapter v14 and
 *     passing it is a config error. It was the v9-era mechanism for faking
 *     bindings inside a Node dev server. v14 is built on
 *     `@cloudflare/vite-plugin`, which runs `astro dev` inside REAL workerd, so
 *     bindings (including the `API` Service Binding) are the genuine article
 *     with no proxy to enable. The adapter's `Options` type is
 *     `Pick<PluginConfig, 'auxiliaryWorkers'|'configPath'|'inspectorPort'
 *     |'persistState'|'remoteBindings'>` + a few image/session keys — no
 *     `platformProxy` among them.
 *   • `configPath` defaults to this directory's `wrangler.jsonc`, so the
 *     bindings declared there are what dev and build both see. Not set
 *     explicitly — the default is already correct.
 *
 * ⚠️ WORKERS CACHE — WHAT M1 TASK 12 STEP 1 ACTUALLY FOUND (2026-07-15).
 * Workers Cache shipped 2026-07-06 and Astro's CDN cache-provider API is
 * flagged EXPERIMENTAL, so every shape below was read out of the INSTALLED
 * packages rather than a blog post. Re-run this on any bump of either.
 * PATH TAKEN: **the provider API** — the manual-header fallback was not needed.
 *
 *   • `@astrojs/cloudflare@14.1.3` DOES export `cacheCloudflare` from
 *     `@astrojs/cloudflare/cache` (exports map: `"./cache"`, `"./cache/provider"`).
 *     It returns `{ name: "cloudflare", entrypoint: "@astrojs/cloudflare/cache/provider" }`.
 *   • astro@7.0.9 accepts a TOP-LEVEL `cache: { provider }` (base.js:330,
 *     `CacheSchema`). Verified.
 *   • ⚠️ `routeRules` is TOP-LEVEL (base.js:331), **NOT** `experimental.routeRules`.
 *     `experimental` is a zod STRICT object (clientPrerender, contentIntellisense,
 *     chromeDevtoolsWorkspace, svgOptimizer only), so `experimental.routeRules`
 *     would be a hard config ERROR. We set no routeRules: every page here is
 *     session-bearing, and a route rule would cache authed HTML (see below).
 *   • Runtime is `Astro.cache` / `context.cache` (`CacheLike`):
 *       `set(CacheOptions | CacheHint | LiveDataEntry | false)` — merges across calls
 *       `invalidate({ path?, tags? })` — T14's purge hop
 *       `.tags`, `.options`, `.enabled`
 *     `CacheOptions = { maxAge?, swr?, tags?, lastModified?, etag? }`.
 *     ⚠️ `.enabled` is FALSE in `astro dev` — the object exists but no-ops
 *     (`NoopAstroCache`). Cache behaviour is not observable in dev.
 *   • ⚠️ The provider writes **`Cloudflare-CDN-Cache-Control`**, not
 *     `Cache-Control` (RFC 9213 targeted cache control — Cloudflare honours it
 *     and strips it before the browser sees it). It also auto-appends an
 *     `astro-path:<pathname>` tag to `Cache-Tag`. Both pinned in
 *     test/workers-cache.test.ts.
 *
 * ⚠️ NEVER `s-maxage`. `s-maxage`, `must-revalidate` and `proxy-revalidate`
 * SILENTLY DISABLE stale-while-revalidate (RFC 9111 §4.2.4): revalidation goes
 * FOREGROUND and the whole cost lever dies with no error anywhere. VERIFIED at
 * source: the provider builds directives with astro's
 * `buildCacheControlDirectives`, which emits only `public`, `max-age=N` and
 * `stale-while-revalidate=M` — `s-maxage` is not reachable through this API.
 * (On a TARGETED header `max-age` already IS the CDN's lifetime, so `s-maxage`
 * would be redundant as well as harmful.) test/workers-cache.test.ts asserts the
 * emitted bytes so a bump cannot regress it quietly. The helper in
 * src/lib/cache.ts (T13) is the only place TTLs are chosen — do not set cache
 * headers by hand in a page.
 */
export default defineConfig({
  // Every page here is server-rendered: they read the session cookie and call
  // the api per-request, so nothing may be baked at build time.
  output: "server",

  // Turns `Astro.cache.set({ maxAge, swr, tags })` into the
  // `Cloudflare-CDN-Cache-Control` + `Cache-Tag` response headers that the
  // Workers Cache in front of this Worker reads (see wrangler.jsonc), and
  // `context.cache.invalidate({ tags })` into `cache.purge({ tags })` from
  // `cloudflare:workers` (T14's purge hop). See the version notes above for the
  // verified shapes.
  //
  // ⚠️ THIS LINE IS THE ON/OFF SWITCH FOR THE WHOLE FEATURE, AND IT IS ALSO A
  // SAFETY MECHANISM. Both halves are counter-intuitive, so read both.
  //
  // ⚠️ IT IS THE *ONLY* OFF SWITCH. Not wrangler.jsonc. The adapter's config
  // customizer (dist/wrangler.js:32) does:
  //     cache: needsWorkerCache && !config.cache?.enabled ? { enabled: true } : void 0
  // so with this line present, wrangler.jsonc's `"cache"` block is DECORATIVE:
  // absent -> the adapter injects `{ enabled: true }`; set to `{ enabled: false }`
  // -> ALSO inverted to `{ enabled: true }`. Verified by calling the customizer
  // directly. To turn the cache off you delete THIS line — and if you do, also
  // remove the now-live `"cache"` block from wrangler.jsonc, because without
  // this line that block stops being decorative and becomes the unsafe combo
  // described below.
  //
  // ⚠️ DO NOT REMOVE IT WHILE LEAVING `"cache": { "enabled": true }` IN
  // wrangler.jsonc. The two are COUPLED, and the asymmetry is the whole point:
  //
  //   • Presence of a provider named "cloudflare" here is what sets the
  //     adapter's `needsWorkerCache` (dist/index.js:119), which makes its
  //     request handler stamp `Cloudflare-CDN-Cache-Control: no-store` on any
  //     response that did NOT opt in via `Astro.cache.set(...)`
  //     (dist/utils/handler.js:78). Its own docstring: "so that opting in to the
  //     cache provider never accidentally caches routes that don't use it."
  //     That is DEFAULT-DENY, and it is why enabling the cache before T13's
  //     per-viewer guard exists is safe.
  //
  //   • Remove this line but leave the wrangler flag on, and that stamp
  //     disappears. Pages then emit NO cache directives at all — which is NOT
  //     "uncached": Workers Cache applies RFC 9111 HEURISTIC freshness and
  //     stores every 200 for TWO HOURS. Cookie is not in the cache key and does
  //     not bypass, so an authed render would be cached and served to everyone.
  //     A mass session leak, produced by DELETING a line. Nothing would warn you.
  //
  // test/workers-cache.test.ts pins the pair together for exactly this reason.
  cache: { provider: cacheCloudflare() },

  adapter: cloudflare({
    // ⚠️ NOT the default. Left unset, `imageService` is `"cloudflare-binding"`,
    // which makes the adapter declare an `images: { binding: "IMAGES" }` in the
    // Worker config for Cloudflare to auto-provision at deploy. This app has no
    // images at all in M0, so that would be live infrastructure supporting
    // nothing. `passthrough` serves images as-is and declares no binding.
    // Revisit if/when the app actually renders <Image>.
    imageService: "passthrough",
  }),

  // ⚠️ DELIBERATELY NEUTERED — DO NOT REMOVE THIS BLOCK.
  //
  // Global Constraint: sessions live in the `api` Worker's KV (opaque token ->
  // `sess:<sha256(token)>`, see apps/api/src/auth/session.ts). Astro must never
  // own session state, or we would have two competing session stores and two
  // cookies disagreeing about who is logged in.
  //
  // Astro 7 has NO `session: false` switch (`SessionSchema` is an object whose
  // `driver` is merely optional), and @astrojs/cloudflare@14 does this in its
  // `astro:config:setup` hook:
  //
  //     if (!session?.driver) { session = { driver: sessionDrivers.cloudflareKVBinding(...) } }
  //
  // i.e. leaving `session` unset does NOT mean "off" — it silently opts us into
  // a Cloudflare KV session store AND makes the adapter inject a `SESSION` KV
  // namespace binding into the Worker config, which Cloudflare would then
  // auto-provision at deploy. That is exactly the constraint we are told not to
  // violate.
  //
  // Setting ANY non-KV driver is what actually turns that off: the adapter gates
  // the binding on `usesCloudflareKVSessionDriver(session)`, which compares the
  // driver entrypoint against `unstorage/drivers/cloudflare-kv-binding`. The
  // `memory` driver does not match, so no KV binding is declared and no
  // namespace is provisioned (verified: the generated dist/server/wrangler.json
  // has `"kv_namespaces":[]`). It is also inert by construction — per-isolate,
  // non-persistent, and nothing in this app ever touches `Astro.session`.
  //
  // Spelled as a literal entrypoint rather than the tidier
  // `sessionDrivers.memory()` because Astro 7.0.9's `sessionDrivers` TYPE omits
  // `memory` (and `null`), even though its RUNTIME has them: the value is built
  // by filtering unstorage's `builtinDrivers`, but the shipped .d.ts lists only
  // a subset, so `sessionDrivers.memory()` is a ts(2339) error under
  // `astro check`. This object is precisely what that call returns at runtime
  // (`{ entrypoint: "unstorage/drivers/memory" }`) and matches Astro's own
  // `SessionDriverConfig`, so it type-checks without a suppression. Revisit if
  // the upstream types are fixed.
  session: {
    driver: { entrypoint: "unstorage/drivers/memory" },
  },

  vite: {
    build: {
      // ⚠️ NOT a preference — this DISABLES A BROKEN CODE PATH, and removing it
      // makes `astro build` fail on the second and every later run on Windows
      // with a message that names neither the cause nor the real file:
      //
      //     The property 'options.recursive' is no longer supported. Received true
      //       at Object.rmdirSync (node:fs)
      //       at emptyDir (astro/dist/core/fs/index.js:34)
      //
      // Two upstream defects compound to produce it:
      //   1. `astro build` (via @astrojs/cloudflare -> @cloudflare/vite-plugin)
      //      spawns workerd children and never reaps them. They outlive the
      //      build, are orphaned, and keep open handles on `dist/`. Measured: a
      //      clean build leaves 4 behind.
      //   2. Astro's `emptyDir` therefore gets EPERM from `fs.rmSync` on the
      //      locked dir, and its Windows EPERM fallback calls
      //      `fs.rmdirSync(p, { recursive: true })` — which Node 26 REMOVED. So
      //      the fallback throws a different error, masking the EPERM.
      //
      // Astro consults this exact flag before calling the broken function
      // (`core/build/static-build.js`):
      //
      //     if (settings.config?.vite?.build?.emptyOutDir !== false) {
      //       emptyDir(settings.config.outDir, new Set(".git"));
      //     }
      //
      // so `false` means `emptyDir` is never reached. Neither defect is ours to
      // fix: astro@7.0.9 is the latest release, and @cloudflare/vite-plugin is
      // pinned to 1.44.0 by wrangler's peer range (task-18-report.md §1).
      //
      // ⚠️ THE OUTPUT IS STILL CLEANED — by `scripts/build-web.mjs`, which IS
      // this package's `build` script (see package.json). It removes `dist`
      // itself before building, and reaps the workerd processes astro leaks
      // afterwards, so the build starts from a genuinely empty directory and
      // leaves nothing holding it. Do not set this back to `true`, and do not
      // bypass the `build` script by running `astro build` directly, or stale
      // output silently survives between builds.
      emptyOutDir: false,
    },
  },
});

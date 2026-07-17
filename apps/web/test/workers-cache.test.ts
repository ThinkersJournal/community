import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import cacheProviderFactory from "@astrojs/cloudflare/cache/provider";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * WORKERS CACHE — the config + the provider's ACTUAL emitted headers.
 *
 * ⚠️ WHY THIS FILE EXISTS. Both halves of this feature fail SILENTLY.
 *
 *   1. The `s-maxage` trap. Per RFC 9111 §4.2.4, `s-maxage`, `must-revalidate`
 *      and `proxy-revalidate` SILENTLY DISABLE stale-while-revalidate:
 *      revalidation goes FOREGROUND and the entire cost lever dies with no
 *      error, no warning, and no failing test anywhere. Nothing tells you. The
 *      only way to know is to assert on the bytes the provider actually emits —
 *      which is what the first block below does, against the INSTALLED
 *      @astrojs/cloudflare, not against its docstring.
 *
 *   2. `cross_version_cache`. The Worker version is part of the Workers Cache
 *      key BY DEFAULT, and that default is the ONLY thing that makes
 *      `PIPELINE_VERSION`'s promise true — see the block comment in
 *      wrangler.jsonc. Setting `cross_version_cache: true` would silently turn
 *      "a sanitizer fix invalidates every cached render on deploy" into
 *      fiction, while every test still passed. The second block is a
 *      default-deny backstop against exactly that one-word change.
 *
 * These are pinned against the installed packages on purpose: Workers Cache
 * shipped 2026-07-06 and Astro's CDN cache-provider API is flagged
 * EXPERIMENTAL. A version bump that changes either shape must fail HERE, loudly,
 * rather than in production as a quiet cost regression or a stale-content bug.
 *
 * `jsonc-parser` is a devDependency for exactly one reason: wrangler.jsonc has
 * comments, so `JSON.parse` cannot read it, and stripping comments with a regex
 * would corrupt any string containing `//` (every URL in that file, for one).
 */

describe("the INSTALLED @astrojs/cloudflare cache provider", () => {
  const provider = cacheProviderFactory(undefined);
  const request = new Request("https://thinkersjournal.com/@alice/hello");

  function headersFor(options: Parameters<NonNullable<typeof provider.setHeaders>>[0]) {
    // `setHeaders` is optional on the CacheProvider interface; the Cloudflare
    // provider defines it. If a bump ever drops it, that is a breaking change we
    // want to hear about here rather than discover as an uncached production.
    if (!provider.setHeaders) throw new Error("provider.setHeaders is gone — the emitted-header contract changed");
    return provider.setHeaders(options, request);
  }

  it("identifies as the cloudflare provider", () => {
    expect(provider.name).toBe("cloudflare");
  });

  it("⚠️ emits `max-age` and NEVER `s-maxage` (which would silently kill SWR)", () => {
    const headers = headersFor({ maxAge: 3600, swr: 86400, tags: ["post:1"] });
    const directives = headers.get("cloudflare-cdn-cache-control") ?? "";

    expect(directives).toContain("max-age=3600");
    // ⚠️ THE ASSERTION THIS FILE EXISTS FOR. `s-maxage` must never appear —
    // including as a substring check that `max-age=` alone would not catch.
    expect(directives).not.toContain("s-maxage");
    expect(directives).not.toContain("must-revalidate");
    expect(directives).not.toContain("proxy-revalidate");
  });

  it("emits stale-while-revalidate, and marks the response `public`", () => {
    const directives = headersFor({ maxAge: 3600, swr: 86400 }).get("cloudflare-cdn-cache-control") ?? "";
    expect(directives).toBe("public, max-age=3600, stale-while-revalidate=86400");
  });

  it("⚠️ targets Cloudflare specifically — NOT the generic `Cache-Control`", () => {
    // The provider writes `Cloudflare-CDN-Cache-Control` (RFC 9213 targeted
    // cache control), which Cloudflare honours and STRIPS before the response
    // reaches the browser. Two consequences worth pinning:
    //   • The browser gets no Cache-Control from us, so no browser ever holds a
    //     stale post — freshness on edit is the purge's job alone.
    //   • `max-age` on a TARGETED header already means "the CDN's lifetime", so
    //     `s-maxage` is not merely dangerous here, it is unnecessary.
    const headers = headersFor({ maxAge: 3600, swr: 86400 });
    expect(headers.get("cloudflare-cdn-cache-control")).not.toBeNull();
    expect(headers.get("cache-control")).toBeNull();
  });

  it("passes tags through and appends its own `astro-path:` tag", () => {
    const tags = headersFor({ maxAge: 60, tags: ["post:1", "author:2"] }).get("cache-tag") ?? "";
    expect(tags.split(",")).toEqual(["post:1", "author:2", "astro-path:/@alice/hello"]);
  });

  it("⚠️ emits a BARE `public` when given tags but no TTL — which caches for 2h, not 0", () => {
    // ⚠️ A TRAP, PINNED HERE DELIBERATELY (verified against the installed
    // adapter, not assumed). `set({ tags })` with no `maxAge` does NOT mean
    // "tag it but do not cache it". The provider unconditionally seeds the
    // directive list with `public`, so the response goes out as a bare
    // `public` — no freshness lifetime — and Workers Cache then applies RFC 9111
    // HEURISTIC freshness: a 200 is cached for TWO HOURS. Worse, an explicit
    // `public` is precisely the directive that DEFEATS Cloudflare's automatic
    // `Authorization`-header bypass.
    //
    // So there is no "tags-only, no-cache" shape. The only real opt-out is
    // `cache.set(false)` (which suppresses these headers entirely) or an
    // explicit `cache-control: no-store` on the response. T13's helpers must
    // never hand this provider an options object without a TTL.
    expect(headersFor({ tags: ["x"] }).get("cloudflare-cdn-cache-control")).toBe("public");
  });
});

describe("⚠️ the adapter's DEFAULT-DENY stamp — the basis of 'no authed HTML is cacheable'", () => {
  /**
   * ⚠️ THE SINGLE MOST LOAD-BEARING SHAPE IN THIS FEATURE, AND THE ONE NOTHING
   * ELSE HERE CAN SEE.
   *
   * Every other assertion in this file describes what happens when a page OPTS
   * IN. This one describes what happens when it does not — which is the case for
   * every page that exists today, including the two that render session state.
   *
   * The mechanism lives in the ADAPTER, not in our code:
   *
   *     if (cacheProviderEnabled && !response.headers.has("Cloudflare-CDN-Cache-Control")) {
   *       response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
   *     }
   *
   * Without it, a response carrying no cache directives is NOT uncached: Workers
   * Cache applies RFC 9111 heuristic freshness and stores every 200 for TWO
   * HOURS. Cookie is not in the cache key and does not bypass. So if a version
   * bump drops or reworks this block, authed HTML becomes cacheable and served
   * to everyone — and every other test in this repo STAYS GREEN, because none of
   * them exercise a non-opted-in response through the adapter. It would be found
   * in production, as a mass session leak.
   *
   * ⚠️ WHY SOURCE-READING AND NOT AN IMPORT. `handler.js` cannot be loaded under
   * vitest: it resolves `virtual:astro-cloudflare:config` (a build-time virtual
   * module) and `cloudflare:workers` (a workerd built-in), neither of which
   * exists in Node. Reading the shipped source is the only way to assert on it
   * from here — the same idiom as T3's dispatcher pin.
   *
   * ⚠️ IF THIS FAILS AFTER AN UPGRADE: do NOT delete it and do NOT loosen the
   * match until it passes. Re-read the adapter and answer one question — does a
   * response that never calls `Astro.cache.set(...)` still come back
   * uncacheable? Verify it on the wire (`curl -D -` against `wrangler dev`; every
   * page and the 404 must show `no-store`), then update this assertion to
   * whatever the new mechanism is. If the answer is no, the cache must be turned
   * off (remove `cache: { provider }` from astro.config.mjs — see that file:
   * it is the ONLY off switch) until T13's guard covers every page explicitly.
   */
  const require_ = createRequire(import.meta.url);
  // Resolve via package.json: it is the one path the adapter's `exports` map
  // exposes, so this survives layout changes and pnpm's symlinked store, while
  // `dist/utils/handler.js` is deliberately not exported and cannot be resolved.
  const adapterRoot = dirname(require_.resolve("@astrojs/cloudflare/package.json"));
  const handlerSource = readFileSync(join(adapterRoot, "dist/utils/handler.js"), "utf8");
  const normalized = handlerSource.replace(/\s+/g, " ");

  it("still stamps `no-store` on any response that did not opt in", () => {
    expect(normalized).toContain(
      'if (cacheProviderEnabled && !response.headers.has("Cloudflare-CDN-Cache-Control")) ' +
        '{ response.headers.set("Cloudflare-CDN-Cache-Control", "no-store"); }',
    );
  });

  it("still gates that stamp on the configured provider, not on wrangler's flag", () => {
    // `cacheProviderEnabled` traces to `needsWorkerCache =
    // config.cache?.provider?.name === "cloudflare"` (@astrojs/cloudflare
    // dist/index.js). It is the ASTRO config that arms the stamp — which is why
    // astro.config.mjs's provider line is a safety mechanism and not a
    // convenience, and why the two configs are pinned together below.
    expect(normalized).toContain("cacheProviderEnabled");
  });
});

describe("wrangler.jsonc — the Workers Cache lever", () => {
  type CacheBlock = { enabled?: boolean; cross_version_cache?: boolean };
  const config = parse(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8")) as {
    cache?: CacheBlock;
    compatibility_date?: string;
    env?: Record<string, { cache?: CacheBlock }>;
  };

  /**
   * Every `cache` block in the file, top-level AND per-environment.
   *
   * ⚠️ NOT just the top level. Wrangler's schema hangs `CacheOptions` off BOTH
   * `RawConfig.cache` and `RawEnvironment.cache`, and Cloudflare documents the
   * per-environment override as the TYPICAL pattern — so `env.production.cache.
   * cross_version_cache: true` is the single most likely way this ever gets set,
   * and a top-level-only guard cannot see it.
   */
  const cacheBlocks: Array<[string, CacheBlock]> = [
    ...(config.cache ? [["cache", config.cache] as [string, CacheBlock]] : []),
    ...Object.entries(config.env ?? {}).flatMap(([name, env]) =>
      env?.cache ? [[`env.${name}.cache`, env.cache] as [string, CacheBlock]] : [],
    ),
  ];

  it("has the cache ENABLED", () => {
    expect(config.cache?.enabled).toBe(true);
  });

  it("⚠️ sets `cross_version_cache` NOWHERE — top level or any env — so the Worker version stays in the cache key", () => {
    // ⚠️ DO NOT "FIX" THIS BY ENABLING IT. Worker-version-in-key is what makes a
    // markdown-pipeline change (a rehype-sanitize CVE patch, a schema
    // tightening, a PIPELINE_VERSION bump) atomically invalidate EVERY cached
    // render on deploy — because from T13/T15 the pipeline is bundled INTO this
    // Worker, so changing it changes the version, and every entry goes cold.
    // Turning cross_version_cache on would share entries across versions and
    // leave the old, vulnerable renders being served by the new, patched code.
    // That is the difference between "a sanitizer fix ships instantly" and "a
    // sanitizer fix ships in an hour, maybe". The cost is a cold cache per
    // deploy. Pay it.
    //
    // Asserted over EVERY cache block, not just the top one — see `cacheBlocks`.
    expect(cacheBlocks.length).toBeGreaterThan(0);
    for (const [where, block] of cacheBlocks) {
      expect(block, `${where} must not set cross_version_cache`).not.toHaveProperty("cross_version_cache");
    }
  });

  it("has a compatibility_date at or after Workers Cache's 2026-07-06 ship date", () => {
    // ISO-8601 dates compare correctly as strings.
    expect(config.compatibility_date).toBeDefined();
    expect(config.compatibility_date! >= "2026-07-06").toBe(true);
  });

  it("⚠️ enables the cache ONLY together with astro.config.mjs's provider", async () => {
    // ⚠️ THE COUPLING, AND THE ASYMMETRY THAT MAKES IT DANGEROUS.
    //
    // The adapter stamps `Cloudflare-CDN-Cache-Control: no-store` on every
    // response that did not opt in via `Astro.cache.set(...)` — but ONLY when a
    // provider named "cloudflare" is configured here (`needsWorkerCache` in
    // @astrojs/cloudflare/dist/index.js:119 -> dist/utils/handler.js:78). That
    // stamp is the DEFAULT-DENY the whole design leans on.
    //
    // So `"cache": { "enabled": true }` WITHOUT this provider is the one
    // genuinely unsafe combination: no stamp, no directives, and Workers Cache
    // falls back to RFC 9111 heuristic freshness — every 200 stored for TWO
    // HOURS, cookies neither keyed nor bypassed. Deleting one line in
    // astro.config.mjs would silently arm a mass session leak. This asserts the
    // pair moves together.
    const astroConfig = (await import("../astro.config.mjs")).default as {
      cache?: { provider?: { name?: string } };
    };
    expect(astroConfig.cache?.provider?.name).toBe("cloudflare");
    expect(config.cache?.enabled).toBe(true);
    // ⚠️ 60s, NOT the 5s default — and the reason is genuine work, not a flaky
    // machine. `import("../astro.config.mjs")` cold-loads the @astrojs/cloudflare
    // adapter graph (astro.config.mjs's own imports), which is heavy enough to sit
    // right AT the 5s default: measured 6.6s for this whole file clean, and ~17s
    // cold on a slower machine. T15 tipped it over the edge — this app now also
    // pulls Shiki's grammars in via `@thinkersjournal/markdown` elsewhere in the
    // suite, so the run is heavier by the time this dynamic import fires. Either
    // way it is real I/O, not a hang, so the honest fix is real-I/O time for THIS
    // test (the call the ratelimit/limiter tests already make with 60_000) — NOT a
    // higher GLOBAL testTimeout, which would mask a genuine hang in some future
    // fast test.
    //
    // ⚠️ ALSO measured: this import can genuinely HANG (>60s) if a `wrangler dev`
    // / workerd process is alive — the same "don't touch the adapter while a dev
    // server runs" trap documented in astro.config.mjs and playwright.config.ts.
    // That is an environment error, not this test's business; run the suite with
    // no dev server up.
    //
    // The assertions above are untouched: rename the provider or flip
    // `cache.enabled` and this still reddens (fast — the import succeeds, the
    // expect fails), which is how MUTATION-style tampering is caught here.
  }, 60_000);
});

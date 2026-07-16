import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("wrangler.jsonc — the Workers Cache lever", () => {
  const config = parse(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8")) as {
    cache?: { enabled?: boolean; cross_version_cache?: boolean };
    compatibility_date?: string;
  };

  it("has the cache ENABLED", () => {
    expect(config.cache?.enabled).toBe(true);
  });

  it("⚠️ does NOT set `cross_version_cache` — the Worker version must stay in the cache key", () => {
    // ⚠️ DO NOT "FIX" THIS BY ENABLING IT. Worker-version-in-key is what makes a
    // markdown-pipeline change (a rehype-sanitize CVE patch, a schema
    // tightening, a PIPELINE_VERSION bump) atomically invalidate EVERY cached
    // render on deploy — because the pipeline is bundled INTO this Worker, so
    // changing it changes the version, and every entry goes cold. Turning
    // cross_version_cache on would share entries across versions and leave the
    // old renders being served by the new, patched code. That is the difference
    // between "a sanitizer fix ships instantly" and "a sanitizer fix ships in
    // an hour, maybe". The cost is a cold cache per deploy. Pay it.
    expect(config.cache).not.toHaveProperty("cross_version_cache");
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
  });
});

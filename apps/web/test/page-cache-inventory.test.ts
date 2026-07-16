import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE PAGE CACHEABILITY INVENTORY — a DEFAULT-DENY BACKSTOP for every page.
 *
 * ⚠️ WHY THIS FILE EXISTS. Cookie is NOT in the Workers Cache key and does NOT
 * trigger bypass. A page that renders anything viewer-specific and does not
 * declare itself uncacheable WILL be cached and served to every visitor — a mass
 * session leak, from a page whose code looks entirely ordinary. Nothing about
 * that failure is loud: it passes typecheck, it passes every unit test, and in
 * local dev (where there is no edge cache) it is completely invisible.
 *
 * So no page is allowed to be SILENT about its cacheability. Every page must
 * call exactly one of the three helpers in src/lib/cache.ts, and this file reads
 * the pages' source to enforce it. A NEW page is covered the moment it exists.
 *
 * ⚠️ EXACTLY ONE, not "at least one" — and that is load-bearing rather than
 * tidiness. `Astro.cache.set(false)` is NOT STICKY: astro's `AstroCache.set`
 * clears `#disabled` on any later `set({...})`, so a page that declared itself
 * private and then also declared itself public would end up PUBLIC, silently
 * (proved in test/cache.test.ts). One declaration per page means there is never
 * a second call to undo the first.
 *
 * ⚠️ If you are here because you added a page: the answer is to call
 * markPublicCacheable / markFeedCacheable / markPrivate — not to add an
 * exemption. There is deliberately no exemption list.
 */
const PAGES_DIR = join(import.meta.dirname, "../src/pages");

/** Every page/endpoint file, recursively. */
function pageFiles(dir: string = PAGES_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return /\.(astro|ts)$/.test(entry) ? [full] : [];
  });
}

const HELPERS = ["markPublicCacheable", "markFeedCacheable", "markPrivate"] as const;

/**
 * The one file that legitimately declares nothing: the internal purge endpoint
 * is a POST, and POST bypasses cache unconditionally — which is precisely why
 * the purge hop uses one (src/pages/__internal/purge.ts). Added by Task 14; the
 * entry is harmless until then.
 */
const NOT_A_RENDERED_PAGE = ["__internal/purge.ts"];

const FILES = pageFiles().filter((f) => !NOT_A_RENDERED_PAGE.some((n) => f.replace(/\\/g, "/").endsWith(n)));

describe("every page declares its cacheability", () => {
  it("found pages to check (tripwire — a moved src/pages would pass vacuously)", () => {
    expect(FILES.length).toBeGreaterThan(3);
  });

  it.each(FILES.map((f) => [f.replace(/\\/g, "/").split("/src/pages/")[1]!, f]))(
    "%s calls exactly one cache helper",
    (name, file) => {
      const source = readFileSync(file, "utf8");
      const used = HELPERS.filter((h) => source.includes(`${h}(`));
      expect(
        used,
        `${name} does not declare its cacheability. Call markPublicCacheable(Astro, tags) for an ANONYMOUS public render, markFeedCacheable(Astro) for an untagged short-TTL feed, or markPrivate(Astro) for anything per-viewer. ⚠️ Cookie is NOT in the cache key and does NOT bypass — a page that says nothing and renders viewer state is served to EVERYONE. See src/lib/cache.ts.`,
      ).toHaveLength(1);
    },
  );

  it.each(FILES.map((f) => [f.replace(/\\/g, "/").split("/src/pages/")[1]!, f]))(
    "%s does not set cache headers or call cache.set() directly",
    (name, file) => {
      const source = readFileSync(file, "utf8");
      // Bypassing the helpers is how `s-maxage` (which SILENTLY disables SWR) and
      // an unguarded authed render both get in. One place chooses TTLs.
      expect(source, `${name} calls cache.set() directly — use a helper from src/lib/cache.ts.`).not.toMatch(
        /\bcache\.set\(/,
      );
      // ⚠️ Catches BOTH the standard header AND the real one the Astro provider
      // reads (`Cloudflare-CDN-Cache-Control`, verified in Task 12) — a page
      // hand-setting either is bypassing src/lib/cache.ts.
      expect(source, `${name} sets a cache-control header by hand — use a helper from src/lib/cache.ts.`).not.toMatch(
        /headers\.set\(\s*["'](cache-control|cloudflare-cdn-cache-control)["']/i,
      );
    },
  );
});

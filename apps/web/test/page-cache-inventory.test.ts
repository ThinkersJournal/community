import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE CACHEABILITY INVENTORY — a DEFAULT-DENY BACKSTOP over ALL of `src/`.
 *
 * ⚠️ WHY THIS FILE EXISTS. Cookie is NOT in the Workers Cache key and does NOT
 * trigger bypass. A page that renders anything viewer-specific and does not
 * declare itself uncacheable WILL be cached and served to every visitor — a mass
 * session leak, from a page whose code looks entirely ordinary. Nothing about
 * that failure is loud: it passes typecheck, it passes every unit test, and in
 * local dev (where there is no edge cache) it is completely invisible.
 *
 * Two sweeps, because there are two ways to get it wrong:
 *
 *   A. A PAGE SAYS NOTHING. Every executable file under src/pages must call
 *      exactly one of the three helpers in src/lib/cache.ts. A new page is
 *      covered the moment it exists; there is deliberately no exemption list.
 *
 *   B. ⚠️ SOMETHING UNDER src/ REACHES PAST THE HELPERS. This is the sweep that
 *      matters most, and the one an earlier version of this file MISSED.
 *      `AstroGlobal` exposes `cache: CacheLike` (astro/dist/types/public/
 *      context.d.ts:217), so ANY .astro COMPONENT OR LAYOUT — not just a page —
 *      can call `Astro.cache.set()`. Chained with the non-stickiness proved in
 *      test/cache.test.ts, that is a mass-leak path:
 *
 *          markPrivate(Astro)      // set(false) + cache-control: private, no-store
 *          <SomeComponent />       // Astro.cache.set({ maxAge: 3600, ... })
 *          => cloudflare-cdn-cache-control: public, max-age=3600, s-w-r=86400
 *          => cache-control: private, no-store   <-- IGNORED BY THE EDGE
 *
 *      The page's own refusal is silently overwritten by a component it renders,
 *      and the `cache-control` header sitting right beside it does NOT save you:
 *      per Cloudflare's header precedence, `Cloudflare-CDN-Cache-Control` is
 *      HIGHEST (consumed and stripped by CF) and `Cache-Control` is LOWEST. So
 *      sweep B forbids `cache.set(` and hand-set cache headers EVERYWHERE under
 *      src/, with exactly one exemption: src/lib/cache.ts itself.
 *
 * ⚠️ If you are here because you added a page: the answer is to call
 * markPublicCacheable / markFeedCacheable / markPrivate — not to add an
 * exemption.
 *
 * ⚠️ WHAT SWEEP A DOES AND DOES NOT PROVE. It is a SOURCE-TEXT match, not an AST
 * walk and not a runtime assertion. Comments are stripped before matching (so a
 * helper named only in prose does not count), but a call in a DEAD BRANCH
 * (`if (false) markPrivate(Astro)`) would still satisfy it. It proves "this file
 * mentions exactly one helper in live-looking code" — NOT "this file calls
 * exactly one helper on every path". That residual is acceptable only because it
 * fails closed at run time: a page that never actually calls a helper emits no
 * opt-in, so the adapter stamps `Cloudflare-CDN-Cache-Control: no-store` (pinned
 * in test/workers-cache.test.ts; observed on the wire against a built Worker —
 * see the task report). Sweep A enforces a declaration habit. The adapter stamp,
 * not this file, is the guarantee.
 */
const SRC_DIR = join(import.meta.dirname, "../src");
const PAGES_DIR = join(SRC_DIR, "pages");

/** The ONE module allowed to touch `cache.set` / cache headers directly. */
const CACHE_MODULE = "lib/cache.ts";

/** Every file under `dir`, recursively, WHATEVER its extension. */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

/** Path relative to `from`, forward slashes, for stable test names. */
function rel(file: string, from: string): string {
  return file.replace(/\\/g, "/").split(`${from}/`)[1] ?? file;
}

/**
 * Extensions that CANNOT reach `Astro.cache.set()` — no executable frontmatter,
 * no imports, no expressions. Such a file cannot opt into the cache, so it fails
 * closed on its own (no opt-in => the adapter stamps `no-store`) and is not
 * required to declare anything.
 *
 * ⚠️ DEFAULT-DENY: THIS LIST IS AN ALLOWLIST OF INERTNESS. Anything not named
 * here is treated as executable and MUST declare. That inversion is the point.
 * The previous version filtered FOR `/\.(astro|ts)$/`, which silently ignored
 * every other extension — a `.js`/`.mjs` endpoint calling
 * `context.cache.set({ maxAge })` would never have been scanned at all. That is
 * the same class of miss as M0's parameterized-route gap and T12's `env.*` gap:
 * a tripwire that cannot see the shape it is meant to catch. An unknown
 * extension must fail LOUDLY and be classified by a human.
 *
 * ⚠️ `.mdx` is deliberately absent: it runs ESM imports and JSX expressions, so
 * it CAN reach `cache.set`.
 */
const INERT_EXTENSIONS = new Set([
  ".md",
  ".html",
  ".css",
  ".txt",
  ".xml",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
]);

/** Extensions we have classified as executable — they must declare. */
const EXECUTABLE_EXTENSIONS = [".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".mdx"];

/**
 * Strip comments so a helper NAMED IN PROSE cannot satisfy sweep A.
 *
 * The line-comment rule refuses to fire after a `:` so URLs (`https://…`)
 * survive. It is a heuristic over source text — a `//` inside a non-URL string
 * literal would over-strip — but over-stripping can only DROP a match, i.e. fail
 * closed into "you did not declare". It can never invent one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const HELPERS = ["markPublicCacheable", "markFeedCacheable", "markPrivate"] as const;

const executable = (f: string) => !INERT_EXTENSIONS.has(extname(f));

const PAGE_FILES = allFiles(PAGES_DIR);
const SRC_FILES = allFiles(SRC_DIR).filter((f) => rel(f, "src") !== CACHE_MODULE);

describe("SWEEP A — every page declares its cacheability", () => {
  it("found pages to check (tripwire — a moved src/pages would pass vacuously)", () => {
    expect(PAGE_FILES.length).toBeGreaterThan(3);
  });

  it.each(PAGE_FILES.map((f) => [rel(f, "src/pages"), f]))("%s has a CLASSIFIED file type", (name, file) => {
    // ⚠️ DEFAULT-DENY ON THE EXTENSION ITSELF. A file type nobody has classified
    // is not silently skipped — it lands here, and a human decides whether it can
    // reach `cache.set`.
    const ext = extname(file);
    expect(
      INERT_EXTENSIONS.has(ext) || EXECUTABLE_EXTENSIONS.includes(ext),
      `${name} has unclassified extension "${ext}". If it can call Astro.cache.set() add it to EXECUTABLE_EXTENSIONS (and declare a helper in the file); if it provably cannot, add it to INERT_EXTENSIONS. Do not leave it unscanned.`,
    ).toBe(true);
  });

  it.each(PAGE_FILES.filter(executable).map((f) => [rel(f, "src/pages"), f]))(
    "%s calls exactly one cache helper",
    (name, file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      const used = HELPERS.filter((h) => source.includes(`${h}(`));
      expect(
        used,
        `${name} does not declare its cacheability. Call markPublicCacheable(Astro, tags) for an ANONYMOUS public render, markFeedCacheable(Astro) for an untagged short-TTL feed, or markPrivate(Astro) for anything per-viewer. ⚠️ Cookie is NOT in the cache key and does NOT bypass — a page that says nothing and renders viewer state is served to EVERYONE. See src/lib/cache.ts.`,
      ).toHaveLength(1);
    },
  );
});

describe("⚠️ SWEEP B — nothing under src/ reaches past src/lib/cache.ts", () => {
  it("found source files to check (tripwire)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(3);
  });

  it.each(SRC_FILES.filter(executable).map((f) => [rel(f, "src"), f]))(
    "%s does not call cache.set() directly",
    (name, file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      // ⚠️ THE COMPONENT VECTOR. Any .astro component or layout can call
      // `Astro.cache.set()` and silently overwrite the page's refusal —
      // `set(false)` is NOT sticky (proved in test/cache.test.ts). One module
      // chooses cacheability, and it is src/lib/cache.ts.
      expect(
        source,
        `${name} calls cache.set() directly — use a helper from src/lib/cache.ts. ⚠️ A component that opts into the cache OVERWRITES the page's refusal: set(false) is not sticky, and the page's cache-control header does NOT save you (Cloudflare-CDN-Cache-Control outranks it at the edge).`,
      ).not.toMatch(/\bcache\.set\(/);
    },
  );

  it.each(SRC_FILES.filter(executable).map((f) => [rel(f, "src"), f]))(
    "%s does not set cache headers by hand",
    (name, file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      // Catches BOTH the standard header AND the real one the Astro provider
      // reads (`Cloudflare-CDN-Cache-Control`, verified in Task 12).
      expect(source, `${name} sets a cache-control header by hand — use a helper from src/lib/cache.ts.`).not.toMatch(
        /headers\.set\(\s*["'](cache-control|cloudflare-cdn-cache-control)["']/i,
      );
    },
  );
});

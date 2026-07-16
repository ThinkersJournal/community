import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE FEED PAGES — src/pages/sitemap.xml.ts + src/pages/rss.xml.ts.
 *
 * ⚠️ WHY THIS IS A SOURCE/STRUCTURE TEST, NOT A RENDER. Same reason as
 * post-page.test.ts / profile-page.test.ts: this app's vitest is plain Node
 * (vitest.config.ts), and these pages import `cloudflare:workers` (via
 * src/lib/api.ts) and read `context.cache`, neither of which exists outside the
 * Workers pool. What THIS file pins is the set of load-bearing invariants
 * otherwise enforced only by review and invisible to every other test — the XML
 * BODIES themselves (escaping, well-formedness) are separately proven, against
 * REAL data, in test/xml.test.ts, which needs no runtime binding at all because
 * that logic was deliberately factored out of these two files (see
 * src/lib/xml.ts's header).
 *
 * ⚠️ ANTI-VACUITY: every negative assertion below is preceded by a POSITIVE one
 * proving we are looking at the real construct — a bare `not.toContain` over
 * source text that moved would pass while proving nothing.
 */
const PAGES_DIR = join(import.meta.dirname, "../src/pages");
const SITEMAP = join(PAGES_DIR, "sitemap.xml.ts");
const RSS = join(PAGES_DIR, "rss.xml.ts");

/** Same technique as post-page.test.ts / page-cache-inventory.test.ts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const sitemapCode = stripComments(readFileSync(SITEMAP, "utf8"));
const rssCode = stripComments(readFileSync(RSS, "utf8"));

describe.each([
  ["sitemap.xml.ts", SITEMAP, sitemapCode, "application/xml; charset=utf-8"],
  ["rss.xml.ts", RSS, rssCode, "application/rss+xml; charset=utf-8"],
] as const)("%s", (name, file, code, contentType) => {
  it("does not live behind a `_`-prefixed segment (Astro's router silently skips those)", () => {
    // Both are top-level under src/pages, so this is a tripwire against a future
    // move, not a live risk today — but post-page.test.ts's full-tree walk
    // already covers every file under src/pages including these two, so a
    // regression here would already be caught there. Stated explicitly anyway:
    // T14's whole incident was a route that 404'd with every unit test green.
    const segment = name.replace(/\.ts$/, "");
    expect(segment.startsWith("_")).toBe(false);
  });

  it("declares `prerender = false` (this must run per-request, not build once)", () => {
    expect(code).toContain("export const prerender = false");
  });

  it(`answers with content-type "${contentType}", not text/html`, () => {
    // Positive: the literal is present at all.
    expect(code).toContain(contentType);
    // Negative: nothing on this route falls back to Astro's default HTML type.
    expect(code).not.toMatch(/["']text\/html["']/);
  });

  it("declares its cacheability via markFeedCacheable (untagged, short-TTL)", () => {
    expect(code).toContain("markFeedCacheable(");
    // Not markPublicCacheable/markPrivate — those are the OTHER two helpers
    // page-cache-inventory.test.ts's sweep A would also accept; this file wants
    // the SPECIFIC one appropriate to an untagged feed.
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markPrivate(");
  });

  it("⚠️ is ANONYMOUS by construction — apiFetch is never given a `request`", () => {
    // Positive: the api call exists.
    const call = /apiFetch<[^(]*\(([^;]*)\);/.exec(code);
    expect(call, "no apiFetch(...) call found — has this page stopped reading /public/recent?").not.toBeNull();
    // Negative, SCOPED to the apiFetch call itself (not e.g. markFeedCacheable's
    // OWN, unrelated `request: context.request` — that one only lets the cache
    // helper check for a session Cookie; it never reaches the api). No call
    // forwards the browser's Cookie to apiFetch: a feed that varied by viewer
    // would be cached under one viewer and served to every crawler/reader.
    expect(call![1]).not.toMatch(/request:\s*context\.request/);
  });

  it("⚠️ sets NO Content-Security-Policy — setPublicPageCsp is an HTML-only concern", () => {
    // CSP directives (script-src, style-src, img-src, ...) govern a browser
    // RENDERING context; an application/xml or application/rss+xml response is
    // never executed as a page by a spec-compliant client, so there is no
    // script-execution surface for a CSP to constrain. The injection defense for
    // this content type is escapeXml (src/lib/xml.ts), proven in xml.test.ts.
    expect(code).not.toContain("setPublicPageCsp(");
  });

  it("builds its body via src/lib/xml.ts, not by hand-interpolating post data inline", () => {
    expect(code).toMatch(/from "\.\.\/lib\/xml"/);
  });

  it("⚠️ handles an APIRoute context correctly — no bare `context` handed to a cache helper", () => {
    // `APIContext` (what an endpoint's GET receives) has NO `.response` — only
    // `AstroGlobal` (what an .astro PAGE gets) does. Passing `context` straight
    // through to markFeedCacheable would not type-check; the fix (same one
    // src/pages/internal/purge.ts and src/pages/media-upload.ts use) is a real
    // Headers object wrapped in a CacheContext-shaped literal.
    expect(code).toMatch(/response:\s*\{\s*headers\s*\}/);
    expect(code, `${file} calls a cache helper with the bare context object, which does not type-check against CacheContext (APIContext has no .response).`).not.toMatch(
      /markFeedCacheable\(context\)/,
    );
  });
});

describe("the RSS discovery link on the public HTML pages", () => {
  const PROFILE_PAGE = join(PAGES_DIR, "[handle]", "index.astro");
  const POST_PAGE = join(PAGES_DIR, "[handle]", "[slug].astro");

  it.each([
    ["[handle]/index.astro", PROFILE_PAGE],
    ["[handle]/[slug].astro", POST_PAGE],
  ])("%s advertises /rss.xml via <link rel=\"alternate\">", (_name, file) => {
    const code = stripComments(readFileSync(file, "utf8"));
    expect(code).toMatch(/<link\s+rel="alternate"\s+type="application\/rss\+xml"[^>]*href="\/rss\.xml"/);
  });
});

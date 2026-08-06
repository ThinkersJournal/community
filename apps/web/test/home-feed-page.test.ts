import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/feed.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("feed.astro", () => {
  it("declares markPrivate (per-viewer, never cacheable) and nothing else", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("forwards the browser cookie to /feed (it is per-viewer)", () => {
    const call = /apiFetch<[^;]*\/feed[^;]*\);/.exec(code);
    expect(call, "feed page does not call /feed").not.toBeNull();
    expect(call![0]).toMatch(/request:\s*Astro\.request/);
  });

  it("redirects a logged-out viewer to /login", () => {
    expect(code).toMatch(/["']\/login["']/);
  });

  /**
   * ⚠️ THE SAFE-REDIRECT REGRESSION GUARD. `Astro.redirect()` builds its OWN
   * `Response` and does NOT carry `Astro.response.headers` — any `Set-Cookie`
   * the api emitted on this 401 (a stale/expired session can be CLEARED on
   * this reachable path) would be silently dropped, same class of bug
   * login.astro's and choose-username.astro's headers warn about at length.
   * The fix, mirrored from those two pages: build the 302 by hand and apply
   * cookies to IT, not to `Astro.response.headers`.
   */
  it("⚠️ does NOT use Astro.redirect for the 401 case — builds a manual 302 and applies cookies to it", () => {
    // Negative: the naive, cookie-dropping form is never used for this page's
    // login bounce.
    expect(code).not.toMatch(/Astro\.redirect\(\s*["']\/login["']/);
    // Positive, mirroring login.astro / choose-username.astro's idiom: a
    // hand-built Response with a 302 status and a Location header...
    expect(code).toMatch(/status:\s*302/);
    expect(code).toMatch(/Location:\s*["']\/login["']/);
    // ...that has cookies applied to IT (the manual redirect), not to
    // Astro.response.headers.
    expect(code).toMatch(/applyCookies\(\s*redirect\.headers/);
  });

  it("links its empty state to /authors discovery", () => {
    expect(code).toContain("/authors");
  });

  it("also offers the public Discover feed from its empty state", () => {
    expect(code).toContain('href="/"');
    expect(code).toContain("browse Discover");
  });

  it("pages older posts via a ?cursor= link", () => {
    expect(code).toMatch(/\/feed\?cursor=/);
  });

  it("adopts the chrome + CSP while staying markPrivate", () => {
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("markPrivate(");
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /feed route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/feed"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});

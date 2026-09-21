import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE CUSTOM 404 (#79). Astro serves `src/pages/404.astro` automatically,
 * with a real 404 status, for any request matching no route at all — see
 * that file's own header for the verified mechanism. Before this file
 * existed, Astro's unbranded default fallback rendered with no nav/footer,
 * stranding a reader with no way back to the site.
 *
 * Source-level pins, same convention as post-page.test.ts /
 * page-cache-inventory.test.ts (this app's vitest is plain Node — no
 * renderer here to assert the actual rendered HTML/status against).
 */

const PAGE = join(import.meta.dirname, "../src/pages/404.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const code = stripComments(readFileSync(PAGE, "utf8"));

describe("404.astro", () => {
  it("uses PageLayout (nav + footer + branding come from BaseLayout underneath it)", () => {
    // Positive presence of the shell that was MISSING in Astro's own default
    // fallback — the whole point of #79.
    expect(code).toMatch(/<PageLayout\s/);
    expect(code).toMatch(/import\s+PageLayout\s+from\s+["']\.\.\/components\/PageLayout\.astro["']/);
  });

  it("⚠️ declares itself markPrivate, and ONLY markPrivate — a 404 must never be edge-cacheable", () => {
    // Positive: the one helper this page must call (page-cache-inventory.test.ts's
    // sweep A already enforces "exactly one somewhere in this file"; this names
    // WHICH one, and that it's the deliberate choice, not an accident of which
    // helper happened to be imported first).
    expect(code).toContain("markPrivate(Astro)");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("applies the public-page CSP", () => {
    expect(code).toContain("setPublicPageCsp(Astro)");
  });

  it("gives at least one route back to the site", () => {
    expect(code).toMatch(/href="\/"/);
  });

  it("⚠️ never echoes the raw requested path in a debug box — no Astro.url/Astro.request read at all", () => {
    // The issue's explicit trap: Astro's own default fallback renders the
    // requested path in a dev-error-styled box. This page must not reproduce
    // that pattern even in prose — the simplest guarantee is that it never
    // reads the request/URL to begin with.
    expect(code).not.toMatch(/Astro\.url/);
    expect(code).not.toMatch(/Astro\.request/);
  });

  it("never set:html's anything — this page has no markdown/user content to render", () => {
    expect(code).not.toMatch(/set:html/);
  });
});

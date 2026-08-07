import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () =>
  readFileSync(join(import.meta.dirname, "../src/pages/index.astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("home page (the Discover feed)", () => {
  it("is anonymous + edge-cacheable via the reserved `listing` tag (one cache helper)", () => {
    const s = src();
    expect(s).toMatch(/markPublicCacheable\(Astro,\s*\[\s*["']listing["']/);
    expect(s).not.toContain("markPrivate(");
    expect(s).not.toContain("markFeedCacheable(");
  });
  it("sets the public CSP and uses the shared page chrome", () => {
    const s = src();
    expect(s).toContain("setPublicPageCsp(Astro)");
    expect(s).toMatch(/<PageLayout\s/);
  });
  it("reads the site-wide Discover feed ANONYMOUSLY (apiFetch without request)", () => {
    const s = src();
    expect(s).toContain("/public/discover");
    expect(s).toContain("apiFetch");
    expect(s).not.toMatch(/apiFetch<[^>]*>\([^)]*request:/); // no cookie forwarded
  });
  it("renders escaped excerpts (markdownExcerpt, never set:html) and a keyset pager", () => {
    const s = src();
    expect(s).toContain("markdownExcerpt");
    expect(s).not.toContain("set:html");
    expect(s).toMatch(/\/\?cursor=/);
  });
  it("renders tag chips per Discover card, linking to /tag/<slug> with encodeURIComponent on the slug", () => {
    const s = src();
    // Positive anchor: post.tags is actually mapped, then the exact chip-link
    // shape — encodeURIComponent'd slug, escaped label, never set:html.
    expect(s).toMatch(/post\.tags\.map\(/);
    expect(s).toMatch(/href=\{`\/tag\/\$\{encodeURIComponent\(t\.slug\)\}`\}/);
    expect(s).toContain("{t.label}");
    expect(s).not.toContain("set:html");
  });

  it("fails closed (uncached 503) on a non-200 upstream response instead of caching an empty homepage", () => {
    const s = src();
    // a non-200/null-data guard returns a 503 BEFORE the cache helper...
    expect(s).toMatch(/response\.status !== 200/);
    expect(s).toContain("status: 503");
    // ...and the old swallow-to-empty ternary fallback is gone (a transient error
    // must not be rendered as an empty feed and cached).
    expect(s).not.toMatch(/:\s*\{\s*posts:\s*\[\s*\]/);
  });
});

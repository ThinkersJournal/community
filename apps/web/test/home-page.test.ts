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
});

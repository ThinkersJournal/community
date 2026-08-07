import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () =>
  readFileSync(join(import.meta.dirname, "../src/pages/tags.astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("tags index page (/tags)", () => {
  it("is anonymous + edge-cacheable under the reserved `listing` tag (one cache helper)", () => {
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
  it("reads the tag index ANONYMOUSLY (apiFetch without request)", () => {
    const s = src();
    expect(s).toContain("/public/tags");
    expect(s).toContain("apiFetch");
    expect(s).not.toMatch(/apiFetch<[^>]*>\([^)]*request:/); // no cookie forwarded
  });
  it("links each tag to its /tag/<slug> listing, escaped, never set:html", () => {
    const s = src();
    expect(s).toContain("/tag/");
    expect(s).not.toContain("set:html");
  });
});

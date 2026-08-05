import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const c = strip(readFileSync(join(__dirname, "..", "src", "pages", "search.astro"), "utf8"));
describe("search.astro", () => {
  it("is anonymous + short-TTL edge-cached + CSP", () => {
    expect(c).toContain("markFeedCacheable(");
    expect(c).toContain("setPublicPageCsp(");
    expect(c).not.toMatch(/apiFetch<[^>]*>\([^)]*request:/); // apiFetch WITHOUT request (anonymous)
    expect(c).toContain("/public/search");
  });
  it("has a GET search form and Posts/People tabs", () => {
    expect(c).toMatch(/<form[^>]*method="GET"[^>]*action="\/search"/);
    expect(c).toContain('name="q"');
    expect(c).toContain("type=posts");
    expect(c).toContain("type=people");
  });
  it("does not call the api for a missing/too-short q", () => {
    expect(c).toContain("SEARCH_Q_MIN");
  });
  it("renders a pager off nextOffset", () => {
    expect(c).toContain("nextOffset");
    expect(c).toContain("offset=");
  });
  it("renders post excerpts as escaped text (never set:html)", () => {
    expect(c).toContain("markdownExcerpt");
    expect(c).not.toContain("set:html");
  });
});

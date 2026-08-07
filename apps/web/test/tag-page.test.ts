import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () =>
  readFileSync(join(import.meta.dirname, "../src/pages/tag/[slug].astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("tag page (/tag/[slug])", () => {
  it("is anonymous + edge-cacheable via the `tag:<slug>` tag (one cache helper, byte-matches the api purge literal)", () => {
    const s = src();
    expect(s).toMatch(/markPublicCacheable\(Astro,\s*\[\s*`tag:/);
    expect(s).not.toContain("markPrivate(");
    expect(s).not.toContain("markFeedCacheable(");
  });
  it("sets the public CSP and uses the shared page chrome", () => {
    const s = src();
    expect(s).toContain("setPublicPageCsp(Astro)");
    expect(s).toMatch(/<PageLayout\s/);
  });
  it("reads the tag ANONYMOUSLY (apiFetch without request)", () => {
    const s = src();
    expect(s).toContain("/public/tag");
    expect(s).toContain("apiFetch");
    expect(s).not.toMatch(/apiFetch<[^>]*>\([^)]*request:/); // no cookie forwarded
  });
  it("renders escaped excerpts (markdownExcerpt, never set:html) and a keyset pager with a Newest back-link", () => {
    const s = src();
    expect(s).toContain("markdownExcerpt");
    expect(s).not.toContain("set:html");
    expect(s).toMatch(/\?cursor=/);
    expect(s).toContain("← Newest");
  });
  it("fails closed (uncached 503) on a non-200 upstream response", () => {
    const s = src();
    expect(s).toMatch(/response\.status !== 200/);
    expect(s).toContain("status: 503");
  });
  it("percent-encodes every interpolated URL segment", () => {
    const s = src();
    expect(s).toContain("encodeURIComponent");
  });
});

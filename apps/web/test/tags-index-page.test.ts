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
  it("fails closed (uncached 503) on a non-200 upstream response instead of caching an empty tag list", () => {
    const s = src();
    // a non-200/null-data guard returns a 503 BEFORE the cache helper...
    expect(s).toMatch(/response\.status !== 200/);
    expect(s).toContain("status: 503");
    // ...and the 503 return must appear BEFORE markPublicCacheable in source order, so a
    // future edit can't hoist the cache call above the guard (the cache tag here is the
    // static literal "listing", so nothing structurally prevents that but this check).
    expect(s.indexOf("status: 503")).toBeGreaterThan(-1);
    expect(s.indexOf("status: 503")).toBeLessThan(s.indexOf("markPublicCacheable(Astro"));
  });
});

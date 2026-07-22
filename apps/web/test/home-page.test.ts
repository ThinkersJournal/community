import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () =>
  readFileSync(join(import.meta.dirname, "../src/pages/index.astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("home page (themed landing)", () => {
  it("is now anonymous + cacheable (markPublicCacheable), one cache helper", () => {
    const s = src();
    expect(s).toContain("markPublicCacheable(Astro,");
    expect(s).not.toContain("markPrivate(");
  });
  it("sets the public CSP and uses the shared chrome", () => {
    const s = src();
    expect(s).toContain("setPublicPageCsp(Astro)");
    expect(s).toMatch(/<PageLayout\s/);
  });
  it("keeps the /authors and /feed links and is anonymous (no apiFetch)", () => {
    const s = src();
    expect(s).toContain('href="/authors"');
    expect(s).toContain('href="/feed"');
    expect(s).not.toContain("apiFetch");
  });
});

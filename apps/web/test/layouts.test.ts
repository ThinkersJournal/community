import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const C = (name: string) => readFileSync(join(import.meta.dirname, "../src/components", name), "utf8");

describe("BaseLayout", () => {
  const s = () => C("BaseLayout.astro");
  it("is the shell: html/head[BaseHead + named head slot]/body[Nav + main slot + Footer]", () => {
    const src = s();
    expect(src).toContain("<html");
    expect(src).toMatch(/<BaseHead\s/);
    expect(src).toMatch(/<slot\s+name="head"\s*\/>/);
    expect(src).toMatch(/<Nav\s*\/>/);
    expect(src).toMatch(/<main>[\s\S]*<slot\s*\/>[\s\S]*<\/main>/);
    expect(src).toMatch(/<Footer\s*\/>/);
  });
  it("renders no cache-control/cache.set (SWEEP B — components are markup-only)", () => {
    const src = s();
    expect(src).not.toContain("cache.set");
    expect(src).not.toMatch(/mark(Private|PublicCacheable|FeedCacheable)/);
  });
});

describe("PageLayout", () => {
  it("wraps BaseLayout + a band hero with eyebrow/heading/intro", () => {
    const src = C("PageLayout.astro");
    expect(src).toMatch(/<BaseLayout\s/);
    expect(src).toContain("SectionLabel");
    expect(src).toMatch(/class="band"/);
    expect(src).toMatch(/<slot\s*\/>/);
  });
});

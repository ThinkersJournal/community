import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const C = (name: string) =>
  readFileSync(join(import.meta.dirname, "../src/components", name), "utf8");

describe("Wordmark", () => {
  const src = () => C("Wordmark.astro");
  it("uses a size CLASS, not an inline style attribute", () => {
    expect(src()).not.toMatch(/style=\{/);
    expect(src()).toMatch(/size\??:\s*['"]lg['"]\s*\|\s*['"]sm['"]/);
  });
  it("renders the wordmark text + green dot from tokens", () => {
    expect(src()).toContain("Thinker");
    expect(src()).toContain("var(--head)");
    expect(src()).toContain("var(--green-glow)");
  });
});

describe("Button", () => {
  it("is a style-less shell over the global .btn classes", () => {
    const s = C("Button.astro");
    expect(s).toMatch(/btn btn-\$\{variant\}/);
    expect(s).not.toContain("<style");
  });
});

describe("SectionLabel", () => {
  it("emits the global .label class", () => {
    expect(C("SectionLabel.astro")).toMatch(/class="label"/);
  });
});

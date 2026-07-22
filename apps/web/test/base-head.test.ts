import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () => readFileSync(join(import.meta.dirname, "../src/components/BaseHead.astro"), "utf8");

describe("BaseHead", () => {
  it("self-hosts both fonts + imports global css (which pulls tokens)", () => {
    const s = src();
    expect(s).toContain("import '@fontsource-variable/fraunces'");
    expect(s).toContain("import '@fontsource-variable/inter'");
    expect(s).toContain("../styles/global.css");
  });
  it("emits the generic head: charset, viewport, title, canonical, favicon, theme-color", () => {
    const s = src();
    expect(s).toContain('charset="utf-8"');
    expect(s).toContain("width=device-width");
    expect(s).toMatch(/<title>\{title\}<\/title>/);
    expect(s).toMatch(/rel="canonical"/);
    expect(s).toMatch(/rel="icon"\s+href="\/favicon\.svg"/);
    expect(s).toContain('name="theme-color" content="#060608"');
  });
  it("does NOT emit page-specific OG/Twitter (those stay in page head slots)", () => {
    const s = src();
    expect(s).not.toContain('property="og:type"');
    expect(s).not.toContain('name="twitter:card"');
  });
  it("defaults canonical to CANONICAL_ORIGIN + path (constant origin, never the request host)", () => {
    const s = src();
    expect(s).toContain("CANONICAL_ORIGIN");
    expect(s).not.toMatch(/Astro\.url\.(origin|host)/);
  });
});

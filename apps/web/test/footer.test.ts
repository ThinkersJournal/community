import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () => readFileSync(join(import.meta.dirname, "../src/components/Footer.astro"), "utf8");

describe("Footer", () => {
  it("uses the parent footer treatment + links back to the apex site", () => {
    const s = src();
    expect(s).toContain("#040405");
    expect(s).toMatch(/href="https:\/\/thinkersjournal\.com\/"/);
  });
  it("has Community links + is pure presentation (no cache helper / apiFetch)", () => {
    const s = src();
    expect(s).toContain('href="/feed"');
    expect(s).toContain('href="/authors"');
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/mark(Private|PublicCacheable|FeedCacheable)/);
  });
});

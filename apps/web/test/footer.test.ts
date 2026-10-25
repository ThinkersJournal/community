// SPDX-License-Identifier: MIT OR Apache-2.0
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
  it("introduces NO heading elements (a landmark, not document flow — WCAG 1.3.1 heading-order)", () => {
    const s = src();
    expect(s).not.toMatch(/<h[1-6][\s>]/i);
  });
});

describe("Footer: Community Guidelines link", () => {
  it("links the published guidelines page", () => {
    expect(src()).toContain('href="/guidelines"');
  });
});

describe("Footer: RSS link (S22 F8)", () => {
  it("shows a visible link to the site-wide feed", () => {
    expect(src()).toContain('href="/rss.xml"');
  });
});

describe("Footer: DSA notice link (S22 F7)", () => {
  it("links the target-less notice form", () => {
    expect(src()).toContain('href="/dsa-notice"');
  });
});

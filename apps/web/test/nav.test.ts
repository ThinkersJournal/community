import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () => readFileSync(join(import.meta.dirname, "../src/components/Nav.astro"), "utf8");

describe("Nav", () => {
  it("wordmark links to the apex marketing site", () => {
    expect(src()).toMatch(/href="https:\/\/thinkersjournal\.com\/"/);
  });
  it("has static browse links to /feed and /authors", () => {
    const s = src();
    expect(s).toContain('href="/feed"');
    expect(s).toContain('href="/authors"');
  });
  it("has the client-hydrated auth slot with an anonymous-default SSR view", () => {
    const s = src();
    expect(s).toMatch(/data-auth-slot/);
    // anonymous default is functional without JS
    expect(s).toContain('href="/login"');
    expect(s).toContain('href="/signup"');
  });
  it("carries NO per-viewer state (no cookie/session read, no apiFetch)", () => {
    const s = src();
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/Astro\.request/);
  });
  it("keeps the zero-JS mobile disclosure (checkbox + label siblings)", () => {
    const s = src();
    expect(s).toContain('type="checkbox"');
    expect(s).toContain('id="nav-toggle"');
    expect(s).toMatch(/for="nav-toggle"/);
    expect(s).toContain('id="nav-links"');
    expect(s).toMatch(/aria-controls="nav-links"/);
  });
  it("mounts the nav-toggle island as a bundled module (honest aria-expanded)", () => {
    const s = src();
    expect(s).toMatch(/import\s+\{\s*initNavToggle\s*\}\s+from\s+["']\.\.\/scripts\/nav-toggle["']/);
  });
});

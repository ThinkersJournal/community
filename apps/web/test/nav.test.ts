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
  it("has a static Discover browse link to / (the community feed home)", () => {
    const s = src();
    expect(s).toMatch(/<a\s+href="\/"\s*>Discover<\/a>/);
    // still no data fetching — the nav stays viewer-independent
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/Astro\.request/);
  });
  it("has a static Tags browse link to /tags", () => {
    const s = src();
    expect(s).toMatch(/<a\s+href="\/tags"\s*>Tags<\/a>/);
    // still no data fetching — the nav stays viewer-independent
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/Astro\.request/);
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
  it("carries a hidden notify-bell placeholder and mounts the bell island", () => {
    const nav = readFileSync(join(__dirname, "..", "src", "components", "Nav.astro"), "utf8");
    expect(nav).toContain("data-notify-bell"); // placeholder present
    expect(nav).toContain("initNotifyBell"); // island mounted
  });

  it("guards the notify bell/panel `hidden` attribute against the display:flex override (empty-oval + can't-close fix)", () => {
    const s = src();
    // The bell reveal (auth) and the panel open/close both drive the `hidden`
    // attribute; without this higher-specificity guard the earlier
    // `.notify{display:flex}` / `.notify-panel{display:flex}` defeat the UA
    // sheet's [hidden]{display:none}, so the empty panel renders as an oval and
    // `panel.hidden = true` cannot close it.
    expect(s).toMatch(/\.notify\[hidden\]\s*,\s*\.notify-panel\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("exposes the bell toggle as an accessible popup button (aria-expanded/haspopup/controls)", () => {
    const s = src();
    // aria-expanded sits ON the toggle button and defaults to false — an honest
    // SSR/pre-JS state; the island keeps it in sync on open/close.
    expect(s).toMatch(/data-notify-toggle[^>]*aria-expanded="false"/);
    expect(s).toContain('aria-haspopup="true"');
    expect(s).toContain('aria-controls="notify-panel"');
    // ...and the panel it controls carries that id.
    expect(s).toMatch(/data-notify-panel[^>]*id="notify-panel"/);
  });
  it("has a static GET search form to /search (no per-viewer state)", () => {
    const s = src();
    expect(s).toMatch(/<form[^>]*method="GET"[^>]*action="\/search"/);
    expect(s).toContain('name="q"');
    // still no data fetching — the anti-per-viewer assertion must keep holding
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/Astro\.request/);
  });
});

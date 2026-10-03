import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * SettingsNav.astro — the shared header for /settings and its three subpages.
 * Used by all three subpages (settings-{notifications,blocked,account}-page.test.ts
 * each pin their own usage + current section); this file pins the component's own
 * markup/accessibility contract.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(
  readFileSync(join(import.meta.dirname, "../src/components/SettingsNav.astro"), "utf8"),
);

describe("SettingsNav.astro", () => {
  it("has a nav landmark labelled Settings", () => {
    expect(code).toMatch(/<nav\s+aria-label="Settings">/);
  });

  it("is a real list of links, one per section, in visual == DOM order", () => {
    expect(code).toMatch(/<ul class="tabs">/);
    const order = ["notifications", "blocked", "account"].map((k) =>
      code.indexOf(`key: "${k}"`),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("marks the current section with aria-current=page, driven by a current prop", () => {
    expect(code).toMatch(/aria-current=\{current === s\.key \? "page" : undefined\}/);
  });

  it("has a back-link to /settings, but ONLY when `current` is set — the landing page " +
    "(which renders <SettingsNav/> with no `current`, pinned in settings-index-page.test.ts) " +
    "must not link to itself, while the three subpages (which always pass `current`) still get it", () => {
    expect(code).toMatch(/\{current !== undefined && <a class="link back" href="\/settings">/);
  });

  it("links to all three subpages", () => {
    expect(code).toContain('href: "/settings/notifications"');
    expect(code).toContain('href: "/settings/blocked"');
    expect(code).toContain('href: "/settings/account"');
  });

  it("wraps at narrow widths instead of scrolling horizontally", () => {
    expect(code).toMatch(/flex-wrap:wrap/);
    expect(code).not.toMatch(/overflow-x:\s*(scroll|auto)/);
  });

  it("does not hardcode a local focus style — relies on the site's global :focus-visible", () => {
    expect(code).not.toMatch(/:focus-visible/);
  });
});

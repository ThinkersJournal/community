import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRouteManifest, serverBuilt } from "./helpers/route-manifest";

const PAGE = join(import.meta.dirname, "../src/pages/settings/index.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("settings/index.astro", () => {
  it("exists and links to all three sections", () => {
    expect(code).toContain('href="/settings/notifications"');
    expect(code).toContain('href="/settings/blocked"');
    expect(code).toContain('href="/settings/account"');
  });

  it("uses the shared SettingsNav", () => {
    expect(code).toContain('import SettingsNav from "../../components/SettingsNav.astro"');
    expect(code).toMatch(/<SettingsNav\s*\/>/);
  });

  it("each section label is a real heading with the link inside it", () => {
    expect(code).toMatch(/<h2><a class="link" href="\/settings\/notifications">[^<]+<\/a><\/h2>/);
    expect(code).toMatch(/<h2><a class="link" href="\/settings\/blocked">[^<]+<\/a><\/h2>/);
    expect(code).toMatch(/<h2><a class="link" href="\/settings\/account">[^<]+<\/a><\/h2>/);
  });

  it("does not link to itself: <SettingsNav/> is called with no `current` prop, so its " +
    "back-link (which SettingsNav only renders when `current` is set — pinned in " +
    "settings-nav.test.ts) never appears on the landing page", () => {
    expect(code).not.toMatch(/<SettingsNav\s+current=/);
    expect(code).not.toMatch(/href="\/settings"/);
  });

  it("handles a signed-out visitor the SAME mechanism as settings/account.astro and " +
    "settings/blocked.astro — both read a real session — rather than settings/notifications.astro, " +
    "which this file agrees with anyway (all three use the identical csrfToken-null check)", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toMatch(/if \(csrfToken === null\) return Astro\.redirect\("\/login"\);/);
  });

  it("never caches (private, per-viewer settings)", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("uses BaseLayout, same as the three subpages", () => {
    expect(code).toMatch(/<BaseLayout\s/);
  });
});

describe("built route manifest (when dist/ is present)", () => {
  it.runIf(serverBuilt)("contains the /settings route", () => {
    expect(readRouteManifest()).toContain('"route":"/settings"');
  });
  it.skipIf(serverBuilt)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(serverBuilt).toBe(false);
  });
});

describe("control: the three old direct settings URLs still exist as pages", () => {
  it("settings/notifications.astro, settings/blocked.astro, settings/account.astro are all still present", () => {
    for (const name of ["notifications", "blocked", "account"]) {
      expect(() =>
        readFileSync(join(import.meta.dirname, `../src/pages/settings/${name}.astro`), "utf8"),
      ).not.toThrow();
    }
  });

  it("unsub.astro still links to /settings/notifications", () => {
    const unsub = readFileSync(join(import.meta.dirname, "../src/pages/unsub.astro"), "utf8");
    expect(unsub).toContain('href="/settings/notifications"');
  });
});

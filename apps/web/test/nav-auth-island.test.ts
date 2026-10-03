import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const island = () => readFileSync(join(import.meta.dirname, "../src/scripts/nav-auth.ts"), "utf8");
const nav = () => readFileSync(join(import.meta.dirname, "../src/components/Nav.astro"), "utf8");

describe("nav-auth island", () => {
  it("talks only to same-origin /api/* (never the api Worker directly)", () => {
    const s = island();
    expect(s).toContain("/api/me");
    expect(s).toContain("/api/logout");
    expect(s).not.toMatch(/https?:\/\//);
  });
  it("also wires Sign out EVERYWHERE (#74 audit, batch B) to its own distinct hop", () => {
    const s = island();
    expect(s).toContain("/api/logout-all");
    expect(s).toMatch(/signOutAll/);
    expect(s).toMatch(/Sign out everywhere/);
  });
  it("upgrades the slot for signed-in viewers and wires Sign out", () => {
    const s = island();
    expect(s).toContain("data-auth-slot");
    expect(s).toMatch(/loggedIn/);
    expect(s).toMatch(/X-CSRF-Token/i);
  });
  it("puts the primary-CTA pill on New post, never on Sign out", () => {
    const s = island();
    expect(s).toMatch(/newPost\.className\s*=\s*["']support["']/);
    expect(s).not.toMatch(/out\.className\s*=\s*["']support["']/);
  });
  it("terminates the /api/me fetch chain with a .catch() (network failure swallows cleanly)", () => {
    const s = island();
    expect(s).toMatch(/\.catch\(/);
  });

  it("⚠️ links to /settings (the settings landing page), not the old /settings/notifications stop-gap", () => {
    // Endpoint/UI audit, 2026-09-24: before that audit, /settings/notifications
    // worked fine but had NO inbound link anywhere in the app except the
    // unsubscribe-email landing page — a signed-in member had no click-path to
    // their own preferences at all. That audit pointed this nav link straight at
    // /settings/notifications as a stop-gap. Now a real /settings landing page
    // exists (apps/web/src/pages/settings/index.astro), listing all three
    // sections, so the nav link goes there instead.
    const s = island();
    expect(s).toContain('settings.href = "/settings"');
    expect(s).not.toContain('settings.href = "/settings/notifications"');
    expect(s).toMatch(/slot\.appendChild\(settings\)/);
  });
});

describe("Nav mounts the island as a bundled module", () => {
  it("imports initNavAuth (Astro externalizes it → script-src 'self')", () => {
    expect(nav()).toMatch(/import\s+\{\s*initNavAuth\s*\}\s+from\s+["']\.\.\/scripts\/nav-auth["']/);
  });
});

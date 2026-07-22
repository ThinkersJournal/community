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
  it("upgrades the slot for signed-in viewers and wires Sign out", () => {
    const s = island();
    expect(s).toContain("data-auth-slot");
    expect(s).toMatch(/loggedIn/);
    expect(s).toMatch(/X-CSRF-Token/i);
  });
});

describe("Nav mounts the island as a bundled module", () => {
  it("imports initNavAuth (Astro externalizes it → script-src 'self')", () => {
    expect(nav()).toMatch(/import\s+\{\s*initNavAuth\s*\}\s+from\s+["']\.\.\/scripts\/nav-auth["']/);
  });
});

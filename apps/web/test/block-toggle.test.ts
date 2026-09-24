import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Endpoint/UI audit, 2026-09-24 — the profile page's Block/Unblock control.
 * Source-level pins, matching post-visibility-view.test.ts's convention.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const ISLAND_PATH = join(__dirname, "..", "src", "scripts", "block-toggle.ts");
const PAGE_PATH = join(__dirname, "..", "src", "pages", "[handle]", "index.astro");

const island = stripComments(readFileSync(ISLAND_PATH, "utf8"));
const page = stripComments(readFileSync(PAGE_PATH, "utf8"));

describe("block-toggle island", () => {
  it("⚠️ the confirm copy is EXACTLY the design doc's required honest wording (block = interaction-control, not invisibility)", () => {
    // docs/superpowers/specs/2026-09-02-m4-report-block-design.md §2.1 — a
    // user who believes block makes them invisible makes worse safety
    // decisions than one with no block at all. This string must not drift.
    expect(island).toContain(
      "Block — they can't follow, comment, react, or reach you. Your public posts stay public and they may still be able to read them.",
    );
  });

  it("reads block state from /api/blocks?status=, batched per profile", () => {
    expect(island).toContain("/api/blocks?status=");
  });

  it("gates on logged-in AND not-the-viewer's-own-profile, with NO listener attached either way (not just visually hidden — the #82/follow-button lesson)", () => {
    expect(island).toMatch(
      /!status\.viewerLoggedIn \|\| status\.csrfToken === null \|\| status\.viewerId === profileUserId\) \{\s*return;/,
    );
  });

  it("BLOCK requires a two-step confirm (Confirm block / Cancel) before POSTing", () => {
    expect(island).toContain("Confirm block");
    expect(island).toContain("Cancel");
    expect(island).toMatch(/confirmBtn\.addEventListener\("click"[\s\S]{0,200}\/api\/block"/);
  });

  it("UNBLOCK is a single click — no confirm step (reducing a restriction needs none)", () => {
    const fn = island.slice(island.indexOf("function renderUnblockState"), island.indexOf("function renderBlockState"));
    expect(fn).not.toMatch(/confirm/i);
    expect(fn).toContain("/api/unblock");
  });

  it("sends the CSRF header on both mutations", () => {
    expect(island).toMatch(/"X-CSRF-Token":\s*csrfToken/);
  });

  it("exports initBlockToggle", () => {
    expect(island).toContain("export function initBlockToggle");
  });
});

describe("[handle]/index.astro wires the block control", () => {
  it("ships a hidden block-button root carrying the profile's user id", () => {
    expect(page).toMatch(/data-block-btn[^>]*hidden|hidden[^>]*data-block-btn/);
    expect(page).toContain("data-user-id={profile.userId}");
  });

  it("mounts initBlockToggle() alongside the page's other islands", () => {
    expect(page).toContain('import { initBlockToggle } from "../../scripts/block-toggle"');
    expect(page).toContain("initBlockToggle();");
  });

  it("relies on the global .btn[hidden] guard — no own display rule on .block that would need its own [hidden] override", () => {
    expect(page).not.toMatch(/\.block\{[^}]*display:/);
  });
});

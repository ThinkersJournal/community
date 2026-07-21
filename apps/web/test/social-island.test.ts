import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PROFILE = join(import.meta.dirname, "../src/pages/[handle]/index.astro");
const ISLAND = join(import.meta.dirname, "../src/scripts/social.ts");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const profileCode = stripComments(readFileSync(PROFILE, "utf8"));
const islandExists = existsSync(ISLAND);

describe("profile page keeps the M1 cache discipline while mounting the island", () => {
  it("still declares exactly one cache helper: markPublicCacheable", () => {
    expect(profileCode).toContain("markPublicCacheable(Astro,");
    expect(profileCode).not.toContain("markPrivate(");
    expect(profileCode).not.toContain("markFeedCacheable(");
  });

  it("its /public/profile fetch stays anonymous (no request forwarded)", () => {
    const call = /apiFetch<[^;]*\/public\/profile[^;]*\);/.exec(profileCode);
    expect(call, "profile page no longer fetches /public/profile").not.toBeNull();
    expect(call![0]).not.toMatch(/request:/);
  });

  it("embeds only the profile OWNER's viewer-independent ids for the island", () => {
    // Positive: the island mount point carries the owner's public id + handle.
    expect(profileCode).toMatch(/data-user-id=\{profile\.userId\}/);
    expect(profileCode).toMatch(/data-username=\{profile\.username\}/);
  });

  it("mounts the island as a BUNDLED module (an import), not inline JS", () => {
    // A <script> containing an import → Astro externalizes it → satisfies script-src 'self'.
    expect(profileCode).toMatch(/import\s+\{\s*initSocialIsland\s*\}\s+from\s+["']\.\.\/\.\.\/scripts\/social["']/);
  });
});

describe("the island module", () => {
  it("exists and talks only to same-origin /api/* endpoints", () => {
    expect(islandExists).toBe(true);
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toContain("/api/social");
    expect(island).toContain("/api/follow");
    expect(island).toContain("/api/unfollow");
    // Never reaches the api Worker directly (it has no public origin).
    expect(island).not.toMatch(/https?:\/\//);
  });
});

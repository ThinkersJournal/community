import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #78 ITEM 2 — THE PROFILE OWNER'S OWN DRAFTS/HIDDEN POSTS.
 * CireSnave's ruling: "posts hidden by the user should still be visible to
 * the user in their own list of posts. If they aren't visible there, where
 * would a user go to click a link to edit that post?"
 *
 * `[handle]/index.astro` is anonymous + edge-cached SSR (same construction as
 * `[handle]/[slug].astro`), so this hydrates client-side from the AUTHED
 * `GET /api/my-posts` hop — never from the cached `PublicProfile` DTO (PM
 * review condition, echoed in that page's own header). Same anti-vacuity
 * discipline and source-level-pin technique as social-island.test.ts and
 * post-visibility-view.test.ts (this app's vitest is plain Node; these files
 * import `cloudflare:workers` indirectly or reference browser-only APIs that
 * don't resolve outside workerd).
 */

const PROFILE = join(import.meta.dirname, "../src/pages/[handle]/index.astro");
const ISLAND = join(import.meta.dirname, "../src/scripts/owner-posts.ts");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const profileCode = stripComments(readFileSync(PROFILE, "utf8"));
const islandExists = existsSync(ISLAND);

describe("profile page keeps the M1 cache discipline while mounting the owner-posts island", () => {
  it("still declares exactly one cache helper: markPublicCacheable — unchanged by #78", () => {
    expect(profileCode).toContain("markPublicCacheable(Astro,");
    expect(profileCode).not.toContain("markPrivate(");
    expect(profileCode).not.toContain("markFeedCacheable(");
  });

  it("embeds an SSR-hidden root carrying the PROFILE OWNER's id, not any signed-in viewer's", () => {
    expect(profileCode).toContain("data-owner-posts");
    expect(profileCode).toMatch(/data-owner-posts[^>]*hidden|hidden[^>]*data-owner-posts/);
    expect(profileCode).toContain("data-profile-user-id={profile.userId}");
    expect(profileCode).toContain("data-username={profile.username}");
  });

  it("mounts initOwnerPosts() as a bundled module import, alongside the social island", () => {
    expect(profileCode).toMatch(/import\s+\{\s*initOwnerPosts\s*\}\s+from\s+["']\.\.\/\.\.\/scripts\/owner-posts["']/);
    expect(profileCode).toContain("initOwnerPosts();");
  });

  it("guards [hidden] on the section itself (post-delete/nav-bell fix pattern)", () => {
    expect(profileCode).toMatch(/\.owner-posts\[hidden\]\s*\{\s*display:\s*none/);
  });
});

describe("the owner-posts island", () => {
  it("exists and talks only to same-origin /api/* endpoints", () => {
    expect(islandExists).toBe(true);
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toContain("/api/me");
    expect(island).toContain("/api/my-posts");
    expect(island).not.toMatch(/https?:\/\//);
  });

  it("⚠️ reveals ONLY when the viewer's id matches the PROFILE's id, not merely being signed in", () => {
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    // Positive: the comparison is against profileUserId (the page's owner),
    // not any generic "is logged in" flag — a stranger's own /api/me success
    // must not reveal ANOTHER profile's drafts.
    expect(island).toMatch(/m\.userId === null[\s\S]{0,120}m\.userId !== profileUserId/);
  });

  it("shows only what the public SSR list structurally cannot: drafts and hidden posts", () => {
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toMatch(/status === "draft"[\s\S]{0,40}hiddenAt !== null/);
  });

  it("links each row to the post's own URL, never straight to the editor", () => {
    // The owner-fallback at [handle]/[slug].astro is where Hide/Unhide and the
    // hidden/draft banner actually live (#78 item 2's other half) — Edit is a
    // SEPARATE, explicit affordance, not the row's primary link.
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toMatch(/a\.href = `\/@\$\{encodeURIComponent\(username\)\}\/\$\{encodeURIComponent\(post\.slug\)\}`/);
  });

  it("uses createElement/textContent only — no innerHTML", () => {
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toContain("createElement");
    expect(island).not.toContain("innerHTML");
  });

  it("bounds the fetch loop — never follows nextCursor forever", () => {
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toMatch(/page < 10/);
  });

  it("exports initOwnerPosts", () => {
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toContain("export function initOwnerPosts");
  });
});

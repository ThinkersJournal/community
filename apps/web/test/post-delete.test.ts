import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * POST-PAGE DELETE — the owner-only "delete this post" affordance.
 *
 * Two source-text targets, mirroring notify-bell.test.ts / comment-proxies.test.ts's
 * style (this app's vitest is plain Node — see post-page.test.ts's header for why
 * these are source-text, not render, tests):
 *   - src/pages/api/post-delete.ts — the browser -> api authed hop, a near-exact
 *     clone of comment-delete.ts (DELETE /posts/:id, markPrivate).
 *   - src/scripts/post-delete.ts — the owner-only reveal + inline two-step confirm
 *     island, mounted from [handle]/[slug].astro.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PROXY_PATH = join(__dirname, "..", "src", "pages", "api", "post-delete.ts");
const ISLAND_PATH = join(__dirname, "..", "src", "scripts", "post-delete.ts");
const PAGE_PATH = join(__dirname, "..", "src", "pages", "[handle]", "[slug].astro");

const proxy = stripComments(readFileSync(PROXY_PATH, "utf8"));
const island = stripComments(readFileSync(ISLAND_PATH, "utf8"));
const page = stripComments(readFileSync(PAGE_PATH, "utf8"));

describe("POST /api/post-delete proxy", () => {
  it("is markPrivate and forwards cookie+origin+csrf to DELETE /posts/<id>", () => {
    expect(proxy).toContain("markPrivate(");
    expect(proxy).toMatch(/method:\s*"DELETE"/);
    expect(proxy).toContain("/posts/");
    expect(proxy).toContain("request: context.request");
    expect(proxy).toContain('context.request.headers.get("Origin")');
    expect(proxy).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(proxy).toContain("applyCookies(");
  });

  it("reads { postId } from the body and rejects a non-string id", () => {
    expect(proxy).toContain("postId");
    expect(proxy).toMatch(/typeof postId !== "string"/);
  });

  it("never declares any OTHER cache helper (this file is markPrivate, not public)", () => {
    expect(proxy).not.toContain("markPublicCacheable(");
    expect(proxy).not.toContain("markFeedCacheable(");
  });
});

describe("post-delete island", () => {
  it("reads viewer identity from /api/me", () => {
    expect(island).toContain('fetch("/api/me")');
  });

  it("reads the post's author id off the delete control's data attribute", () => {
    expect(island).toMatch(/data-post-delete/);
    expect(island).toMatch(/data-post-author-id|dataset\.postAuthorId/);
  });

  it("reveals the control only when the viewer IS the author AND has a CSRF token", () => {
    // ⚠️ ANTI-VACUITY: co-locate the owner-match check with the reveal
    // (root.hidden = false) so a regression that reveals unconditionally fails.
    expect(island).toMatch(
      /m\.userId === (?:null|authorId)[\s\S]{0,200}m\.userId (?:!==|===) (?:authorId|null)[\s\S]{0,200}root\.hidden = false/,
    );
  });

  it("builds the inline confirm with createElement/textContent only — NO browser dialog", () => {
    expect(island).toContain("createElement");
    expect(island).not.toContain("confirm(");
    expect(island).not.toContain("innerHTML");
    expect(island).not.toContain("insertAdjacentHTML");
  });

  it("exposes the required e2e selectors: data-delete-start and data-delete-confirm", () => {
    expect(island).toContain("data-delete-start");
    expect(island).toContain("data-delete-confirm");
  });

  it("posts to /api/post-delete with the CSRF header and the postId body", () => {
    expect(island).toContain("/api/post-delete");
    expect(island).toContain('"X-CSRF-Token"');
    expect(island).toMatch(/method:\s*"POST"/);
    expect(island).toMatch(/JSON\.stringify\(\{\s*postId\s*\}\)/);
  });

  it("redirects to the author's profile on success — no reload, no dead page", () => {
    expect(island).toMatch(/location\.href|location\.assign/);
    expect(island).toMatch(/\/@.*handle/);
  });

  it("⚠️ percent-encodes the handle in the redirect (fix round 1) — matches the page's own /@ links and comments-live.ts's precedent", () => {
    // A bare `"/@" + handle` is a no-op today (usernames are `[a-z0-9_]`), but
    // every OTHER `/@` link in this app (the byline href on this same page,
    // comments-live.ts's author link) goes through encodeURIComponent —
    // defense-in-depth for a future relaxed username charset.
    expect(island).toMatch(/location\.href\s*=\s*"\/@"\s*\+\s*encodeURIComponent\(handle\)/);
  });

  it("exports initPostDelete", () => {
    expect(island).toContain("export function initPostDelete");
  });
});

describe("[handle]/[slug].astro wires the delete control", () => {
  it("ships a hidden delete-control root carrying the post id, author id, and handle", () => {
    expect(page).toContain("data-post-delete");
    expect(page).toMatch(/data-post-delete[^>]*hidden|hidden[^>]*data-post-delete/);
    expect(page).toContain("data-post-id={post.id}");
    expect(page).toContain("data-post-author-id={post.authorId}");
  });

  it("mounts initPostDelete() in the client script alongside the other islands", () => {
    expect(page).toContain('import { initPostDelete } from "../../scripts/post-delete"');
    expect(page).toContain("initPostDelete();");
  });

  it("guards the delete control's `hidden` attribute against a display override (nav-bell fix pattern)", () => {
    // Same defect class the nav bell fixed: an author display rule on the
    // control's class must not defeat the UA sheet's [hidden]{display:none}.
    expect(page).toMatch(/\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("⚠️ guards EVERY hidden descendant, not just the container (fix round 1)", () => {
    // `.post-delete[hidden]` alone only covers the container. `.btn` (global.css)
    // is AUTHOR-origin, so it beats the UA sheet's [hidden]{display:none}
    // regardless of specificity — origin is resolved before specificity, and
    // specificity only breaks ties WITHIN the same origin. The start button and
    // the confirm row's Confirm/Cancel buttons are `.btn`-classed DESCENDANTS of
    // `.post-delete`, so they need a same-origin, higher-specificity descendant
    // guard of their own: `.post-delete [hidden]` (space = descendant
    // combinator, specificity 0,2,0, beats `.btn`'s 0,1,0). Mirrors
    // nav.test.ts's pin of Nav.astro's `.notify[hidden],.notify-panel[hidden]`
    // guard — same defect class, same fix shape.
    expect(page).toMatch(/\.post-delete\s+\[hidden\]\s*\{\s*display:\s*none/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const code = readFileSync(join(__dirname, "..", "src", "scripts", "comments.ts"), "utf8");

describe("comments island", () => {
  it("reads viewer identity from /api/me and sends the CSRF header on writes", () => {
    expect(code).toContain('fetch("/api/me")');
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("builds DOM safely — createElement/textContent only", () => {
    expect(code).toContain("document.createElement"); // positive anchor
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
  it("never redirects to /choose-username — a handle is chosen once, at signup", () => {
    expect(code).not.toContain("/choose-username");
    expect(code).not.toContain("usernameChosen");
  });
  it("shows the degraded prompt when a signed-in viewer has no CSRF token yet", () => {
    // A signed-in verified user always has a handle (chosen at signup); the
    // only thing that can still be missing is the CSRF token itself, e.g. a
    // transiently-failed /auth/csrf hop.
    expect(code).toContain("if (me.csrfToken === null) {");
    expect(code).toContain("Couldn't load the comment form"); // the degraded prompt exists
  });
  it("enables commenting/affordances on loggedIn + csrfToken + userId, nothing more", () => {
    expect(code).toContain("if (!me.loggedIn || me.csrfToken === null || me.userId === null) return;");
  });
  it("reloads after a successful write (the purge already made the page fresh)", () => {
    expect(code).toContain("location.reload()");
  });
  it("hides Reply at the depth cap and edit-prefills from /api/comments", () => {
    expect(code).toContain("MAX_DEPTH");
    expect(code).toContain("/api/comments?");
  });
  it("exposes per-comment affordance wiring as a reusable export", () => {
    // Task 7's live client wires freshly-inserted <li>s with this same helper —
    // it must be exported and initCommentsIsland must call it, not inline it.
    expect(code).toContain("export function wireCommentAffordances");
    expect(code).toContain("wireCommentAffordances(li, { csrfToken, viewerId, postId, postAuthorId })");
  });
});

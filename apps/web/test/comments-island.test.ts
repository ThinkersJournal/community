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
  it("routes the un-onboarded to /choose-username with a return path", () => {
    expect(code).toContain("/choose-username?next=");
  });
  it("keeps onboarding (!usernameChosen) and a missing CSRF token as SEPARATE form-slot cases", () => {
    // The onboarded-but-no-token state is a transient degraded case, NOT an
    // onboarding gap — it has its own affordance, never "Choose your handle".
    // Two positive anchors: the un-onboarded branch stands alone, and the
    // degraded prompt exists. (A blanket `!usernameChosen || csrfToken===null`
    // negative can't be used — line ~154's per-comment guard legitimately
    // withholds affordances on that same combined condition.)
    expect(code).toContain("if (!me.usernameChosen) {"); // its own branch, not an `||`
    expect(code).toContain("Couldn't load the comment form"); // the degraded prompt exists
  });
  it("reloads after a successful write (the purge already made the page fresh)", () => {
    expect(code).toContain("location.reload()");
  });
  it("hides Reply at the depth cap and edit-prefills from /api/comments", () => {
    expect(code).toContain("MAX_DEPTH");
    expect(code).toContain("/api/comments?");
  });
});

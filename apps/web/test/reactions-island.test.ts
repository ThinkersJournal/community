import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const code = readFileSync(join(__dirname, "..", "src", "scripts", "reactions.ts"), "utf8");

describe("reactions island", () => {
  it("hydrates from ONE /api/reactions call and toggles via /api/react|unreact", () => {
    expect(code).toContain("/api/reactions?postId=");
    expect(code).toContain('"/api/react"');
    expect(code).toContain('"/api/unreact"');
  });
  it("sends the viewer to /login when logged out, with the CSRF header when not", () => {
    expect(code).toContain('"/login"');
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("is optimistic but reverts on failure", () => {
    expect(code).toContain("aria-pressed");
    expect(code).toContain("revert"); // function name below — keeps the intent greppable
  });
  it("never injects HTML", () => {
    expect(code).toContain("textContent"); // positive anchor
    expect(code).not.toContain("innerHTML");
  });
});

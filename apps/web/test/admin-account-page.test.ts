import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const PAGE = join(import.meta.dirname, "..", "src", "pages", "admin", "accounts", "[handle].astro");
const source = stripComments(readFileSync(PAGE, "utf8"));

describe("/admin/accounts/[handle]", () => {
  it("⚠️ the Access-JWT guard is the FIRST executable statement", () => {
    const guardAt = source.indexOf("if (accessJwt === null");
    expect(guardAt).toBeGreaterThan(-1);
    for (const later of ["markPrivate(Astro)", "setPublicPageCsp(Astro)", "adminApiFetch("]) {
      expect(source.indexOf(later)).toBeGreaterThan(guardAt);
    }
  });

  it("posts to the account-action api and reads the account api", () => {
    expect(source).toContain("/actions`");
    expect(source).toMatch(/adminApiFetch<AdminAccountResponse>\(/);
  });

  it("offers ONLY warn/suspend/ban — never a terminate ACTION BUTTON", () => {
    // ⚠️ NARROWED (Review Focus 7): the page now also DISPLAYS a terminated
    // account's state ("Terminated (CSAM path) since …"), which legitimately
    // mentions the word. What must stay true is the narrower invariant this
    // test actually guards — no terminate ADMIN ACTION is offered — not "the
    // word never appears on the page" (that was never the real property;
    // ADMIN_ACCOUNT_ACTIONS excluding "terminate" at the shared-constant level
    // is what the button list itself is bound to).
    expect(source).toContain("ADMIN_ACCOUNT_ACTIONS.map(");
    expect(source).not.toMatch(/name="action"\s+value=\{?"?terminate"?\}?/i);
    expect(source).not.toMatch(/<button[^>]*>\s*terminate\s*<\/button>/i);
  });

  it("offers the adopted suspension durations, defaulting to 7 days", () => {
    expect(source).toContain("SUSPENSION_HOURS.map(");
    expect(source).toContain("DEFAULT_SUSPENSION_HOURS");
  });

  it("a ban requires an explicit confirmBan checkbox, sent only for the ban action", () => {
    expect(source).toMatch(/name="confirmBan"/);
    expect(source).toContain('I confirm a permanent ban');
    expect(source).toMatch(/action === "ban"[^}]*confirmBan:\s*form\.get\("confirmBan"\)\s*===\s*"on"/);
  });

  it("the state line distinguishes a lapsed suspension and a CSAM termination from a ban", () => {
    expect(source).toMatch(/Suspension ended/);
    expect(source).toMatch(/Terminated \(CSAM path\) since/);
    expect(source).toMatch(/disabledReason === "terminate"/);
  });

  it("hides the suggested-next-step advisory once the account is disabled", () => {
    expect(source).toMatch(/!account\.disabledAt\s*&&[\s\S]{0,80}Suggested next step/);
  });
});

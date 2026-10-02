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

  describe("legal holds (account-legal-hold spec §3 T3)", () => {
    it("renders the holds list", () => {
      expect(source).toMatch(/account\.holds\.map\(/);
    });

    it("every form posts a hidden intent field, and the POST handler branches on it", () => {
      expect(source).toMatch(/form\.get\("intent"\)/);
      expect(source).toMatch(/<input[^>]*type="hidden"[^>]*name="intent"[^>]*value="account_action"/);
      expect(source).toMatch(/<input[^>]*type="hidden"[^>]*name="intent"[^>]*value="hold_impose"/);
      expect(source).toMatch(/<input[^>]*type="hidden"[^>]*name="intent"[^>]*value="hold_release"/);
    });

    it("the impose form's category select excludes csam", () => {
      const imposeFormMatch = source.match(/<form[^>]*class="hold-impose-form"[\s\S]*?<\/form>/);
      expect(imposeFormMatch).not.toBeNull();
      // The select maps over a category list that is explicitly filtered to
      // exclude csam, not the raw LEGAL_HOLD_CATEGORIES (which includes it).
      expect(source).toMatch(/LEGAL_HOLD_CATEGORIES\.filter\(\(?c\)? =>\s*c\s*!==\s*"csam"\)/);
      expect(imposeFormMatch![0]).toMatch(/MANUAL_HOLD_CATEGORIES\.map\(/);
      expect(imposeFormMatch![0]).not.toMatch(/LEGAL_HOLD_CATEGORIES\.map\(/);
    });

    it("a csam hold shows no release control", () => {
      expect(source).toMatch(/cannot be released in the app/);
      expect(source).toMatch(/hold\.category\s*===\s*"csam"/);
    });

    /**
     * ⚠️ STRUCTURAL, not textual. A plain `indexOf("Legal holds") >
     * indexOf('account.disabledAt ? (')` check would still pass if the hold
     * section were pasted INSIDE the else-arm (right before that arm's own
     * closing `</form>` / `)`) — exactly the regression this test exists to
     * catch, since "Legal holds" textually follows the ternary's START
     * either way. So this walks a paren-depth counter from the `(` that
     * opens the `disabledAt ? (` arm, to find where THAT arm closes, then
     * does the same for the `: (` arm, and asserts the hold section starts
     * strictly after the SECOND arm's closing paren — i.e. after the whole
     * ternary expression, not merely after its first token.
     */
    function findMatchingParenClose(src: string, openIdx: number): number {
      let depth = 0;
      for (let i = openIdx; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    it("⚠️ the hold section is rendered OUTSIDE the disabledAt ? banned : form branch, so a banned account still shows it", () => {
      const ternaryAt = source.indexOf("account.disabledAt ? (");
      expect(ternaryAt).toBeGreaterThan(-1);

      // The '(' that opens the first (banned) arm is the last character of
      // the matched text above.
      const firstOpen = ternaryAt + "account.disabledAt ? (".length - 1;
      expect(source[firstOpen]).toBe("(");
      const firstClose = findMatchingParenClose(source, firstOpen);
      expect(firstClose).toBeGreaterThan(firstOpen);

      // Immediately after the first arm closes, expect `) : (` and find the
      // '(' that opens the second (form) arm.
      const betweenArms = source.slice(firstClose, firstClose + 20);
      expect(betweenArms).toMatch(/^\)\s*:\s*\(/);
      const secondOpen = firstClose + betweenArms.indexOf("(", 1);
      expect(source[secondOpen]).toBe("(");
      const secondClose = findMatchingParenClose(source, secondOpen);
      expect(secondClose).toBeGreaterThan(secondOpen);

      // The whole ternary expression ends at secondClose. The hold section
      // — its heading AND its impose form — must start strictly after it.
      const legalHoldsAt = source.indexOf("Legal holds");
      const imposeFormAt = source.indexOf('class="hold-impose-form"');
      expect(legalHoldsAt).toBeGreaterThan(secondClose);
      expect(imposeFormAt).toBeGreaterThan(secondClose);
    });

    it("still guards first, even with the new section", () => {
      const guardAt = source.indexOf("if (accessJwt === null");
      const legalHoldsAt = source.indexOf("Legal holds");
      expect(guardAt).toBeGreaterThan(-1);
      expect(legalHoldsAt).toBeGreaterThan(guardAt);
    });
  });
});

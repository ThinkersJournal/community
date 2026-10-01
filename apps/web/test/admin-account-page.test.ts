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

  it("offers ONLY warn/suspend/ban — never terminate", () => {
    expect(source).toContain("ADMIN_ACCOUNT_ACTIONS.map(");
    expect(source).not.toMatch(/terminate/i);
  });

  it("offers the adopted suspension durations, defaulting to 7 days", () => {
    expect(source).toContain("SUSPENSION_HOURS.map(");
    expect(source).toContain("DEFAULT_SUSPENSION_HOURS");
  });
});

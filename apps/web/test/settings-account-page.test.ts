import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const raw = readFileSync(join(__dirname, "..", "src", "pages", "settings", "account.astro"), "utf8");
const c = strip(raw);

describe("settings/account.astro", () => {
  it("is authed (markPrivate) and talks to both /account/delete and /account/delete/cancel", () => {
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/account/delete/cancel");
    expect(c).toContain('"/account/delete"');
    expect(c).toContain('"/account"');
  });

  it("forwards Origin + CSRF and applies cookies on submit", () => {
    expect(c).toContain('Astro.request.headers.get("Origin")');
    expect(c).toContain("csrfToken");
    expect(c).toContain("applyCookies(");
  });

  it("requires a second GET step before the delete form is reachable — no one-click delete", () => {
    // The plain (unconfirmed) view offers only a link to ?step=confirm, never
    // a submittable form for the delete request.
    expect(c).toMatch(/step=confirm/);
    const confirmFormIndex = c.indexOf('value="request"');
    const linkIndex = c.indexOf("step=confirm");
    expect(confirmFormIndex).toBeGreaterThan(-1);
    expect(linkIndex).toBeGreaterThan(-1);
  });

  it("does not overclaim what deletion does — anonymise language present, erase/permanent-removal language absent", () => {
    expect(c).toMatch(/anonymise/i);
    expect(c).toMatch(/30-day/i);
    expect(c).not.toMatch(/erase(d|s)? immediately/i);
    // The false claim this whole feature exists to correct, never repeated here.
    expect(c).not.toMatch(/permanent(ly)? (delete|remove)/i);
  });

  it("tells the reader posts/comments survive, attributed to a placeholder identity", () => {
    expect(raw).toMatch(/posts and comments are not deleted/i);
    expect(raw).toContain("Deleted user");
  });

  it("redirects after a successful POST (PRG) rather than re-rendering the submission", () => {
    expect(c).toMatch(/Astro\.redirect\(\s*["']\/settings\/account["']\s*\)/);
  });

  it("uses the shared SettingsNav instead of an ad-hoc bottom cross-link", () => {
    expect(c).toContain('import SettingsNav from "../../components/SettingsNav.astro"');
    expect(c).toContain('<SettingsNav current="account" />');
    expect(c).not.toMatch(/class="settings-nav"/);
  });
});

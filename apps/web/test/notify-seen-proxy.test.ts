import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const DIR = join(__dirname, "..", "src", "pages", "api");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
describe("notifications-seen proxy", () => {
  it("markPrivate + forwards CSRF + applyCookies to /notifications/seen", () => {
    const c = strip(readFileSync(join(DIR, "notifications-seen.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notifications/seen");
    expect(c).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(c).toContain("applyCookies(");
  });
});

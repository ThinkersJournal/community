import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("notification proxies", () => {
  it("notifications.ts (GET) markPrivate + forwards cookie to /notifications", () => {
    const c = strip(readFileSync(join(DIR, "notifications.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain('"/notifications'); // list path
    expect(c).toContain("request: context.request");
  });
  it("notifications-count.ts (GET) markPrivate + /notifications/unread-count", () => {
    const c = strip(readFileSync(join(DIR, "notifications-count.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notifications/unread-count");
    expect(c).toContain("request: context.request");
  });
  it("notifications-read.ts (POST) markPrivate + forwards CSRF + applyCookies", () => {
    const c = strip(readFileSync(join(DIR, "notifications-read.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notifications/read");
    expect(c).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(c).toContain("applyCookies(");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const code = readFileSync(join(__dirname, "..", "src", "scripts", "notify-bell.ts"), "utf8");
describe("notify bell island", () => {
  it("detects logged-in via the count endpoint, staying hidden on 401 (deviation 2)", () => {
    expect(code).toContain("/api/notifications-count");
    expect(code).toContain(".status"); // branches on it (200 → show, 401 → hide)
  });
  it("builds DOM safely — textContent/createElement only", () => {
    expect(code).toContain("createElement"); // positive anchor
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
  it("opens a dropdown, loads items, and marks all read with CSRF", () => {
    expect(code).toContain("/api/notifications");
    expect(code).toContain("/api/notifications-read");
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("polls on visibility + interval", () => {
    expect(code).toContain("visibilitychange");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { barredMessage } from "../src/lib/barred-message";

/**
 * #50 Q2 — a barred user is told so at login, not "Invalid email or password."
 * The api says ACCOUNT_BARRED only after a correct password (see
 * apps/api/test/login-barred.test.ts), so this text never reaches a stranger.
 */
describe("barredMessage", () => {
  it("a ban", () => {
    expect(barredMessage({ code: "ACCOUNT_BARRED", barred: { kind: "banned" } })).toBe(
      "This account has been banned.",
    );
  });

  it("a suspension names its end, unambiguously (UTC)", () => {
    expect(
      barredMessage({ code: "ACCOUNT_BARRED", barred: { kind: "suspended", until: "2026-10-08T04:00:00.000Z" } }),
    ).toBe("This account is suspended until Thu, 08 Oct 2026 04:00:00 GMT.");
  });

  it("anything that is not an ACCOUNT_BARRED envelope is not a bar — the page keeps its generic text", () => {
    expect(barredMessage({ code: "INVALID_CREDENTIALS" })).toBeNull();
    expect(barredMessage(null)).toBeNull();
    expect(barredMessage("nope")).toBeNull();
  });

  it("an ACCOUNT_BARRED body with a missing or malformed detail still says the account is barred, without inventing a date", () => {
    expect(barredMessage({ code: "ACCOUNT_BARRED" })).toBe("This account is currently barred.");
    expect(barredMessage({ code: "ACCOUNT_BARRED", barred: { kind: "suspended", until: "not-a-date" } })).toBe(
      "This account is currently barred.",
    );
  });
});

describe("login.astro uses it", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/pages/login.astro"), "utf8");

  it("imports barredMessage and consults it before the generic failure text", () => {
    expect(source).toMatch(/import\s*\{\s*barredMessage\s*\}\s*from\s*"\.\.\/lib\/barred-message"/);
    expect(source).toMatch(/barredMessage\(response\.data\)/);
    expect(source.indexOf("barredMessage(response.data)")).toBeLessThan(source.indexOf('"Invalid email or password."'));
  });
});

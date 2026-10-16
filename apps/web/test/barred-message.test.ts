import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { barredMessage } from "../src/lib/barred-message";
import { loginFailureView } from "../src/lib/login-challenge";

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

describe("#113 — the reason", () => {
  it("is appended when present", () => {
    expect(barredMessage({ code: "ACCOUNT_BARRED", barred: { kind: "banned", reason: "spam" } })).toBe(
      "This account has been banned. Reason given by the moderator: spam",
    );
  });
});

describe("the login page uses it", () => {
  // The failure text is decided by src/lib/login-challenge.ts (the page cannot be
  // rendered in plain Node); the page hands it the api's body.
  const source = readFileSync(join(import.meta.dirname, "../src/pages/login.astro"), "utf8");

  it("passes the api's body to the decision, and a barred body wins over the generic text", () => {
    expect(source).toContain("data: response.data");
    const view = loginFailureView({
      status: 403,
      code: "ACCOUNT_BARRED",
      data: { code: "ACCOUNT_BARRED", barred: { kind: "banned" } },
      sentToken: false,
      email: "a@example.com",
    });
    expect(view.error).toBe("This account has been banned.");
    expect(view.challenged).toBe(false);
  });
});

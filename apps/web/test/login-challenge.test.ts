// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";

import { loginFailureView } from "../src/lib/login-challenge";

/**
 * What the login page shows after the api refused a POST, as a BEHAVIOUR: the
 * page's decision lives in `src/lib/login-challenge.ts` precisely so it can be
 * driven without workerd (the page imports `cloudflare:workers`; see
 * test/login-page.test.ts). The page only applies the result: it widens the CSP
 * and renders the widget when, and only when, `challenged` is true.
 */
const base = { status: 401, code: "INVALID_CREDENTIALS" as const, data: { code: "INVALID_CREDENTIALS" }, sentToken: false, email: "a@example.com" };

describe("loginFailureView", () => {
  it("an ordinary wrong password keeps the generic text and NO widget (control for every case below)", () => {
    expect(loginFailureView(base)).toEqual({
      challenged: false,
      error: "Invalid email or password.",
      prefillEmail: "",
    });
  });

  it("CHALLENGE_REQUIRED shows the widget, prefills the email, and asks for the check", () => {
    expect(
      loginFailureView({ ...base, status: 403, code: "CHALLENGE_REQUIRED", data: { code: "CHALLENGE_REQUIRED" } }),
    ).toEqual({
      challenged: true,
      error: "Please complete the check below, then log in again.",
      prefillEmail: "a@example.com",
    });
  });

  it("a wrong password AFTER a solved challenge keeps the widget, so the retry is one round trip", () => {
    const v = loginFailureView({ ...base, sentToken: true });
    expect(v).toEqual({ challenged: true, error: "Invalid email or password.", prefillEmail: "a@example.com" });
  });

  it("a token alone is not a challenge: only a 401 that followed one is (429, barred and 500 stay plain)", () => {
    for (const status of [429, 403, 500]) {
      const code = status === 429 ? ("RATE_LIMITED" as const) : ("ACCOUNT_BARRED" as const);
      const v = loginFailureView({ ...base, status, code, data: { code }, sentToken: true });
      expect(v.challenged, `status ${status}`).toBe(false);
    }
    expect(loginFailureView({ ...base, status: 429, code: "RATE_LIMITED", data: { code: "RATE_LIMITED" } }).error).toBe(
      "Too many attempts. Please wait and try again.",
    );
  });

  it("a 503 SERVICE_UNAVAILABLE (siteverify unreachable) keeps the widget with a try-later message", () => {
    expect(
      loginFailureView({ ...base, status: 503, code: "SERVICE_UNAVAILABLE", data: { code: "SERVICE_UNAVAILABLE" } }),
    ).toEqual({
      challenged: true,
      error: "Verification is temporarily unavailable. Please try again in a moment.",
      prefillEmail: "a@example.com",
    });
  });

  it("any OTHER 503 is today's generic message with no widget", () => {
    const html = loginFailureView({ ...base, status: 503, code: null, data: "<html>upstream</html>" });
    expect(html).toEqual({ challenged: false, error: "Invalid email or password.", prefillEmail: "" });
    const other = loginFailureView({ ...base, status: 503, code: "NOT_FOUND", data: { code: "NOT_FOUND" } });
    expect(other.challenged).toBe(false);
  });

  it("a non-string email is never echoed", () => {
    expect(loginFailureView({ ...base, sentToken: true, email: null }).prefillEmail).toBe("");
  });
});

/**
 * What the login page shows after the api refused a POST.
 *
 * ⚠️ A PURE FUNCTION ON PURPOSE. The page (src/pages/login.astro) imports
 * `cloudflare:workers` through api.ts and cannot be rendered in this app's plain
 * Node vitest, so the decision lives here, where test/login-challenge.test.ts can
 * drive it as behaviour. The page only APPLIES the result: it widens the CSP and
 * renders the Turnstile widget when, and only when, `challenged` is true.
 *
 * `challenged` is true in exactly three cases:
 *   • the api said CHALLENGE_REQUIRED (several attempts in the last minute, or the
 *     token we sent did not verify);
 *   • the api said SERVICE_UNAVAILABLE, which on this route only follows a
 *     challenged attempt whose token could not be checked (siteverify unreachable).
 *     Any OTHER 503 (an upstream error page, a different code) is not that and
 *     keeps today's generic message;
 *   • a 401 after the browser SENT a token. That attempt was challenged, so the
 *     api will challenge the next one too (the soft state lasts the window). With
 *     no widget on this render the retry would be a second round trip and spend
 *     two more hard-cap slots, so the widget stays and the text stays generic:
 *     "Invalid email or password." must not change, it is the no-enumeration text.
 */
import type { ApiErrorCode } from "@thinkersjournal/shared";

import { barredMessage } from "./barred-message";

export interface LoginFailureInput {
  /** The api response's HTTP status. */
  readonly status: number;
  /** Its envelope `code`, or null when the body was not the envelope. */
  readonly code: ApiErrorCode | null;
  /** Its parsed body, for the barred-account message. */
  readonly data: unknown;
  /** Whether THIS POST carried a non-empty `turnstileToken`. */
  readonly sentToken: boolean;
  /** The form's `email` field as the browser sent it. */
  readonly email: unknown;
}

export interface LoginFailureView {
  readonly challenged: boolean;
  readonly error: string;
  /** The address to put back in the form; "" unless `challenged`. Never a password. */
  readonly prefillEmail: string;
}

export function loginFailureView(input: LoginFailureInput): LoginFailureView {
  const { status, code, data, sentToken, email } = input;
  const prefill = typeof email === "string" ? email : "";

  if (code === "CHALLENGE_REQUIRED") {
    return { challenged: true, error: "Please complete the check below, then log in again.", prefillEmail: prefill };
  }
  if (status === 503 && code === "SERVICE_UNAVAILABLE") {
    return {
      challenged: true,
      error: "Verification is temporarily unavailable. Please try again in a moment.",
      prefillEmail: prefill,
    };
  }

  const error =
    status === 429
      ? "Too many attempts. Please wait and try again."
      : (barredMessage(data) ?? "Invalid email or password.");
  const challenged = status === 401 && sentToken;
  return { challenged, error, prefillEmail: challenged ? prefill : "" };
}

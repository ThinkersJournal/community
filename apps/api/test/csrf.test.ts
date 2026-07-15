import { describe, expect, it } from "vitest";

import type { SessionData } from "@thinkersjournal/shared";

import { checkCsrf, checkOrigin, csrfTokenFor } from "../src/auth/csrf";

/**
 * Real WebCrypto throughout (no mocks) — `crypto.subtle` is a genuine workerd
 * global in this POOL project, so `csrfTokenFor`/`checkCsrf` exercise the real
 * SHA-256 digest + timing-safe compare rather than a stub.
 */
const sampleSession: SessionData = {
  userId: "11111111-1111-1111-1111-111111111111",
  roles: ["member"],
  securityEpoch: 1,
  csrfSecret: "csrf-secret-value",
  createdAt: Date.now(),
};

function postRequest(headers: Record<string, string>): Request {
  return new Request("https://api.test/some-endpoint", {
    method: "POST",
    headers,
  });
}

/** As `postRequest`, for any method — the allowlist must not be POST-specific. */
function requestWithMethod(
  method: string,
  headers: Record<string, string>,
): Request {
  return new Request("https://api.test/some-endpoint", { method, headers });
}

/**
 * Every non-safe method the allowlist must cover. GET/HEAD are deliberately
 * absent — they are the documented pass-through, pinned separately below.
 */
const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

describe("checkOrigin", () => {
  it("allows a POST from an allowed Origin", () => {
    const request = postRequest({ Origin: "https://thinkersjournal.com" });
    expect(checkOrigin(request)).toBe(true);
  });

  it("allows a POST from the www subdomain Origin", () => {
    const request = postRequest({ Origin: "https://www.thinkersjournal.com" });
    expect(checkOrigin(request)).toBe(true);
  });

  it("rejects a POST from a disallowed Origin", () => {
    const request = postRequest({ Origin: "https://evil.com" });
    expect(checkOrigin(request)).toBe(false);
  });

  /**
   * ⚠️ THE SECURITY-CRITICAL REGRESSION. A present `Origin` is DISPOSITIVE:
   * `checkOrigin` returns on it and must NEVER fall through to `Referer`.
   *
   * Without this case, the disallowed-Origin test above passes trivially — it
   * sends no `Referer`, so a buggy fall-through would find nothing to fall back
   * TO and still return false. The dangerous shape is exactly this one: an
   * attacker's real `Origin` (which a browser sets and script cannot forge)
   * alongside an allowed-looking `Referer` (which is far weaker — it can be
   * absent, truncated to an origin, or influenced by referrer-policy). A
   * refactor that reordered the two checks, or treated a missing allowlist hit
   * as "keep looking", would silently accept every cross-site request that
   * bothered to set a plausible Referer, and no other test here would go red.
   */
  it("rejects a disallowed Origin EVEN WITH a valid allowed Referer", () => {
    const request = postRequest({
      Origin: "https://evil.com",
      Referer: "https://thinkersjournal.com/x",
    });
    expect(checkOrigin(request)).toBe(false);
  });

  it("falls back to a valid allowed Referer when Origin is absent", () => {
    const request = postRequest({
      Referer: "https://thinkersjournal.com/some/page?query=1",
    });
    expect(checkOrigin(request)).toBe(true);
  });

  it("rejects a malformed Referer without throwing", () => {
    const request = postRequest({ Referer: "not a url at all" });
    expect(() => checkOrigin(request)).not.toThrow();
    expect(checkOrigin(request)).toBe(false);
  });

  it("fails closed when both Origin and Referer are missing on a non-GET", () => {
    const request = postRequest({});
    expect(checkOrigin(request)).toBe(false);
  });

  it("always allows GET regardless of headers", () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "GET",
      headers: { Origin: "https://evil.com" },
    });
    expect(checkOrigin(request)).toBe(true);
  });

  it("always allows HEAD regardless of headers", () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "HEAD",
    });
    expect(checkOrigin(request)).toBe(true);
  });

  /**
   * The two LOCAL DEV origins in the allowlist, pinned by exact string.
   *
   * These are load-bearing for local dev and for the E2E suite, which drives a
   * real browser against `http://localhost:8787` — every mutating request it
   * makes carries one of these as its `Origin` and 403s at the pipeline's first
   * step without them. Nothing else in the unit suite asserts them, so an
   * accidental edit (a typo, a "tidy-up" dropping the `127.0.0.1` spelling as
   * redundant, an over-eager prod-only hardening) would go unnoticed here and
   * surface only as a baffling E2E failure. Both spellings are required: a
   * browser sends whichever the developer typed, and they are DIFFERENT origins.
   */
  it.each(["http://localhost:8787", "http://127.0.0.1:8787"])(
    "allows the localhost dev origin %s",
    (origin) => {
      expect(checkOrigin(postRequest({ Origin: origin }))).toBe(true);
    },
  );
});

/**
 * The allowlist is a property of the METHOD CLASS (anything not GET/HEAD), not
 * of POST. Only POST was exercised above; a `method === "POST"` check
 * substituted for the safe-method guard would pass every one of those cases
 * while leaving PUT/PATCH/DELETE — which the API will grow in M1 — completely
 * unguarded.
 */
describe("checkOrigin across unsafe methods", () => {
  it.each(UNSAFE_METHODS)("allows %s from an allowed Origin", (method) => {
    const request = requestWithMethod(method, {
      Origin: "https://thinkersjournal.com",
    });
    expect(checkOrigin(request)).toBe(true);
  });

  it.each(UNSAFE_METHODS)("rejects %s from a disallowed Origin", (method) => {
    const request = requestWithMethod(method, { Origin: "https://evil.com" });
    expect(checkOrigin(request)).toBe(false);
  });

  it.each(UNSAFE_METHODS)(
    "fails closed on %s with neither Origin nor Referer",
    (method) => {
      expect(checkOrigin(requestWithMethod(method, {}))).toBe(false);
    },
  );
});

describe("csrfTokenFor", () => {
  it("returns the hex-encoded SHA-256 digest of the session's csrfSecret", async () => {
    const token = await csrfTokenFor(sampleSession);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Same secret -> same token, deterministically.
    expect(await csrfTokenFor(sampleSession)).toBe(token);

    // Independently computable via raw WebCrypto for the same secret.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sampleSession.csrfSecret),
    );
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(token).toBe(expected);
  });

  it("never exposes the raw csrfSecret in the token", async () => {
    const token = await csrfTokenFor(sampleSession);
    expect(token).not.toContain(sampleSession.csrfSecret);
  });
});

describe("checkCsrf", () => {
  it("accepts a POST carrying the correct X-CSRF-Token", async () => {
    const token = await csrfTokenFor(sampleSession);
    const request = postRequest({
      Origin: "https://thinkersjournal.com",
      "X-CSRF-Token": token,
    });
    expect(await checkCsrf(request, sampleSession)).toBe(true);
  });

  it("rejects a POST with a missing X-CSRF-Token", async () => {
    const request = postRequest({ Origin: "https://thinkersjournal.com" });
    expect(await checkCsrf(request, sampleSession)).toBe(false);
  });

  it("rejects a POST with an incorrect X-CSRF-Token", async () => {
    const request = postRequest({
      Origin: "https://thinkersjournal.com",
      "X-CSRF-Token": "0".repeat(64),
    });
    expect(await checkCsrf(request, sampleSession)).toBe(false);
  });

  it("rejects a token of the wrong length outright (no throw)", async () => {
    const request = postRequest({ "X-CSRF-Token": "too-short" });
    expect(await checkCsrf(request, sampleSession)).toBe(false);
  });

  it("always allows GET regardless of headers/token", async () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "GET",
    });
    expect(await checkCsrf(request, sampleSession)).toBe(true);
  });

  it("always allows HEAD regardless of headers/token", async () => {
    const request = new Request("https://api.test/some-endpoint", {
      method: "HEAD",
    });
    expect(await checkCsrf(request, sampleSession)).toBe(true);
  });
});

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

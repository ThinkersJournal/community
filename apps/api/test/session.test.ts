import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { SessionData } from "@thinkersjournal/shared";

import { createSession, destroySession, readSession } from "../src/auth/session";

// Runs in the POOL project (real workerd) because it needs the `SESSIONS` KV
// binding. The pool's `isolatedStorage` was removed, so KV contents can
// persist across tests within this file — clear it in `beforeEach` so every
// test starts from an empty namespace.
beforeEach(async () => {
  const { keys } = await env.SESSIONS.list();
  await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
});

/** Build a `Request` carrying the given raw session token as its Cookie header. */
function requestWithCookie(token: string): Request {
  return new Request("https://api.test/", {
    headers: { Cookie: `tj_session=${token}` },
  });
}

/** Extract the raw token value from a `Set-Cookie`-shaped string produced by session.ts. */
function extractToken(cookie: string): string {
  const match = /^tj_session=([^;]*)/.exec(cookie);
  if (match === null) {
    throw new Error(`cookie did not match expected shape: ${cookie}`);
  }
  return match[1]!;
}

const sampleData: SessionData = {
  userId: "11111111-1111-1111-1111-111111111111",
  roles: ["member"],
  securityEpoch: 1,
  csrfSecret: "csrf-secret-value",
  createdAt: Date.now(),
};

describe("session primitive (opaque KV token)", () => {
  it("round-trips: createSession -> readSession returns the same userId/securityEpoch", async () => {
    const { cookie } = await createSession(env, sampleData);
    const token = extractToken(cookie);

    const request = requestWithCookie(token);
    const session = await readSession(env, request);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(sampleData.userId);
    expect(session?.securityEpoch).toBe(sampleData.securityEpoch);
  });

  it("returns a cookie string with the exact required attributes", async () => {
    const { cookie } = await createSession(env, sampleData);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Domain=.thinkersjournal.com");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie.startsWith("tj_session=")).toBe(true);
  });

  it("readSession returns null when there is no cookie", async () => {
    const request = new Request("https://api.test/");
    expect(await readSession(env, request)).toBeNull();
  });

  it("readSession returns null for an unknown/forged token", async () => {
    const request = requestWithCookie("forged-token-that-was-never-issued");
    expect(await readSession(env, request)).toBeNull();
  });

  it("destroySession deletes the KV entry and returns a cleared (Max-Age=0) cookie", async () => {
    const { cookie: createCookie } = await createSession(env, sampleData);
    const token = extractToken(createCookie);
    const request = requestWithCookie(token);

    const { cookie: clearCookie } = await destroySession(env, request);

    expect(clearCookie).toContain("Max-Age=0");
    expect(clearCookie).toContain("tj_session=;");
    expect(clearCookie).toContain("HttpOnly");
    expect(clearCookie).toContain("Secure");
    expect(clearCookie).toContain("SameSite=Lax");
    expect(clearCookie).toContain("Domain=.thinkersjournal.com");

    expect(await readSession(env, request)).toBeNull();
  });

  it("never stores the raw token as the KV key — the key is the SHA-256 hash", async () => {
    const { cookie } = await createSession(env, sampleData);
    const token = extractToken(cookie);

    // The raw token must NOT be usable directly as a KV key.
    expect(await env.SESSIONS.get(`sess:${token}`)).toBeNull();
    expect(await env.SESSIONS.get(token)).toBeNull();

    // Exactly one key should exist, and it must not equal the raw token or
    // contain it as a substring (i.e. it's a hash, not the token itself).
    const { keys } = await env.SESSIONS.list();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).not.toBe(token);
    expect(keys[0]!.name).not.toContain(token);
    expect(keys[0]!.name.startsWith("sess:")).toBe(true);

    // The hashed key really does hold the stored session value.
    const stored = await env.SESSIONS.get(keys[0]!.name);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as SessionData;
    expect(parsed.userId).toBe(sampleData.userId);
  });
});

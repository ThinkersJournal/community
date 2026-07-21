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

/**
 * The env as PRODUCTION sees it: `TEST_ROUTES` unset.
 *
 * ⚠️ The pool's `miniflare.bindings` (vitest.config.ts) set `TEST_ROUTES: "1"`
 * for the whole suite, so the ambient `env` is always the DEV shape. Production
 * cookie attributes can therefore only be exercised by overriding the flag —
 * which is exactly why both modes are pinned below rather than just the one the
 * test runner happens to produce.
 *
 * ⚠️ The `as unknown as Env` cast is load-bearing, not laziness. The generated
 * `src/worker-configuration.d.ts` declares `TEST_ROUTES: string` — REQUIRED —
 * because `wrangler types` infers vars from the local `.dev.vars`. Production
 * does not set it at all, so the true runtime type is `string | undefined` and
 * the declaration overstates it. Modelling the real production env therefore
 * requires stepping outside that (inaccurate) type. Runtime behavior is what is
 * asserted here, and `buildCookie` reads the value defensively (`=== "1"`).
 */
function prodEnv(): Env {
  return { ...env, TEST_ROUTES: undefined } as unknown as Env;
}

/** The EXACT `Set-Cookie` production must emit. Any drift here is a real defect. */
function expectedProdCookie(token: string, maxAge: number): string {
  return `tj_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
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
    const { cookie } = await createSession(prodEnv(), sampleData);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    // HOST-ONLY: the production cookie carries NO Domain attribute at all.
    expect(cookie).not.toContain("Domain=");
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
    expect(clearCookie).toContain("SameSite=Lax");
    expect(clearCookie).toContain("Path=/");

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

/**
 * ⚠️ SECURITY-CRITICAL — the cookie's attributes are environment-dependent, and
 * BOTH modes are pinned here because each protects against a different failure.
 *
 * WHY THE SPLIT EXISTS AT ALL. The production `Secure` attribute makes the
 * cookie IMPOSSIBLE for any browser to store at `http://127.0.0.1:8787`:
 * `Secure` requires https. So a real-browser E2E — and a human clicking
 * through localhost — could never hold a session. The dev shape omits exactly
 * that one attribute and nothing else. NEITHER mode ever sets `Domain`: the
 * production cookie is HOST-ONLY, scoped to exactly
 * `community.thinkersjournal.com` (the single host the app is served from) by
 * the browser's default same-origin cookie scoping.
 *
 * WHY IT IS KEYED ON `TEST_ROUTES` and NOT a second flag. `TEST_ROUTES` is
 * already the single most deploy-gated var in the system: it gates the
 * `__test/last-verify-token` route, which hands out an account-takeover
 * credential, so the deploy gate ALREADY asserts its absence and the route
 * ALREADY 404s without it. One flag with one gate cannot drift out of sync;
 * two flags can — and the failure mode of the second flag being set in prod is a
 * session cookie silently losing `Secure`, which is a plaintext-interception
 * bug that nothing else would catch.
 *
 * ⚠️ THE PROD ASSERTION BELOW IS THE LOAD-BEARING ONE. The suite runs with
 * `TEST_ROUTES="1"` (vitest.config.ts's `miniflare.bindings`), so WITHOUT an
 * explicit prod-env override every cookie test would exercise the dev shape and
 * the production string would be entirely unpinned — a regression dropping
 * `Secure` in prod would ship green. Do not delete `prodEnv()`.
 */
describe("session cookie attributes are environment-aware", () => {
  describe("dev/CI (TEST_ROUTES=1)", () => {
    it("createSession OMITS Secure so a browser can store it on http://127.0.0.1", async () => {
      const { cookie } = await createSession(env, sampleData);

      // THE POINT: this is what makes the cookie unstorable in local dev.
      expect(cookie).not.toContain("Secure");
      // Neither mode ever sets Domain — the cookie is host-only in both.
      expect(cookie).not.toContain("Domain");

      // Everything else is unchanged from production — the dev shape relaxes
      // exactly one attribute, not the cookie's other defenses.
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=2592000");
      expect(cookie.startsWith("tj_session=")).toBe(true);
    });

    it("destroySession's cleared cookie matches the set cookie's attributes", async () => {
      const { cookie: createCookie } = await createSession(env, sampleData);
      const request = requestWithCookie(extractToken(createCookie));

      const { cookie: clearCookie } = await destroySession(env, request);

      // ⚠️ A browser only drops a cookie when the clearing Set-Cookie carries
      // the SAME Path/Secure as the one that set it. A mismatch here means
      // logout leaves the session cookie in the browser — it would look like a
      // successful logout while the cookie survived.
      expect(clearCookie).not.toContain("Secure");
      expect(clearCookie).not.toContain("Domain");
      expect(clearCookie).toBe(
        "tj_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      );
    });
  });

  describe("production (TEST_ROUTES unset)", () => {
    it("createSession emits the EXACT production cookie string", async () => {
      const { cookie } = await createSession(prodEnv(), sampleData);
      const token = extractToken(cookie);

      // Asserted as an EXACT string, not `toContain` fragments: attribute ORDER
      // and the full set are both pinned, so nothing can be quietly dropped.
      expect(cookie).toBe(expectedProdCookie(token, 2_592_000));
      expect(cookie).toContain("Secure");
      // HOST-ONLY: no Domain attribute — scoped to the exact serving host.
      expect(cookie).not.toContain("Domain=");
    });

    it("destroySession emits the EXACT cleared production cookie string", async () => {
      const { cookie: createCookie } = await createSession(env, sampleData);
      const request = requestWithCookie(extractToken(createCookie));

      const { cookie: clearCookie } = await destroySession(prodEnv(), request);

      expect(clearCookie).toBe(expectedProdCookie("", 0));
      expect(clearCookie).toContain("Secure");
      expect(clearCookie).not.toContain("Domain=");
    });

    it("treats any TEST_ROUTES value other than exactly \"1\" as production", async () => {
      // Vars are always STRINGS, so "0"/"false" are truthy — a truthiness check
      // here would strip `Secure` for someone setting "0" to mean "off". Fail
      // closed on everything but the literal "1", matching the __test route's
      // gate (src/routes/__test.ts) and the stash gate (src/auth/email-verify.ts).
      for (const value of ["0", "false", "true", "", "yes", " 1"]) {
        const { cookie } = await createSession(
          { ...env, TEST_ROUTES: value } as unknown as Env,
          sampleData,
        );
        expect(cookie).toContain("Secure");
        expect(cookie).not.toContain("Domain=");
      }
    });
  });
});

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";

/**
 * `GET /admin/media-access-requests` (endpoint/UI audit, 2026-09-24) — the
 * two-person grant queue's data source. Same JWT-construction technique as
 * admin-queue-route.test.ts (a real RSA key pair, a stubbed JWKS fetch).
 */
const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;

async function makeJwt(email = "mod@example.com", claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({
    iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1",
    email, exp: now + 600, ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const ALLOWED_ORIGIN = "http://localhost:8787";

async function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function post(path: string, jwt: string, body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Cf-Access-Jwt-Assertion": jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
      { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * A fresh 64-hex-char value per call. ⚠️ NOT a literal like `"a".repeat(64)`
 * — the vitest-pool-workers test DATABASE PERSISTS across runs (same
 * discipline as apps/api/test/actor.ts's per-call-unique email/username), so
 * a fixed sha256 collides with rows a PRIOR run left behind and this list
 * has no truncation/expiry path to clean them up. Every assertion below also
 * uses `.find()`/`.some()` against this run's own id, never an exact array
 * length or `toEqual` on the whole list, for the same reason.
 */
function randomSha(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
}

describe("GET /admin/media-access-requests", () => {
  it("401s with ADMIN_REQUIRED when the Access header is absent", async () => {
    const res = await call("/admin/media-access-requests");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("401s when the Access JWT is invalid", async () => {
    const res = await call("/admin/media-access-requests", { "Cf-Access-Jwt-Assertion": "not.a.jwt" });
    expect(res.status).toBe(401);
  });

  it("⚠️ a member session confers NO access — same property as the queue", async () => {
    const res = await call("/admin/media-access-requests", { cookie: "tj_session=whatever-a-member-sends" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("lists a pending request with a display sha256 derived from the r2 key, and excludes an already-approved one", async () => {
    const requesterJwt = await makeJwt("requester@example.com");
    const approverJwt = await makeJwt("approver@example.com");
    const sha = randomSha();

    const reqRes = await post("/admin/media-access-requests", requesterJwt, { sha256: sha, reason: "DSA review" });
    expect(reqRes.status).toBe(201);
    const { id } = (await reqRes.json()) as { id: string };

    const beforeApprove = await call("/admin/media-access-requests", {
      "Cf-Access-Jwt-Assertion": await makeJwt("someone-else@example.com"),
    });
    const before = (await beforeApprove.json()) as {
      requests: { id: string; sha256: string; requestedBy: string; reason: string }[];
    };
    const listed = before.requests.find((r) => r.id === id);
    expect(listed).toMatchObject({ sha256: sha, requestedBy: "requester@example.com", reason: "DSA review" });

    // A DIFFERENT admin approves — the approved row must drop off the list.
    const ctx = createExecutionContext();
    const approveRes = await worker.fetch(
      new Request(`https://api.test/admin/media-access-requests/${id}/approve`, {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "Cf-Access-Jwt-Assertion": approverJwt },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(approveRes.status).toBe(204);

    const afterApprove = await call("/admin/media-access-requests", {
      "Cf-Access-Jwt-Assertion": await makeJwt("someone-else@example.com"),
    });
    const after = (await afterApprove.json()) as { requests: { id: string }[] };
    expect(after.requests.some((r) => r.id === id)).toBe(false);
  });

  it("a request NOT yet approved stays listed alongside others — positive control for the exclusion above", async () => {
    const requesterJwt = await makeJwt("requester2@example.com");
    const sha = randomSha();
    const reqRes = await post("/admin/media-access-requests", requesterJwt, { sha256: sha, reason: "still pending" });
    const { id } = (await reqRes.json()) as { id: string };

    const res = await call("/admin/media-access-requests", { "Cf-Access-Jwt-Assertion": await makeJwt() });
    const body = (await res.json()) as { requests: { id: string }[] };
    expect(body.requests.some((r) => r.id === id)).toBe(true);
  });
});

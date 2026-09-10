import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;

async function makeJwt(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({
    iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1",
    email: "mod@example.com", exp: now + 600, ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, { headers }), env, ctx);
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

describe("GET /admin/queue", () => {
  it("401s with ADMIN_REQUIRED when the Access header is absent", async () => {
    const res = await call("/admin/queue");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("401s when the Access JWT is invalid", async () => {
    const res = await call("/admin/queue", { "Cf-Access-Jwt-Assertion": "not.a.jwt" });
    expect(res.status).toBe(401);
  });

  // ⚠️ THE DECLARED EXEMPTION, RE-CHECKED. The queue query deliberately reads
  // HIDDEN rows and lives outside the tree hidden-at-read-guard scans. The
  // property that makes that safe is that it is reachable ONLY by an Access
  // principal — not that it happens to sit in src/moderation/. This asserts the
  // property directly, so a future refactor that exposes it another way fails.
  it("⚠️ a member session confers NO access to the queue", async () => {
    const res = await call("/admin/queue", { cookie: "tj_session=whatever-a-member-sends" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("200s with a JSON array for a valid Access JWT", async () => {
    const res = await call("/admin/queue", { "Cf-Access-Jwt-Assertion": await makeJwt() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray((body as { items: unknown }).items)).toBe(true);
  });
});

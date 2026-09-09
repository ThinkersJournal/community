import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetJwksCacheForTests, verifyAccessJwt } from "../src/admin/access-jwt";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;

/** Sign a JWT with the test key. Claims are merged over a valid baseline. */
async function makeJwt(claims: Record<string, unknown> = {}, kid = KID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid, typ: "JWT" });
  const payload = b64urlJson({
    iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1",
    email: "mod@example.com", iat: now, exp: now + 600, ...claims,
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, data);
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

beforeEach(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the identity", async () => {
    const id = await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    expect(id).toEqual({ email: "mod@example.com", sub: "user-sub-1" });
  });

  it("rejects a token whose signature does not verify", async () => {
    const token = await makeJwt();
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(await verifyAccessJwt(tampered, TEAM, AUD)).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    expect(await verifyAccessJwt(await makeJwt({ aud: ["someone-elses-app"] }), TEAM, AUD)).toBeNull();
  });

  it("rejects the wrong issuer", async () => {
    expect(await verifyAccessJwt(await makeJwt({ iss: "https://evil.cloudflareaccess.com" }), TEAM, AUD)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await verifyAccessJwt(await makeJwt({ exp: past }), TEAM, AUD)).toBeNull();
  });

  it("rejects an unknown kid", async () => {
    expect(await verifyAccessJwt(await makeJwt({}, "some-other-kid"), TEAM, AUD)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyAccessJwt("not.a.jwt", TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt("", TEAM, AUD)).toBeNull();
  });

  it("⚠️ rejects alg=none — the classic JWT bypass", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "none", kid: KID, typ: "JWT" });
    const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "s", email: "e@x", exp: now + 600 });
    expect(await verifyAccessJwt(`${header}.${payload}.`, TEAM, AUD)).toBeNull();
  });

  it("caches the JWKS rather than refetching per call", async () => {
    await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});

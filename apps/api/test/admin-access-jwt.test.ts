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

  // NOTE: this token's signature is the empty string, so it is rejected by the
  // SIGNATURE check regardless of whether `alg` is pinned — it cannot
  // distinguish "alg pinned" from "alg not pinned". It is kept because an
  // empty/malformed signature is a real case worth covering, but the alg pin
  // itself is proven by the test below, which gives this exact header a
  // genuinely valid RS256 signature.
  it("rejects a token with an empty signature (alg=none, unsigned)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "none", kid: KID, typ: "JWT" });
    const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "s", email: "e@x", exp: now + 600 });
    expect(await verifyAccessJwt(`${header}.${payload}.`, TEAM, AUD)).toBeNull();
  });

  // ⚠️ THE DISCRIMINATING alg=none TEST. The header claims `alg: "none"` but
  // carries the real `kid`, and the payload is signed for real, over this
  // EXACT `header.payload` string, with the test's RSA private key —
  // `crypto.subtle.sign("RSASSA-PKCS1-v1_5", ...)`, the same primitive
  // `verifyAccessJwt` hardcodes regardless of the token's own `alg` claim.
  // So the signature GENUINELY VERIFIES and every other claim (iss/aud/exp/
  // sub/email) is valid too. The alg pin is therefore the ONLY thing that can
  // reject this token: with it present, `header.alg !== "RS256"` rejects
  // before the signature is ever checked; without it, the kid resolves, the
  // RSA signature over these exact bytes verifies, and the caller would get
  // back a live identity. Unlike the empty-signature case above, this token
  // WOULD be accepted if the alg pin were removed — that is what makes it
  // load-bearing for the pin specifically, not for signature checking.
  it("⚠️ rejects alg=none even with a genuinely valid RSA signature over that header — the alg pin, not signature failure, must do the rejecting", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "none", kid: KID, typ: "JWT" });
    const payload = b64urlJson({
      iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1", email: "mod@example.com", exp: now + 600,
    });
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, data);
    const token = `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
    expect(await verifyAccessJwt(token, TEAM, AUD)).toBeNull();
  });

  it("caches the JWKS rather than refetching per call", async () => {
    await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    await verifyAccessJwt(await makeJwt(), TEAM, AUD);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  // ⚠️ THE LOCKOUT REGRESSION TEST. A momentary network blip during the JWKS
  // fetch must cost exactly ONE failed request — not an hour of total admin
  // lockout. Under the bug, `loadKeys` writes the module-level `cache`
  // unconditionally, even when the fetch threw and the key map is empty. That
  // empty set then satisfies the TTL check on every subsequent call for a
  // full `JWKS_TTL_MS` (1h), so a token that is perfectly valid — signed by a
  // real key the IdP is serving again one line later — is rejected anyway,
  // because the (empty, stale) cache is trusted instead of being refreshed.
  it("recovers on the very next call after a transient JWKS fetch failure (does not cache an empty key set)", async () => {
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const token = await makeJwt();

    // Step 1: the fetch fails outright (simulates a transient network blip).
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("simulated transient network failure");
    }));
    expect(await verifyAccessJwt(token, TEAM, AUD)).toBeNull();

    // Step 2: the IdP is healthy again on the very next call. An otherwise
    // identical, genuinely valid token must now succeed — under the bug it
    // does not, because step 1 cached the empty key set for the next hour.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      })));
    expect(await verifyAccessJwt(token, TEAM, AUD)).toEqual({ email: "mod@example.com", sub: "user-sub-1" });
  });
});

// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3b: the GitHub App JWT (RS256 via WebCrypto). GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"), which
// WebCrypto cannot import, so both PEM shapes are covered. Tests generate their own throwaway key.
import { beforeAll, describe, expect, it } from "vitest";

import { GithubAppConfigError, mintAppJwt } from "../src/references/github-app-auth";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/(.{64})/g, "$1\n");
}
function pem(label: string, der: Uint8Array): string {
  return `-----BEGIN ${label}-----\n${b64(der)}\n-----END ${label}-----\n`;
}
function unb64url(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
function decode(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(unb64url(part))) as Record<string, unknown>;
}

let pkcs8: Uint8Array;
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  publicKey = pair.publicKey;
});

async function verifies(jwt: string): Promise<boolean> {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, unb64url(s), new TextEncoder().encode(`${h}.${p}`));
}

describe("mintAppJwt", () => {
  it("signs RS256 with iss = the App ID and a short, back-dated window (PKCS#8 key)", async () => {
    const jwt = await mintAppJwt("5732881", pem("PRIVATE KEY", pkcs8), 1_800_000_000);
    const [h, p] = jwt.split(".") as [string, string];
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(p)).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "5732881" });
    expect(await verifies(jwt)).toBe(true);
  });

  it("accepts GitHub's own PKCS#1 key shape (the 26-byte PKCS#8 wrapper is added)", async () => {
    const pkcs1 = pkcs8.slice(26);
    const jwt = await mintAppJwt("5732881", pem("RSA PRIVATE KEY", pkcs1), 1_800_000_000);
    expect(await verifies(jwt)).toBe(true);
  });

  it("a signature over different bytes does not verify (control: the check can fail)", async () => {
    const jwt = await mintAppJwt("5732881", pem("PRIVATE KEY", pkcs8), 1_800_000_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const tampered = `${h}.${p.slice(0, -2)}AA.${s}`;
    expect(await verifies(tampered)).toBe(false);
  });

  it("a missing App ID is a named error that says which setting", async () => {
    const err = await mintAppJwt(undefined, pem("PRIVATE KEY", pkcs8), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAppConfigError);
    expect((err as GithubAppConfigError).missing).toBe("GITHUB_APP_ID");
  });

  it("a non-numeric App ID is refused as config", async () => {
    const err = await mintAppJwt("abc", pem("PRIVATE KEY", pkcs8), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAppConfigError);
    expect((err as GithubAppConfigError).missing).toBe("GITHUB_APP_ID");
  });

  it("a missing or unreadable private key is a named error and never echoes the key text", async () => {
    const none = await mintAppJwt("5732881", undefined, 1).catch((e: unknown) => e);
    expect((none as GithubAppConfigError).missing).toBe("GITHUB_APP_PRIVATE_KEY");
    const junk = await mintAppJwt("5732881", "-----BEGIN PRIVATE KEY-----\nSECRETJUNK\n-----END PRIVATE KEY-----", 1).catch((e: unknown) => e);
    expect(junk).toBeInstanceOf(GithubAppConfigError);
    expect(String((junk as Error).message)).not.toContain("SECRETJUNK");
  });
});

// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * GitHub App authentication (M3.3b): signs the App JWT (RS256, WebCrypto). No I/O in this file: it only signs. The
 * network call that trades the JWT for an installation token goes through the guarded door, never from here.
 *
 * ⚠️ GitHub hands out the private key as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports only PKCS#8, so a PKCS#1 key
 * is wrapped in the fixed RSA PKCS#8 header first. ⚠️ A key is never echoed: every failure names the SETTING, not its text.
 */
export class GithubAppConfigError extends Error {
  constructor(readonly missing: "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY") {
    super(`github app config missing or unusable: ${missing}`);
    this.name = "GithubAppConfigError";
  }
}

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DER length octets for a definite length. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, (n >> 8) & 0xff, n & 0xff];
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo (rsaEncryption, NULL parameters). */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  const header = [0x30, ...derLength(inner.length + pkcs1.length)];
  const out = new Uint8Array(new ArrayBuffer(header.length + inner.length + pkcs1.length));
  out.set(header, 0);
  out.set(inner, header.length);
  out.set(pkcs1, header.length + inner.length);
  return out;
}

function derOf(pem: string): { der: Uint8Array<ArrayBuffer>; pkcs1: boolean } {
  const m = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----/.exec(pem);
  if (m === null) throw new GithubAppConfigError("GITHUB_APP_PRIVATE_KEY");
  const bin = atob((m[2] ?? "").replace(/\s+/g, ""));
  const der = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1: m[1] === "RSA PRIVATE KEY" };
}

async function importKey(pem: string): Promise<CryptoKey> {
  try {
    const { der, pkcs1 } = derOf(pem);
    return await crypto.subtle.importKey("pkcs8", pkcs1 ? pkcs1ToPkcs8(der) : der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GithubAppConfigError("GITHUB_APP_PRIVATE_KEY");
  }
}

/** The App JWT: back-dated 60 s for clock skew, valid 9 minutes (GitHub's maximum is 10). */
export async function mintAppJwt(appId: string | undefined, privateKeyPem: string | undefined, nowSec: number): Promise<string> {
  if (appId === undefined || !/^\d+$/.test(appId)) throw new GithubAppConfigError("GITHUB_APP_ID");
  if (privateKeyPem === undefined || privateKeyPem === "") throw new GithubAppConfigError("GITHUB_APP_PRIVATE_KEY");
  const key = await importKey(privateKeyPem);
  const head = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(new Uint8Array(sig))}`;
}

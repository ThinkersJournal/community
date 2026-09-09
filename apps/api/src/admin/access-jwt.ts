/**
 * Cloudflare Access JWT verification — the ONLY source of admin authority.
 *
 * ⚠️ A DIFFERENT TRUST DOMAIN FROM MEMBER SESSIONS. `SessionData.roles` exists,
 * is always `[]`, and is never read for authorization anywhere. A member
 * session must never confer moderator authority: the admin surface sits behind
 * Cloudflare Access, and the Access JWT is what proves an operator.
 *
 * ⚠️ THE SIGNATURE IS CHECKED BEFORE ANY CLAIM IS TRUSTED, and `alg` is pinned
 * to RS256. Reading claims from an unverified token — or honouring the `alg`
 * the token itself asks for — is the classic JWT bypass.
 *
 * Never throws: every failure returns `null`, so a caller cannot accidentally
 * treat a thrown error as an authenticated request.
 */
export interface AdminIdentity {
  readonly email: string;
  readonly sub: string;
}

interface Jwk { kid?: string; alg?: string; kty?: string; n?: string; e?: string }

const JWKS_TTL_MS = 3_600_000; // 1h

let cache: { teamDomain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

/** Test seam — the module-level cache would otherwise leak between test cases. */
export function __resetJwksCacheForTests(): void {
  cache = null;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlToJson<T>(s: string): T | null {
  const bytes = b64urlToBytes(s);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  if (cache !== null && cache.teamDomain === teamDomain && Date.now() - cache.fetchedAt < JWKS_TTL_MS) {
    return cache.keys;
  }
  const keys = new Map<string, CryptoKey>();
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { keys?: Jwk[] };
      for (const jwk of body.keys ?? []) {
        if (jwk.kid === undefined) continue;
        try {
          keys.set(
            jwk.kid,
            await crypto.subtle.importKey(
              "jwk",
              { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] } as JsonWebKey,
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            ),
          );
        } catch {
          // A single unusable key must not discard the rest of the set.
        }
      }
    }
  } catch (err) {
    console.error("access jwks fetch failed", { err });
  }
  // ⚠️ Only cache a load that genuinely succeeded (a 2xx response that yielded
  // at least one importable key). Caching an empty set on a transient fetch
  // failure would lock out every admin for the full JWKS_TTL_MS (1h) — the
  // very next request must be free to retry instead of trusting a bad cache.
  if (keys.size > 0) {
    cache = { teamDomain, fetchedAt: Date.now(), keys };
  }
  return keys;
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<AdminIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  const header = b64urlToJson<{ alg?: string; kid?: string }>(rawHeader);
  // ⚠️ Pin the algorithm. `alg: "none"`, and any alg swap, dies here.
  if (header === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const keys = await loadKeys(teamDomain);
  const key = keys.get(header.kid);
  if (key === undefined) return null;

  const sig = b64urlToBytes(rawSig);
  if (sig === null) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) return null;

  const claims = b64urlToJson<{
    iss?: string; aud?: string | string[]; sub?: string; email?: string; exp?: number; nbf?: number;
  }>(rawPayload);
  if (claims === null) return null;

  if (claims.iss !== `https://${teamDomain}`) return null;

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud];
  if (!audiences.includes(aud)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now) return null;

  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return null;
  return { email: claims.email, sub: claims.sub };
}

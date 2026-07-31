/**
 * Stateless HMAC unsubscribe tokens (M2.3c). token = base64url(userId) "."
 * base64url(HMAC_SHA256(userId, UNSUBSCRIBE_SIGNING_KEY)). No storage, idempotent,
 * never expires — correct for an unsubscribe link a user may click months later.
 * The token authenticates a one-click POST that comes cross-origin from a mail
 * provider with no cookie, and its only possible effect is master_enabled=false
 * for THIS userId — no escalation.
 */
import { base64urlEncode } from "../auth/encoding";

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(env: Env, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.UNSUBSCRIBE_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

export async function mintUnsubToken(env: Env, userId: string): Promise<string> {
  const payload = base64urlEncode(new TextEncoder().encode(userId));
  const sig = base64urlEncode(await hmac(env, userId));
  return `${payload}.${sig}`;
}

/** Constant-time verify. Returns the userId or null. */
export async function verifyUnsubToken(env: Env, token: string): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadBytes = b64urlToBytes(token.slice(0, dot));
  const sigBytes = b64urlToBytes(token.slice(dot + 1));
  if (payloadBytes === null || sigBytes === null) return null;
  const userId = new TextDecoder().decode(payloadBytes);
  const expected = await hmac(env, userId);
  if (sigBytes.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sigBytes[i]! ^ expected[i]!;
  return diff === 0 ? userId : null;
}

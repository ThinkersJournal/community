/**
 * The two byte/digest encoding primitives the `api` Worker's auth paths share.
 *
 * Extracted here because both were byte-duplicated across src/auth/session.ts,
 * src/auth/csrf.ts, src/auth/email-verify.ts, src/routes/signup.ts and
 * src/routes/login.ts. That duplication was not merely untidy: each copy backs a
 * SECURITY property, and the copies had to agree EXACTLY for those properties to
 * hold. `sessionKey` and `verifyKey` hash their tokens with `sha256Hex` before
 * they ever reach KV, and the KV records they wrote are only findable again by a
 * byte-identical re-derivation — so a "cleanup" to one copy (uppercase hex, a
 * different digest, base64 instead of hex) would silently orphan every live
 * session and verification token rather than fail any test. One definition means
 * there is no longer a set of copies that can drift apart.
 *
 * ⚠️ THE OUTPUT FORMATS ARE A WIRE/STORAGE CONTRACT, NOT AN IMPLEMENTATION
 * DETAIL. Do not change the alphabet, the padding, or the casing of either
 * function. Specifically:
 *   - `sha256Hex` is LOWERCASE hex. It is the KV key suffix for both sessions and
 *     verification tokens (so its output must stay stable for the lifetime of any
 *     record — 30 days and 24h respectively), AND it is the CSRF token handed to
 *     the client (src/auth/csrf.ts), which `checkCsrf` compares with a
 *     LENGTH-SENSITIVE timing-safe equality: a 64-char lowercase digest is what
 *     every live client already holds.
 *   - `base64urlEncode` is URL-safe and UNPADDED. Its output travels in a
 *     `Set-Cookie` value and in an emailed `?token=` query parameter, where `+`,
 *     `/` and `=` are all characters that would need escaping or would be
 *     mangled in transit.
 */

/** Base64url-encode (URL-safe, no padding) raw bytes — RFC 4648 §5. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex-encode (lowercase) the SHA-256 digest of `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

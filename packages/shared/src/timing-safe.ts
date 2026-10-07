/**
 * Constant-time string comparison that leaks neither WHERE two strings differ
 * nor HOW LONG either one is.
 *
 * Both inputs are SHA-256'd first, and the XOR-accumulate loop then runs over two
 * fixed 32-byte digests — no early return on the first mismatch, and none on a
 * length mismatch either, because there is no length left to differ.
 *
 * ⚠️ WHY HASH FIRST (brute-force audit, 2026-10-06, item #23). The previous version
 * returned `false` immediately when the lengths differed. For CSRF that was
 * harmless (both sides are 64-char hex digests), but `web` compares the purge
 * shared secret against whatever the PUBLIC internet sends, and an early length
 * return tells a patient caller the secret's length by timing. Hashing makes every
 * comparison the same shape. Equal digests mean equal inputs: the bytes hashed are
 * the strings' UTF-16 code units, so this is exact string equality (a TextEncoder
 * round trip would map distinct lone surrogates to the same U+FFFD).
 *
 * ⚠️ ASYNC, because `crypto.subtle.digest` is. Both callers were already async
 * (`checkCsrf` in apps/api/src/auth/csrf.ts, `handlePurgeRequest` in
 * apps/web/src/lib/purge.ts); a caller that forgets the `await` gets a Promise,
 * which is TRUTHY — so `if (timingSafeEqual(...))` without `await` would authorize
 * everything. TypeScript's `strict` flags a Promise in a condition only with the
 * no-misused-promises lint, which this repo does not run: keep the `await`.
 *
 * ⚠️ SHARED BECAUSE BOTH WORKERS NEED IT AND A SECOND COPY WOULD DRIFT — the
 * same reasoning as apps/api/src/auth/encoding.ts. A "cleanup" that early-returns
 * on the first differing byte, or on a length mismatch, would silently turn either
 * caller into a timing oracle while every test stayed green — which is exactly
 * why there must be one definition and not two.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digestCodeUnits(a), digestCodeUnits(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i]! ^ db[i]!;
  }
  return diff === 0;
}

/** SHA-256 over `s`'s UTF-16 code units (little-endian), as 32 bytes. */
async function digestCodeUnits(s: string): Promise<Uint8Array> {
  const units = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    units[i * 2] = c & 0xff;
    units[i * 2 + 1] = c >> 8;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", units));
}

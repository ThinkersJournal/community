/**
 * Constant-time string comparison: accumulates XOR differences over the FULL
 * length of both strings (no early return on the first mismatch), so the time
 * taken does not leak how many leading characters matched. Callers are expected
 * to pass fixed-length strings (64-char hex digests); a length mismatch is
 * reported immediately (its own length check does not leak useful timing
 * information about digest content) but no character comparison short-circuits.
 *
 * ⚠️ SHARED BECAUSE BOTH WORKERS NEED IT AND A SECOND COPY WOULD DRIFT — the
 * same reasoning as apps/api/src/auth/encoding.ts. `api` compares CSRF tokens
 * with it (src/auth/csrf.ts); `web` compares the purge shared secret with it
 * (src/lib/purge.ts, reached from src/pages/internal/purge.ts). A "cleanup"
 * that early-returns on the first differing character would silently turn either
 * into a timing oracle while every test stayed green — which is exactly why
 * there must be one definition and not two.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

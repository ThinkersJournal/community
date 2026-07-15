/**
 * A ~64-bit random value in base36 — the uniqueness half of a generated name.
 *
 * Shared by `POST /auth/signup` (a minted username) and `POST /posts` (a
 * collided slug). `crypto.getRandomValues`, not `Math.random`: both call sites
 * place a value in a UNIQUE index, and a predictable suffix would let a caller
 * pre-compute and squat the name a collision is about to retry into.
 */
export function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value.toString(36);
}

/**
 * Body helpers for the media upload path.
 *
 * ⚠️ NEVER TRUST Content-Length. It is client-supplied; the cap must be counted
 * from the bytes actually read, and the read must STOP at the limit rather than
 * discovering it afterwards. `request.arrayBuffer()` / `request.formData()`
 * cannot do that — they buffer first and let you check second, which on a
 * 128MB-memory Worker is the whole problem.
 *
 * ⚠️ EVERY BYTE TYPE HERE IS `Uint8Array<ArrayBuffer>`, NOT A BARE `Uint8Array`,
 * AND THAT IS DELIBERATE. Under TS 6 the bare form means
 * `Uint8Array<ArrayBufferLike>` — which admits a `SharedArrayBuffer` backing and
 * is therefore assignable to NEITHER `BodyInit` (what `new Response(...)` takes)
 * nor `BufferSource` (what `crypto.subtle.digest` takes). Naming the non-shared
 * buffer is what lets this module hand bytes to the platform with no `as` cast
 * anywhere on a hostile-input path. It costs callers nothing: every buffer in
 * this pipeline is freshly allocated (`new Uint8Array(...)`), which is already
 * exactly this type.
 */

/**
 * Read `body` into memory, aborting at `limit` bytes. Returns null when the
 * body exceeds the limit (callers MUST turn that into a 413).
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Cancel rather than drain: there is no reason to keep pulling bytes we
        // have already decided to reject.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A one-shot stream over `bytes`, for the Images binding (which takes streams).
 *
 * ⚠️ A ReadableStream can only be consumed ONCE, and the pipeline needs the
 * bytes TWICE (info, then transform). Hence a fresh stream per call rather than
 * one shared stream — and hence `Response`, whose body is exactly this, with no
 * hand-rolled controller to get wrong.
 */
export function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

/**
 * Lowercase hex SHA-256 of raw bytes. (auth/encoding.ts's sha256Hex takes a
 * string.)
 *
 * ⚠️ `Uint8Array<ArrayBuffer>`, NOT a bare `Uint8Array`. Under TS 6 the bare form
 * means `Uint8Array<ArrayBufferLike>`, which admits a `SharedArrayBuffer` backing
 * and so is NOT assignable to `crypto.subtle.digest`'s `BufferSource`. Naming the
 * non-shared buffer is what makes the call type-check without an `as` — and the
 * bytes we hash are always freshly allocated (the transform's output), so this
 * costs callers nothing.
 */
export async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

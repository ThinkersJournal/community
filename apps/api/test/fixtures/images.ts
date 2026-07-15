/**
 * Real, decodable image bytes for the media tests.
 *
 * ⚠️ Deliberately ONE real image. Task 7's sniffer is tested with byte literals
 * (no fixture can be subtly wrong there); this file exists only because the
 * Images binding needs bytes it can actually DECODE, and one format is enough
 * to exercise the pipeline end to end.
 *
 * ⚠️ `Uint8Array<ArrayBuffer>` throughout, matching src/media/body.ts — the bare
 * `Uint8Array` means `Uint8Array<ArrayBufferLike>` under TS 6 and is not a valid
 * `BodyInit`, so a bare annotation here fails to typecheck at every `new
 * Request({ body })` below.
 */
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A valid 1×1 opaque PNG. */
export const PNG_1X1 = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
);

/** An SVG the Images binding would happily accept. Only the sniff stops it. */
export const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="alert(1)"/>',
);

/** Not an image at all. */
export const TEXT_BYTES = new TextEncoder().encode(
  "just some text, definitely not a PNG",
);

/** A PNG-signed buffer larger than the route's cap, for the streaming test. */
export function oversizeBytes(limit: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(limit + 1024);
  out.set(PNG_1X1.subarray(0, 8), 0);
  return out;
}

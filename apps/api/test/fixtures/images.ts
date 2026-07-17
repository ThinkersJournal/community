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

/* ---------------------------------------------------------------------------
 * A PIXEL BOMB — real, valid PNG bytes that DECLARE enormous dimensions.
 *
 * ⚠️ WHY THIS IS BUILT RATHER THAN PASTED. The whole point of the bomb is the
 * ratio: `pixelBombPng(8000, 8000)` is SIXTY-FIVE BYTES and declares 64
 * MEGAPIXELS. Nothing about the byte cap bounds it (it is ~230,000x under the
 * 15MB limit), and a decoder that trusts the header allocates gigabytes. The
 * dimensions must be a parameter so the test can sit either side of MAX_PIXELS,
 * so the bytes are generated rather than frozen.
 *
 * The IDAT is a valid zlib stream carrying ZERO bytes: `.info()` reads the IHDR
 * without decoding pixels (verified against the binding — it reports
 * `{format:"image/png", width:8000, height:8000, fileSize:65}`), which is
 * exactly the attack, and exactly why the bound is checked against the DECLARED
 * dimensions BEFORE anything decodes them.
 * ------------------------------------------------------------------------- */

/** PNG's CRC-32 (IEEE, reflected) over a chunk's type+data. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** `length(4) | type(4) | data | crc(4)` — one PNG chunk. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A valid PNG whose IHDR DECLARES `width`x`height`, in ~65 bytes. */
export function pixelBombPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  // ihdr[10..12] = compression/filter/interlace, all 0.
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    // A valid zlib stream of zero bytes — enough for a header read.
    pngChunk("IDAT", new Uint8Array([0x78, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A PNG-signed buffer larger than the route's cap, for the streaming test. */
export function oversizeBytes(limit: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(limit + 1024);
  out.set(PNG_1X1.subarray(0, 8), 0);
  return out;
}

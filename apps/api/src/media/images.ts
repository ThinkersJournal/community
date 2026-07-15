/**
 * The ONLY place `env.IMAGES` is touched. One module so the binding's surface is
 * in one place — and so a toolchain without a local Images simulation has a
 * single, honest seam to stub.
 *
 * ⚠️ THE LOCAL SIMULATION IS NOT CLOUDFLARE'S IMAGES. `miniflare` implements
 * this binding with the `sharp` npm library (a direct dependency of miniflare;
 * its errors surface verbatim, e.g. "Input buffer contains unsupported image
 * format" from `Sharp.metadata`). Production runs Cloudflare's own pipeline.
 * Where the two are known to DIVERGE, the divergence is called out below —
 * treat local green as evidence about OUR code, not about Cloudflare's.
 */
import { streamOf } from "./body";

/**
 * The DIMENSIONED half of the binding's `ImageInfoResponse`.
 *
 * ⚠️ `ImageInfoResponse` IS A UNION, AND THE OTHER HALF IS `{ format:
 * "image/svg+xml" }` WITH NO DIMENSIONS AT ALL — Cloudflare's own generated
 * types (src/worker-configuration.d.ts) spell this out:
 *
 *     type ImageInfoResponse =
 *       | { format: 'image/svg+xml' }
 *       | { format: string; fileSize: number; width: number; height: number };
 *
 * That union is the type system stating the fact src/media/sniff.ts's header is
 * about: SVG IS A SUPPORTED INPUT and `.info()` reports it happily rather than
 * throwing (verified under miniflare — it returns exactly `{ format:
 * "image/svg+xml" }`). So this type must never be reached by an `as` cast: on an
 * SVG, `width`/`height` would be `undefined`, `width * height` would be `NaN`,
 * and `NaN > MAX_PIXELS` is FALSE — a pixel-bomb guard that silently passes.
 * Narrow with `hasDimensions` instead.
 */
export type ImageFacts = Extract<ImageInfoResponse, { width: number }>;

/** ~50 megapixels. A 12KB PNG can decode to gigabytes; the byte cap does not bound this. */
export const MAX_PIXELS = 50_000_000;

/**
 * Narrows `.info()`'s union to the dimensioned branch. See `ImageFacts` — this
 * is a TYPE-SOUNDNESS tool, not a format check. It is NOT the SVG defense
 * (src/media/sniff.ts is), and callers must not use it as one.
 */
export function hasDimensions(info: ImageInfoResponse): info is ImageFacts {
  return "width" in info && "height" in info;
}

/**
 * FREE. Returns null when the binding cannot make sense of the bytes at all.
 *
 * ⚠️ A THROW HERE IS A CLIENT ERROR, NOT A 500. Bytes that merely CLAIM a format
 * in their first few bytes and are not decodable make this throw (verified:
 * PNG magic over garbage yields "Input buffer has corrupt header"). Callers MUST
 * hard-reject on null and must NOT fall back to trusting the sniff.
 */
export async function inspectImage(
  env: Env,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ImageInfoResponse | null> {
  try {
    return await env.IMAGES.info(streamOf(bytes));
  } catch {
    return null;
  }
}

/**
 * Transform to WebP — A FULL DECODE + RE-ENCODE, and THE POLYGLOT DEFENSE.
 *
 * ⚠️ THIS STEP IS WHY A POLYGLOT CANNOT SURVIVE, and neither the sniff nor
 * `.info()` can substitute for it. A well-formed JPEG carrying an SVG/script
 * payload in a COM/EXIF segment (or after EOI) sniffs as `image/jpeg` AND
 * `.info()`s as `image/jpeg` — they AGREE, and there is no mismatch to catch.
 * What kills the payload is that the bytes we store are freshly RASTERIZED
 * pixels, so anything a decoder ignored is simply not in the output. That
 * property is destroyed by ANY pass-through fast path ("input is already WebP,
 * just store it") — never add one.
 *
 * `fit: "scale-down"` NEVER upscales — a 100×100 avatar stays 100×100 rather
 * than being blown up to 2048.
 *
 * ⚠️ EXIF IS STRIPPED AUTOMATICALLY AND FREE: for non-JPEG output "all metadata
 * will always be discarded". No config, and none to forget. (Colour profile and
 * EXIF rotation are APPLIED first, so images are not sideways.)
 *
 * ⚠️ `.input()` caps at 20MB — a HARD ceiling. Our 15MB cap must be enforced
 * BEFORE we get here (src/routes/media.ts), or this throws.
 *
 * Returns null when the transform did not produce a usable image; callers MUST
 * hard-reject (415), never store the result.
 */
export async function toWebp(
  env: Env,
  bytes: Uint8Array<ArrayBuffer>,
  maxEdge: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const result = await env.IMAGES.input(streamOf(bytes))
      .transform({ width: maxEdge, height: maxEdge, fit: "scale-down" })
      // `format` is REQUIRED by .output().
      .output({ format: "image/webp", quality: 82 });
    const out = new Uint8Array(await result.response().arrayBuffer());

    // ⚠️ ZERO BYTES IS A FAILURE, NOT A RESULT — AND IT DOES NOT THROW.
    // Verified under miniflare: `.output()` RESOLVES for undecodable input, and
    // `.contentType()` still reports "image/webp"; the failure only shows up as
    // an EMPTY body once you read it. Without this guard a corrupt upload would
    // be hashed, PUT to R2 as a 0-byte "image/webp", given a media row, and
    // answered with a 201 pointing at an empty image. `.info()` rejects such
    // input one step earlier, so this is defense in depth — kept because the
    // failure is silent and the check is one comparison.
    return out.byteLength === 0 ? null : out;
  } catch {
    // Some inputs throw instead. Same answer: hard-reject.
    return null;
  }
}

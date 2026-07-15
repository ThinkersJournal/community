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
 *
 * ⚠️ `typeof x === "number"`, NOT `"width" in info`. The `in` operator answers
 * "is there a KEY", not "is there a NUMBER": it is `true` for
 * `{ width: undefined }`, which would narrow to `ImageFacts`, make
 * `width * height` `NaN`, and — because `NaN > MAX_PIXELS` is FALSE — walk a
 * pixel bomb straight through the guard below. That is the same NaN-blindness
 * that makes an `as ImageFacts` cast unsafe, one level down. Unreachable from
 * the union as documented today; written this way because the whole premise of
 * this module is not trusting the binding's runtime shape, and `in` trusts it.
 */
export function hasDimensions(info: ImageInfoResponse): info is ImageFacts {
  const candidate = info as { width?: unknown; height?: unknown };
  return typeof candidate.width === "number" && typeof candidate.height === "number";
}

/**
 * THE PIXEL-BOMB BOUND — `true` means REJECT (a 413).
 *
 * A few KB of PNG can declare 8000×8000 in its header and decode to gigabytes;
 * the byte cap does not bound this at all, which is why the bound is checked
 * against `.info()`'s DECLARED dimensions before anything decodes the pixels.
 *
 * ⚠️ FAILS CLOSED, AND THAT IS THE ENTIRE POINT OF IT BEING A FUNCTION. Every
 * "we could not get two real numbers out of `.info()`" case — the dimensionless
 * `{ format: "image/svg+xml" }` branch, a `NaN`, an `Infinity` — returns `true`
 * (reject) rather than falling through to a comparison that silently answers
 * `false`. A naive `if (info.width * info.height > MAX_PIXELS)` over a cast gets
 * every one of those cases WRONG in the dangerous direction, because every
 * comparison against `NaN` is `false`. Kept as a pure predicate over the WIDE
 * union (not over the narrowed `ImageFacts`) so those cases are reachable from a
 * unit test — see test/images.test.ts.
 */
export function exceedsPixelBound(info: ImageInfoResponse): boolean {
  if (!hasDimensions(info)) return true;
  const pixels = info.width * info.height;
  // ⚠️ NOT `pixels > MAX_PIXELS` alone: `NaN > n` and `NaN <= n` are BOTH false,
  // so a NaN must be caught by an explicit finiteness test or it reads as "under
  // the bound". Infinity is caught here too, though it would pass `>` anyway.
  if (!Number.isFinite(pixels)) return true;
  return pixels > MAX_PIXELS;
}

/**
 * The dimensions `transform({ width: maxEdge, height: maxEdge, fit:
 * "scale-down" })` produces from `facts` — the aspect ratio preserved, the
 * longest edge bounded by `maxEdge`, and NEVER upscaled (`scale` is capped at
 * 1, so a 100×100 avatar stays 100×100 rather than being blown up to 2048).
 *
 * Only a FALLBACK: src/routes/media.ts prefers a second `.info()` on the STORED
 * bytes, which is authoritative and free. This exists so that when that call
 * cannot answer, the row records what we actually kept rather than the
 * DISCARDED pre-scale-down original — a 4000×3000 upload stored as 2048×1536
 * must not be recorded as 4000×3000 (wrong `<img>` box ⇒ layout shift).
 */
export function scaleDownTo(
  facts: ImageFacts,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / facts.width, maxEdge / facts.height);
  if (scale === 1) return { width: facts.width, height: facts.height };
  // `max(1, ...)`: an extreme aspect ratio (10000×1 ⇒ height 0.2) must not round
  // to a 0-pixel edge — `media.height` is a NOT NULL integer and 0 is a lie.
  return {
    width: Math.max(1, Math.round(facts.width * scale)),
    height: Math.max(1, Math.round(facts.height * scale)),
  };
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

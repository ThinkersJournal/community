import { describe, expect, it } from "vitest";

import {
  exceedsPixelBound,
  hasDimensions,
  MAX_PIXELS,
  scaleDownTo,
  toWebp,
} from "../src/media/images";

/**
 * Unit tests for the PURE predicates in src/media/images.ts — the parallel of
 * test/sniff.test.ts, and for the same reason: these guard a security property,
 * so they are pinned directly rather than only through an end-to-end fixture.
 *
 * ⚠️ WHY THIS FILE EXISTS. The pixel-bomb bound had NO test at all: deleting the
 * guard from src/routes/media.ts left the entire suite green. It is one of the
 * pipeline's security properties and it was the only unpinned one — despite the
 * NaN-blindness of the naive version being the headline finding of Task 8's own
 * report. A future author "simplifying" `hasDimensions` back to an `as` cast, or
 * reordering the narrowing after the bound, silently reopens exactly that hole.
 * These cases fail on both mutations.
 *
 * ⚠️ THE DANGEROUS DIRECTION IS ALWAYS `false`. `exceedsPixelBound` returning
 * `false` means ACCEPT. Every case where the dimensions are not two real numbers
 * must therefore return `true` — because `NaN > MAX_PIXELS`, `NaN < MAX_PIXELS`
 * and `NaN === MAX_PIXELS` are ALL `false`, so a naive comparison answers
 * "accept" for input it could not evaluate at all.
 *
 * These take `ImageInfoResponse` (the WIDE union) rather than the narrowed
 * `ImageFacts`, which is what makes the dimensionless cases expressible here.
 */

/** `.info()`'s dimensionless branch — what the binding really returns for an SVG. */
const SVG_INFO = { format: "image/svg+xml" } as const;

function png(width: number, height: number) {
  return { format: "image/png", fileSize: 1024, width, height };
}

describe("hasDimensions", () => {
  it("accepts the dimensioned branch", () => {
    expect(hasDimensions(png(100, 100))).toBe(true);
  });

  it("rejects the dimensionless (SVG) branch", () => {
    expect(hasDimensions(SVG_INFO)).toBe(false);
  });

  it("rejects PRESENT-BUT-UNDEFINED dimensions", () => {
    // ⚠️ The case `"width" in info` gets wrong: the key exists, so `in` says
    // true, the value narrows to `number`, and every downstream comparison is
    // NaN-blind. Only a `typeof` check catches this.
    const undefinedDims = {
      format: "image/png",
      fileSize: 1024,
      width: undefined,
      height: undefined,
    } as unknown as ImageInfoResponse;
    expect(hasDimensions(undefinedDims)).toBe(false);
  });

  it("rejects STRING dimensions", () => {
    const stringDims = {
      format: "image/png",
      fileSize: 1024,
      width: "100",
      height: "100",
    } as unknown as ImageInfoResponse;
    expect(hasDimensions(stringDims)).toBe(false);
  });
});

describe("exceedsPixelBound — true means REJECT", () => {
  it("allows an ordinary photo", () => {
    expect(exceedsPixelBound(png(4000, 3000))).toBe(false); // 12MP
  });

  it("allows exactly the bound", () => {
    expect(exceedsPixelBound(png(MAX_PIXELS, 1))).toBe(false);
  });

  it("rejects one pixel OVER the bound", () => {
    // The `>` vs `>=` boundary, pinned so neither can be swapped unnoticed.
    expect(exceedsPixelBound(png(MAX_PIXELS + 1, 1))).toBe(true);
  });

  it("rejects a classic pixel bomb (8000x8000 = 64MP)", () => {
    expect(exceedsPixelBound(png(8000, 8000))).toBe(true);
  });

  /**
   * ⚠️ THE FAIL-CLOSED CASES. Each of these is `false` — i.e. ACCEPT — under a
   * naive `if (info.width * info.height > MAX_PIXELS)` over an `as ImageFacts`
   * cast. That is the mutation this block exists to redden.
   */
  it("FAILS CLOSED on the dimensionless (SVG) branch", () => {
    expect(exceedsPixelBound(SVG_INFO)).toBe(true);
  });

  it("FAILS CLOSED on NaN dimensions", () => {
    expect(exceedsPixelBound(png(Number.NaN, Number.NaN))).toBe(true);
  });

  it("FAILS CLOSED on a NaN produced by PRESENT-BUT-UNDEFINED dimensions", () => {
    // The end-to-end shape of the bug: `undefined * undefined === NaN`, and
    // `NaN > MAX_PIXELS === false` ⇒ "accept" from a guard that evaluated
    // nothing.
    const undefinedDims = {
      format: "image/png",
      fileSize: 1024,
      width: undefined,
      height: undefined,
    } as unknown as ImageInfoResponse;
    expect(exceedsPixelBound(undefinedDims)).toBe(true);
  });

  it("FAILS CLOSED on Infinity", () => {
    expect(exceedsPixelBound(png(Number.POSITIVE_INFINITY, 1))).toBe(true);
  });
});

/**
 * The dimension fallback. Only reached when a second `.info()` on the STORED
 * bytes cannot answer — but when it is, it must describe what we KEPT, never the
 * discarded original.
 */
describe("scaleDownTo", () => {
  it("NEVER upscales — a small image keeps its own size", () => {
    // The `fit: "scale-down"` contract: a 100x100 avatar stays 100x100.
    expect(scaleDownTo({ format: "image/png", fileSize: 1, width: 100, height: 100 }, 2048))
      .toEqual({ width: 100, height: 100 });
  });

  it("bounds the LONGEST edge and preserves the aspect ratio", () => {
    expect(scaleDownTo({ format: "image/png", fileSize: 1, width: 4000, height: 3000 }, 2048))
      .toEqual({ width: 2048, height: 1536 });
  });

  it("bounds a PORTRAIT image by its height", () => {
    expect(scaleDownTo({ format: "image/png", fileSize: 1, width: 3000, height: 4000 }, 2048))
      .toEqual({ width: 1536, height: 2048 });
  });

  it("leaves an image exactly at the bound alone", () => {
    expect(scaleDownTo({ format: "image/png", fileSize: 1, width: 2048, height: 2048 }, 2048))
      .toEqual({ width: 2048, height: 2048 });
  });

  it("never rounds an extreme aspect ratio down to a ZERO edge", () => {
    // 10000x1 scaled to fit 2048 ⇒ height 0.2 ⇒ round() would be 0, and
    // `media.height` is a NOT NULL integer where 0 is a lie.
    expect(scaleDownTo({ format: "image/png", fileSize: 1, width: 10000, height: 1 }, 2048))
      .toEqual({ width: 2048, height: 1 });
  });
});

/**
 * `toWebp`'s FAILURE contract. Both cases are stubbed rather than driven through
 * the route, because the route rejects such input at `.info()` one step earlier
 * — which is exactly why the guard needs its own test: it is defense in depth,
 * so nothing else can redden if it breaks.
 *
 * ⚠️ THE 0-BYTE CASE IS NOT HYPOTHETICAL. Verified against the real binding
 * under miniflare: `.output()` RESOLVES for undecodable input and
 * `.contentType()` still reports "image/webp"; the failure surfaces ONLY as an
 * empty body once read. Unguarded, that 0-byte buffer would be SHA-256'd, PUT to
 * R2 as a 0-byte "image/webp", given a media row, and answered with a 201
 * pointing at an empty image. Production may throw instead of returning empty —
 * which is precisely when an untested guard matters.
 */
describe("toWebp fails closed", () => {
  const SOME_BYTES = new Uint8Array([1, 2, 3, 4]);

  /** An `env` whose Images binding returns `body` from the transform. */
  function envReturning(body: Uint8Array<ArrayBuffer>): Env {
    return {
      IMAGES: {
        input: () => ({
          transform: () => ({
            output: () =>
              Promise.resolve({
                contentType: () => "image/webp",
                response: () => new Response(body),
              }),
          }),
        }),
      },
    } as unknown as Env;
  }

  it("returns null when the transform yields ZERO bytes", async () => {
    expect(await toWebp(envReturning(new Uint8Array(0)), SOME_BYTES, 2048)).toBeNull();
  });

  it("returns null when the transform THROWS", async () => {
    const env = {
      IMAGES: {
        input: () => ({
          transform: () => ({
            output: () => Promise.reject(new Error("unsupported image format")),
          }),
        }),
      },
    } as unknown as Env;
    expect(await toWebp(env, SOME_BYTES, 2048)).toBeNull();
  });

  it("returns the bytes when the transform yields a real body", async () => {
    // The positive half: proves the two nulls above are the guards firing, not
    // `toWebp` simply always returning null.
    const out = await toWebp(envReturning(new Uint8Array([9, 8, 7])), SOME_BYTES, 2048);
    expect(out).toEqual(new Uint8Array([9, 8, 7]));
  });
});

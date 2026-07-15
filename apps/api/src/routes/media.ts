/**
 * `POST /media` — the upload pipeline. Raw image bytes in, a CDN URL out.
 *
 * ⚠️ RAW BODY, NOT MULTIPART — deliberate. `request.formData()` buffers the whole
 * body before a cap can be applied, and costs a multipart parser on a hostile-
 * byte path, to yield a filename and a Content-Type we ignore on principle. The
 * browser sends a File as a raw body natively (`fetch(url, { body: file })`), the
 * cap becomes a stream loop, and there is no parser.
 *
 * THE ORDER IS LOAD-BEARING — each step is cheaper than the one below it, and
 * each exists to stop the next from running on input that will be rejected:
 *   1. pipeline (origin -> session -> CSRF -> epoch -> verified)
 *   2. rate limit                  -> 429. After auth: keyed on the session's user.
 *   3. read the body WITH the cap  -> 413. Never trust Content-Length.
 *   4. magic-byte allowlist        -> 415. THE SVG DEFENSE.
 *   5. IMAGES.info() cross-check   -> 415. FREE; catches LYING signatures.
 *      + pixel-bomb bound          -> 413.
 *   6. quota (FRESH)               -> 403. BEFORE paying for a transform.
 *   7. transform -> WebP           THE POLYGLOT DEFENSE (EXIF auto-stripped).
 *   8. SHA-256 the OUTPUT
 *   9. R2 put, content-addressed on that hash
 *  10. media row (FRESH)
 *  11. 201 + the CDN URL. THE ORIGINAL IS DISCARDED — never persisted.
 *
 * ⚠️ THE ORIGINAL UPLOADED BYTES ARE NEVER PERSISTED, LOGGED, OR SERVED — on
 * ANY path, including every rejection above. They live only in the `bytes` local
 * and die with the request. Only the transform's OUTPUT reaches R2. That, plus
 * the mandatory re-encode at step 7, IS the polyglot defense; an error path that
 * echoed the input back (or a debug log that dumped it) would reopen it.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { readCappedBody, sha256HexOf } from "../media/body";
import { hasDimensions, inspectImage, MAX_PIXELS, toWebp } from "../media/images";
import { SNIFF_HEADER_BYTES, sniffImageFormat } from "../media/sniff";

/**
 * 15MB. ⚠️ Two independent ceilings sit above this and BOTH must stay above it:
 *   • `IMAGES.input()` caps at 20MB — a HARD limit, it throws;
 *   • the request-body limit is set by the ZONE plan, NOT the Workers plan
 *     (Free/Pro 100MB, Business 200MB) — so 15MB is fine even on Free.
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Per-user total of STORED (post-transform) bytes. */
export const MEDIA_QUOTA_BYTES = 100 * 1024 * 1024;

/** Longest edge of the stored variant. */
const MAX_EDGE = 2048;

/**
 * The public CDN origin. A module constant, not a var: it is not configuration,
 * and `vars` is a surface that can drift (the same reasoning as signup.ts's
 * CANONICAL_ORIGIN). ⚠️ NEVER derived from the request's Host header.
 */
const MEDIA_CDN_ORIGIN = "https://cdn.thinkersjournal.com";

/**
 * The ONE 415 body. ⚠️ It NEVER echoes the client's Content-Type or filename —
 * and it is deliberately IDENTICAL across "not an allowed format", "the decoder
 * disagrees with the signature", and "the transform produced nothing". Those
 * distinctions are useful to an attacker probing what our decoder does with
 * crafted bytes, and useless to a user, whose next action is the same either way.
 */
function unsupportedMediaType(): Response {
  return errorResponse("UNSUPPORTED_MEDIA_TYPE", 415, {
    message: "Images must be JPEG, PNG, GIF or WebP.",
  });
}

/**
 * ⚠️ CONTENT-ADDRESSED ON THE OUTPUT, WITH NO USER ID IN THE PATH. Content
 * addressing dedupes across users; ownership belongs in Postgres, not the key.
 *
 * ⚠️ DEDUPE/DELETION HAZARD — two users uploading the same image share ONE R2
 * object with TWO `media` rows. Deleting A's row MUST NOT delete the object
 * while B still references it. M1 therefore NEVER deletes an R2 object inline;
 * reclamation is an offline GC that drops objects with no remaining row. See the
 * note on `media.r2_key` in migrations/0002_posts_and_media.sql.
 */
function mediaKey(hash: string): string {
  return `media/post/${hash}.webp`;
}

export async function handleUploadMedia(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---- 1. Auth -------------------------------------------------------------
  const result = await runMutatingPipeline(request, env, ctx, {
    requireVerifiedEmail: true,
  });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  // ---- 2. Rate limit --------------------------------------------------------
  // Applied HERE rather than through the pipeline's `rateLimit` option because
  // the key needs the SESSION's user id, which does not exist until the pipeline
  // has validated the session — passing it as an option would be circular.
  // Still last among the checks, per src/auth/pipeline.ts's rule: quota is spent
  // only by a request otherwise fully entitled to proceed. Keyed on the user —
  // the only identity that means anything for an authenticated upload, and one
  // an attacker cannot rotate the way they can an IP.
  const limited = await enforceRateLimit(env.MEDIA_LIMITER, `media:${userId}`);
  if (limited !== null) return limited;

  // ---- 3. Body, capped WHILE STREAMING -------------------------------------
  const bytes = await readCappedBody(request.body, MAX_UPLOAD_BYTES);
  if (bytes === null) {
    return errorResponse("PAYLOAD_TOO_LARGE", 413, {
      message: `Images must be ${MAX_UPLOAD_BYTES / 1024 / 1024}MB or smaller.`,
    });
  }

  // ---- 4. Magic-byte allowlist — THE SVG DEFENSE ---------------------------
  // ⚠️ FIRST, and before the bytes reach a DECODER. The Images binding ACCEPTS
  // SVG (see src/media/images.ts's `ImageFacts`), so nothing below this line
  // rejects it on purpose.
  const sniffed = sniffImageFormat(bytes.subarray(0, SNIFF_HEADER_BYTES));
  if (sniffed === null) {
    return unsupportedMediaType();
  }

  // ---- 5. Cross-check with the FREE .info() --------------------------------
  const facts = await inspectImage(env, bytes);
  // A mismatch is a LYING SIGNATURE: bytes whose header claims one format and
  // that decode as another (or not at all). `.info()` is free, so there is no
  // reason not to. `hasDimensions` narrows the union for the compiler and cannot
  // fire on its own here: `sniffed` is always one of four RASTER formats, so the
  // `format` comparison has already excluded `.info()`'s dimensionless
  // `{ format: "image/svg+xml" }` branch.
  //
  // ⚠️ THIS IS NOT THE POLYGLOT DEFENSE — do not read it as one. A well-formed
  // JPEG carrying a hidden payload sniffs AND decodes as `image/jpeg`; the two
  // AGREE and this check passes. Step 7's re-encode is what neutralizes it.
  if (facts === null || facts.format !== sniffed || !hasDimensions(facts)) {
    return unsupportedMediaType();
  }
  if (facts.width * facts.height > MAX_PIXELS) {
    // A PIXEL BOMB: a few KB of PNG that decodes to gigabytes. The byte cap does
    // not bound this at all.
    return errorResponse("PAYLOAD_TOO_LARGE", 413, {
      message: "That image is too many pixels.",
    });
  }

  // ---- 6. Quota — BEFORE paying for a transform ----------------------------
  // FRESH: this is a permission decision AND a read-after-write against the
  // user's own prior uploads.
  const used = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ used: string }>(
      "SELECT coalesce(sum(bytes), 0)::bigint AS used FROM media WHERE owner_id = $1",
      [userId],
    );
    // pg returns bigint as a STRING (it exceeds Number's safe range in general).
    return Number(rows[0]!.used);
  });
  if (used >= MEDIA_QUOTA_BYTES) {
    return errorResponse("QUOTA_EXCEEDED", 403, {
      message: "You have used all of your upload storage.",
    });
  }

  // ---- 7. Transform — THE POLYGLOT DEFENSE (EXIF stripped automatically) ---
  // ⚠️ MANDATORY AND UNCONDITIONAL. There is deliberately NO fast path here for
  // input that is "already WebP": skipping the re-encode would store bytes we
  // never rasterized, which is exactly how a polyglot survives.
  const webp = await toWebp(env, bytes, MAX_EDGE);
  if (webp === null) {
    // The decoder took the bytes and produced nothing usable. HARD-REJECT — we
    // do NOT fall back to storing the original, which is the whole point.
    return unsupportedMediaType();
  }

  // ---- 8. Hash the OUTPUT --------------------------------------------------
  const hash = await sha256HexOf(webp);
  const key = mediaKey(hash);

  // ---- 9. R2 ---------------------------------------------------------------
  // Unconditional put: the key IS the content hash, so re-putting identical
  // bytes is idempotent, and a conditional put would cost a HEAD to save
  // nothing. `immutable` is honest for the same reason.
  await env.MEDIA.put(key, webp, {
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  // ---- 10. Row -------------------------------------------------------------
  // Dimensions come from `.info()` on the STORED bytes: `scale-down` may have
  // resized them, so `facts` describes the discarded original, not what we kept.
  const storedInfo = await inspectImage(env, webp);
  const stored = storedInfo !== null && hasDimensions(storedInfo) ? storedInfo : facts;
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [userId, key, hash, webp.byteLength, stored.width, stored.height],
    );
    return rows[0]!.id;
  });

  // ---- 11. Done. THE ORIGINAL IS DISCARDED — it was never written anywhere. -
  return new Response(
    JSON.stringify({
      id,
      url: `${MEDIA_CDN_ORIGIN}/${key}`,
      width: stored.width,
      height: stored.height,
      bytes: webp.byteLength,
    }),
    {
      status: 201,
      headers: {
        "content-type": "application/json",
        // ⚠️ Belt-and-braces per the research: nothing we serve may be
        // content-sniffed by a browser into a type we did not declare.
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

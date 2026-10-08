# Scanning every image at upload — Design and plan

**Status:** Revision 3 (2026-10-07), for PM review. Docs only. Part of #114. **Amended 2026-10-08 (revision 4 material, PROPOSAL):** the decoder moves to a stateless VPS service per `2026-10-08-vps-image-service-design.md` (the "VPS design"); U11 and `decoder_credentials_refused` are added. The C3/C6 spike has not been run. The binding-based text below is kept and marked superseded where it applies.
**Author:** Community upload-scan agent, 2026-10-07.
**Revision 1** answered the design audit of `192cb2c` (3 Critical, 12 Important, 14 Minor). **Revision 2** answers the
re-audit of `edcb522` (6 Important, 9 Minor). **Revision 3** answers the third audit of `9684a1a` (3 Important, 2
decisions, 3 Minor). All follow the PM's rulings, and §17 maps every finding to its fix.
**Ref:** every `file:line` below was read at `f9bc131` (this branch's base). The security-alerting spec landed after
it in #153 and is cited at `f3da62d`. External pages were fetched on **2026-10-07**; the URLs are in §15.
**Plugs into:** `2026-10-01-csam-reporting-pipeline-design.md` (the "rev-3 spec") and
`docs/superpowers/plans/2026-10-01-csam-ncmec-pipeline.md` (the "#114 plan"), both revision 3, merged in #150. This
design does not redesign that pipeline. It adds one entry point at upload time (§5) and names, task by task, the
amendments that entry point needs (§5.6). This commit also amends rev-3 §11.1, and six other rev-3 passages that
the upload-time path made stale, so that the two documents agree (§6.5).

⚠️ **Public repo.** The scanning provider appears here only as **hash-matching service A** (HMS-A, `HMS_A_*`), its
endpoints only as "HMS-A's hash-only PDQ endpoint" and "HMS-A's media endpoint", and the second layer only as the
"PhotoDNA scan step" (rev-3 spec §11, ruling B).

⚠️ **Legal uncertainty: no attorney.** Every legal reading is collected in §12 and is a best safe guess.

---

## 0. Rulings, and what this replaces

### 0.1 CireSnave's ruling (board 126, 2026-10-05), verbatim as relayed

On the response to the uploader (the message he approved is `that image can't be included on our site`):

> "We go with your neutral wording of the response when a questionable upload is found."

On sending images out:

> "Is there a reason we need to run the checks on images locally?  If not, I'm fine with sending images to remote
> servers to be checked."

On the plan:

> "There is no attorney and therefore no attorney check.  Other than that, I agree.  Come up with a plan for scanning
> every image on upload and we will go with that.  It seems substantially cleaner than dealing with questionable
> images after they are already being served from our site."

### 0.2 The design as ruled

1. Every image is hashed and checked **at upload**, before anything reaches the public R2 bucket, and before it is
   converted or served.
2. A match is rejected with the neutral message.
3. The file goes **only** to the restricted evidence store (preserved at least 1 year after submission, two-admin
   access; rev-3 spec §5).
4. The report is filed at once ("Option B", rev-3 spec §0, §3.4).
5. The account is **not** banned by this (R1, rev-3 spec §0).
6. Sending image bytes to a remote checker is allowed as the **fallback**, if hashing in the Worker doesn't fit
   Cloudflare's limits. The PM ruled (revision round 1, I5) that this fallback is **off** unless its own flag is on.

The rev-3 spec's rules apply, with one named exception. They are: Match Data is never used for AI (§11.2), its
retention (§11.3), removal requests (§11.4), credentials (§11.5), and the disclosure (§11.6–11.7). The exception is
§11.1's "in processing" wording, which this commit amends (§6.5).

### 0.3 What this supersedes in `2026-10-04-csam-self-scanning-options.md`

That document designed scanning **after** publication, from a cron. For **new uploads**, this design replaces it:

| Options doc section | Status |
|---|---|
| §3.1 "Where it runs" (lines 239–264): a cron Worker reading unscanned objects from R2 | **Superseded.** Scanning runs inline in `POST /media` (§1, §2). A cron survives only as the one-off backfill of media stored before this ships (§4.4). |
| §3.2 "Computing PDQ inside a Worker" (lines 266–303), steps 1–4: decode the **stored WebP** read from R2 | **Superseded.** We decode the **original upload**, before any conversion (§3.3). Its animation analysis (lines 289–303) stands for new uploads, and §4.1 adopts its option (c) as the default. Its option (b) for stored animated objects (lines 301–302) is replaced by review (§4.4, I6). |
| §3.3 "Periodically scan all new images" (lines 305–370): the `media_scans` table, the `*/2` cadence, the 2–4 minute delay, retries by backoff, alarms S1–S5, "block until scanned" | **Superseded.** Results go on the `media` row (§4.2). Nothing is published before its scan, so there is no "unscanned for 30 min" state to alarm on. Alarms U1–U11 (§11) replace S1–S5. The fail-closed ruling it records (lines 365–370) stands, and §6 implements it. |
| §3.5 "Feeding the quarantine and review pipeline" (lines 417–453) | **Amended.** The result mapping stands: known CSAM → `known_hash`; the harmful-or-abusive category → review-first; the test value → never a case. Intake at upload has its own variant (§5.3). The re-scan-on-list-update policy (lines 448–453) is **not** carried forward. It is a check of already-published media, and is listed as an open decision (§14, D11). |
| §5 "Recommendation", the line *"sent to HMS-A's hash-only PDQ endpoint from the existing `*/2` cron"* (lines 472–473), and the phased table's "Now" and "At launch" rows (lines 485–486) | **Superseded** by §13's tasks and §11's launch blockers. |
| §1, §2, §3.4, §4, §6–§9 | Stand. §10 here refines §6's privacy wording. |

---

## 1. The traced upload flow, and the scan point

### 1.1 The flow today (`f9bc131`)

The browser posts the raw `File` to the web Worker's same-origin proxy (`apps/web/src/scripts/media-upload.ts:33-43`),
which streams it unbuffered over the Service Binding to the api (`apps/web/src/pages/media-upload.ts:43-55`). The api
has no public route (`apps/api/wrangler.jsonc:8-10`). `POST /media` is `handleUploadMedia`
(`apps/api/src/routes.ts:385`), and its steps, in order (`apps/api/src/routes/media.ts:10-24`), are:

| # | Step | Where | Writes or serves anything? |
|---|---|---|---|
| 1 | auth pipeline | `media.ts:103-107` | no |
| 2 | per-user rate limit (`MEDIA_LIMITER`) | `media.ts:117-122` | no |
| 3 | body read, capped while streaming at 15 MB (`MAX_UPLOAD_BYTES`, `:55`) | `media.ts:125-130`; `body.ts:25-58` | no: the bytes live in one local |
| 4 | magic-byte allowlist: JPEG, PNG, GIF, WebP | `media.ts:136-139`; `sniff.ts:75-82` | no |
| 5 | `IMAGES.info()` cross-check, pixel bound (`MAX_PIXELS` = 50,000,000, `images.ts:37`) | `media.ts:142-165`; `images.ts:119-128` | no. `.info()` returns metadata only, and is free |
| 6 | quota (FRESH read) | `media.ts:170-182` | no |
| 7 | **transform to WebP**, 2048 px edge | `media.ts:188-193`; `images.ts:155-180` | **first conversion** |
| 8 | SHA-256 of the WebP; legal-hold refusal (#147) | `media.ts:196-218` | no |
| 9 | **`env.MEDIA.put`** (public bucket, `immutable`) | `media.ts:224-229` | **first public write** |
| 10 | `media` row, re-checking the hold in one statement | `media.ts:256-276` | DB row |
| 11 | 201 with `https://cdn.thinkersjournal.com/media/post/<sha256>.webp` | `media.ts:300-317` | the URL |

**When it becomes servable:** at step 9. `MEDIA` (`tj-media`) is served to the public from the
`cdn.thinkersjournal.com` R2 custom domain, not through a Worker (`apps/api/wrangler.jsonc:65-68`, `:74-77`). The
object can be fetched by anyone who knows its key as soon as the `put` returns, before the row exists and before the
201. The editor inserts the returned URL into the post's markdown (`media-upload.ts:52-56`). `MEDIA_RESTRICTED`
(`tj-media-restricted`) has no custom domain and is streamed only by `GET /media/restricted/:sha256`
(`wrangler.jsonc:69-73`; `routes/media-restricted.ts`).

**The original** is never persisted. It lives only in the `bytes` local and dies with the request
(`media.ts:24-30`).

### 1.2 The scan point

**Scanning is a new step 6a–6e, between the quota check (`media.ts:182`) and the transform (`media.ts:188`).**

Nothing public, converted or served happens before it:
- **No public write.** A `git grep` of `apps/api/src` for `.put(` finds exactly one R2 put in the upload path,
  `media.ts:224` (`env.MEDIA.put`). The other R2 put is `moves.ts:102`, the move worker, which never runs for an
  upload in progress. The KV puts (`SESSIONS`, `HEALTH`, `FOLLOWEES`) carry no image bytes. The web Worker has no R2
  or Images binding.
- **No conversion.** The only `IMAGES.input` call is `images.ts:161`. It is reached only from `toWebp`, which is
  called only at `media.ts:188`. The only other Images call, `.info()` (`images.ts:124`), returns
  `{format, fileSize, width, height}` and produces no image.
- **No serving.** Nothing is servable before the `put` at step 9 (§1.1), and the client learns the URL only at
  step 11.

Steps 1–6 run before the scan on purpose. Each is cheaper than a scan, and each rejects bytes that will never be
stored, converted or served (an SVG, a pixel bomb, an over-quota upload). **Every image we accept for publication is
scanned. An image refused for size, format, pixel count or quota is not.** That ordering is decision D9 (§14).

The new order:

```
1–6   unchanged (auth, rate limit, capped body, sniff, .info() + pixel bound, quota)
6a    original hashes: SHA-256 of the request bytes (and MD5/SHA-1 if Task 12's ruling stands)
6b    existing-case pre-check by the original's SHA-256 (§5.5)
        live case        → the re-upload rules, 422, no HMS-A call
        only cleared     → D6's default: 422, an attempt row, no new case
6c    a fresh passing decoder self-test must exist, or 503 (§3.6); then decode the original through the
      ImageDecoder seam to a 512 × 512 RGB frame, and check its geometry (§3.3, §3.5)
6d    PDQ of that frame, and its 8 dihedral variants when HMS-A takes several hashes (§3.5)
6e    HMS-A (§6), then the PhotoDNA scan step slot (§7)
        clean        → continue to step 7
        match        → the upload-time intake (§5.3), 422 neutral message
        unscannable  → §6.1: 503, or the bytes fallback only if its flag is on
        unavailable  → 503 "try again later", nothing written
7     transform → WebP, now with anim: false (§4.1)
8–11  unchanged; step 10's INSERT also writes the hashes and the scan result (§4.2)
```

---

## 2. Inline or queue

### 2.1 The two shapes

- **Inline.** The request waits for the verdict. Clean → the existing steps 7–11 run, and the 201 carries the URL
  exactly as today. Nothing is stored before the verdict, so there is **no "processing" state at all**.
- **Queue.** The request stores the original privately (say `MEDIA_RESTRICTED` under `scan-pending/<id>`), writes a
  `media` row in an invisible `processing` state, and returns `202`. A Cloudflare Queue consumer scans it, then runs
  the transform and the public put. The editor polls until the image is clean before it can insert a URL. Nothing is
  visible to anyone, including in the uploader's public view, until it is clean.

### 2.2 Bounds from Cloudflare's published limits (fetched 2026-10-07)

From <https://developers.cloudflare.com/workers/platform/limits/>:
- CPU time per HTTP request: "10 ms | 5 min (default: 30 seconds)" (Free | Paid). We are on Workers Paid, the
  architecture's standing choice (`2026-07-13-community-platform-design.md:57`; the account's actual plan is account
  state, which the operator confirms). `apps/api/wrangler.jsonc` sets no `limits.cpu_ms`, so the budget is **30 s of
  CPU** per request.
- "Memory per isolate | 128 MB".
- "There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker
  can continue processing." Waiting on HMS-A costs wall time, not CPU.
- "Subrequests per invocation | … | 10,000" on Paid. An upload makes a handful.

From the Images binding page (<https://developers.cloudflare.com/images/transform-images/bindings/>): input is capped
at "20 MB", and our 15 MB cap sits under it (`media.ts:50-55`).

**What that rules out:** decoding the original at full resolution **inside our isolate**. Our pixel bound is 50 MP
(`images.ts:37`), and 50,000,000 px × 4 bytes (RGBA) = **200 MB**. That is above the 128 MB isolate before the
15 MB body is even counted. A full-resolution in-Worker decoder cannot serve our maximum upload.

**What fits:** Cloudflare's image pipeline decodes, and our isolate takes back only a small raw-pixel image (§3.3).
The binding's generated types offer raw output, `format: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' |
'image/avif' | 'rgb' | 'rgba'` (`apps/api/src/worker-configuration.d.ts:12625-12630`). The bindings page does not
mention `rgb`. At 512 × 512, `rgb` is 512 × 512 × 3 = **786,432 bytes**. At most, our isolate then holds:
- the 15 MB body;
- ≤ 0.8 MB of raw pixels;
- PDQ's working buffers: two 512 × 512 `Float32Array`s (1 MB each), then 64 × 64 and 16 × 16 arrays;
- the SHA-256 of the body.

That is **under 20 MB**. The CPU work is:
- one luminance pass over 262,144 pixels;
- two box-filter passes per axis;
- a 64 → 16 DCT (about 2 × 16 × 64 × 64 ≈ 131,000 multiply-adds), done once, or eight times for the dihedral
  variants (§3.5);
- a SHA-256 of ≤ 15 MB.

⚠️ **UNVERIFIED: this is an estimate, not a measurement.** The spike (§2.4) must check three things:
- that `rgb` output works in production (only the generated types list it, and the local simulator refuses it,
  §3.3);
- that the binding's decode does not count against our isolate's memory;
- the real CPU time.

### 2.3 Recommendation: **inline**

> **Amended 2026-10-08.** The decoder this section and §3.3 assume (the Images binding) is superseded by the stateless VPS service in the VPS design. Inline scanning is unchanged. One more availability dependency is added: a VPS outage is a 503 on image uploads, the same fail-closed answer as a scanner outage (§6.1).

- **It matches the product.** The editor needs the URL at once (`media-upload.ts:44-56`). A queue needs a polling
  editor, a `processing` state on `media`, and a sweeper for items stuck in it.
- **It keeps the original unpersisted.** Inline, the original bytes are written nowhere unless they match (§5). A
  queue must store every original privately while it waits, which breaks the invariant at `media.ts:24-30` for every
  upload.
- **Fail closed costs nothing.** Inline, an unavailable scanner means a 503, and nothing exists afterwards (§6). A
  queue must hold items and alarm on their age.
- **The cost.** An upload's latency includes HMS-A's round trip, and an HMS-A outage stops image uploads at once. The
  ruling accepts the second (§6.5). §6's timeouts bound the first.

**Decision criteria** (measured by the spike, §2.4):

| # | Criterion | If it fails |
|---|---|---|
| C1 | scan-step CPU, p99 over the spike's inputs, ≤ 2,000 ms: under 7% of the 30 s budget, so no `cpu_ms` change is needed | in-Worker PDQ is out. HMS-A's media endpoint (bytes) becomes the path, which needs the fallback flag on (§6.3) and comes back to the PM first |
| C2 | every input completes with 64 MB of ballast held during the scan step (≥ 64 MB headroom) | as C1 |
| C3 | the binding's `rgb` output is exactly 512 × 512 × 3 bytes for JPEG, PNG, GIF and WebP inputs, including EXIF Orientation 6 and 8 fixtures both ≤ 512 and > 512 px; `anim: false` yields the first frame; and the real `9422` shape is recorded | a different decode path (§3.3, option B), re-spiked |
| C4 | HMS-A hash-only round trip p95 ≤ 3 s and p99 ≤ 8 s (the timeout, §6.2) | the queue shape (§2.1) is re-specified and comes back for a ruling |
| C5 | our PDQ port equals Meta's reference **bit for bit** on the same raw byte arrays (§9.2) | the port is wrong, and nothing ships |
| C6 | **hash fidelity** (§3.4): on a public, non-abusive corpus, the Hamming distance between our path's PDQ and the reference's PDQ of the original file is ≤ 10 for every image the reference rates quality ≥ 80, and ≤ 16 for all | a different decode path (option B), or the bytes fallback by the PM's choice. Never shipped as is |
| C7 | the WebP encoder is deterministic: the same original bytes, transformed twice, give the same SHA-256 | §5.3's WebP-key lookup is dropped. The original-SHA lookup stands |
| C8 | **measured, not pass/fail:** the share of ordinary non-photographic images (screenshots, diagrams, flat graphics, charts) whose PDQ quality is ≤ 49 | the rate is reported to the PM with D13, because with the fallback off those images can never be uploaded (§6.1) |

C1–C3 and C5–C8 can be measured before HMS-A registration. C4 needs the registration.

### 2.4 The SPIKE (Task US0)

The spike runs in a throwaway Worker, **not** `thinkersjournal-api`. It is `tj-scan-spike`, deployed as a preview on
the same account (Workers Paid) with only an `images` binding and no routes. It carries the PDQ module from US1 and
the real `ImagesBindingDecoder` (§3.3), and nothing else from the repo. It is deleted after the run.

**This, and the deployed self-test (§3.6), are the only evidence about the Images binding's real behaviour.** That
covers `rgb`, `anim`, `squeeze`, EXIF rotation, `9422` and determinism. Local vitest runs Miniflare, and Miniflare
cannot produce `rgb` (§3.3), so no local test speaks to any of these.

- **Inputs:** all synthetic or public and non-abusive. Never a photograph of a person, and never real abusive material.
  1. a JPEG of seeded noise at the largest dimensions that stay ≤ 15 MB at quality 95;
  2. a 7,071 × 7,071 PNG (50 MP, our pixel bound) of gradients plus sparse noise, kept ≤ 15 MB;
  3. a 100-frame animated GIF ≤ 15 MB whose frame 0 differs visibly from frames 1–99;
  4. the same as an animated WebP;
  5. 1 × 1 and 10,000 × 5 images (edge shapes);
  6. a flat single-colour image (expected low PDQ quality);
  7. JPEGs carrying EXIF Orientation 6 and 8, at 400 × 300 and at 3,000 × 2,000;
  8. a PNG with an alpha channel, to record how `rgb` flattens transparency;
  9. the fidelity corpus (§3.4);
  10. for C8: at least 100 public-domain or synthetic non-photographic images (generated screenshots of text,
      diagrams, charts, flat graphics), each listed with its source.
- **CPU, measured per stage in separate invocations.** A Worker's clock does not advance during pure computation, so
  `Date.now()` around a CPU-bound stage reads near zero. Each stage therefore runs in its own request
  (`/stage/<name>?input=<n>`): the SHA-256 of the body, the `rgb` decode, PDQ, and PDQ with its dihedral variants. Each
  runs 50 times per input, and its CPU time is read from that invocation's Workers Logs record (`wrangler tail` shows
  it too). Report p50 and p99 per stage and input.
- **Memory.** There is no in-Worker memory API. Each run holds a 64 MB `ArrayBuffer` ballast during the stage, and
  any "exceeded memory" failure is recorded (C2).
- **Decode checks (C3).**
  - The output length for every input.
  - For 3 and 4: the PDQ of the `anim: false` decode is within distance 10 of a still made from frame 0 by the same
    script, and more than 31 from one made from frame 1.
  - For 7: the PDQ of the decode is within distance 10 of one of the eight dihedral variants of the PDQ of the
    unrotated pixels (§3.5).
  - For 8: the background colour used.
  - How a forced allowance error surfaces (the `ImagesError` code and message, or another shape), recorded verbatim.
- **Determinism (C7).** Each input through `toWebp`'s exact parameters, twice, comparing SHA-256s.
- **HMS-A latency (C4), after registration only.** 50 calls to the hash-only PDQ endpoint with synthetic 256-bit
  values (random hex, not derived from any image) and with HMS-A's documented test value. No image goes to the media
  endpoint in the spike unless HMS-A's documentation says test submissions are allowed.
- **Output.** A results table in US2's PR, with the commands used. The spike Worker is deleted, and its deletion is
  shown with `wrangler deployments list`.

---

## 3. PDQ in a Worker

### 3.1 The algorithm and its reference

PDQ is Meta's perceptual image hash, in `facebook/ThreatExchange/pdq`. Its README (fetched 2026-10-07):
- the distance threshold "to consider two hashes to be similar/matching": "<=31";
- the quality threshold "where we recommend discarding hashes": "<=49";
- "As of November 2025 there are C++, PHP, Python, Java, and WASM implementations.";
- on a new implementation's correctness: "using images from the pdq/data directory … Generating byte arrays from the C++
  reference implementation and then piping them into the new implementation produces the exact same hash as the C++
  reference implementation", and "Hashes produced by an implementation where quality score >= 80 are within distance
  <= 10 of the C++ reference implementation";
- on rotations: "PDQ does not guarantee exact rotational invariance".

The reference C++ downsamples to an intermediate size first. `pdq/cpp/io/pdqio.cpp` (fetched 2026-10-07; quoted as
the fetch tool returned it, so the exact lines are rechecked at the pinned SHA in US1):

```
// The two-pass Jarosz filter is prohibitively expensive for larger images
// so we use off-the-shelf downsampling to get to an intermediate size.
const int DOWNSAMPLE_DIMS = 512;
…
if (input.height() > DOWNSAMPLE_DIMS || input.width() > DOWNSAMPLE_DIMS) {
    input = input.resize(DOWNSAMPLE_DIMS, DOWNSAMPLE_DIMS);
  }
```

So the reference hashes a 512 × 512 image (aspect ratio not kept) whenever either side exceeds 512. The CImg library
it loads with is reported by the audit to default to nearest-neighbour interpolation in `resize` (CImg master's
documentation; the version vendored in ThreatExchange is unchecked). Cloudflare's resampler is not CImg's. **Our decode
matches the reference's 512 × 512 size, not its pixels.** Whether that changes the hash by more than a little is an
empirical question, and the spike's C6 answers it (§3.4).

### 3.2 Which implementation: a pure-TypeScript port, not the WASM build

| | Pure TS port of the reference C++ | The reference WASM build |
|---|---|---|
| Input | a raw RGB buffer, exactly what the decoder seam returns | per its README, "built using emscripten tool" for "a client browser"; image decoding is **not** included ("ImageMagick (For image analysis)… ffmpeg" are required) |
| In workerd | plain TS, no loader | emscripten glue written for a browser or Node; untested in workerd |
| Review | about 500 lines a reviewer can read against the C++ | a compiled binary plus generated glue |
| Types | typechecks under the repo's TS 6.0.3 | hand-written declarations |

**Recommendation: a TypeScript port** of the reference C++'s hashing, its dihedral variants and its downscaling, on a
raw RGB buffer. At 512 × 512 the work is light (§2.2), so WASM buys nothing.

**Low quality:** a hash with quality ≤ 49 (Meta's discard threshold) is never sent to the hash-only endpoint. It is
"unscannable" (§6.1).

### 3.3 Decoding: behind an `ImageDecoder` seam, before any conversion

> **Superseded 2026-10-08 (the production implementation only).** The seam stays. Its production implementation is the VPS service, not the Images binding: header inspection, the 512x512 raw scan frame and `toWebp` become one request, and the seam folds into a `MediaProcessor` (VPS design §1). There is no fallback decoder. The `ImagesBindingDecoder` text below is kept for history. Nothing in it is built, and the binding-specific risks it lists (the allowance error, no frame selector, an unreadable resampler) move to the VPS spike (VPS design §5).

We decode the **original upload's bytes**, never the WebP that step 7 produces. All decoding goes through one
interface, so our code is testable and the binding's behaviour is evidenced only where it can be:

```ts
import type { SniffedFormat } from "../media/sniff";

/** PDQ's working size: the reference resizes to 512 × 512 when either side is larger (§3.1). */
export const PDQ_DECODE_EDGE = 512;

/** What our code asks for. The geometry is ours, never the decoder's (§3.5). */
export interface DecodeRequest {
  readonly format: SniffedFormat;
  readonly width: typeof PDQ_DECODE_EDGE;
  readonly height: typeof PDQ_DECODE_EDGE;
  /** Always false: the first frame only (§4.1). */
  readonly anim: false;
}

export type DecodeResult =
  | { readonly kind: "ok"; readonly rgb: Uint8Array<ArrayBuffer> }
  | { readonly kind: "failed"; readonly reason: "decode_error" | "allowance_exhausted" };

/** The seam. Production: the Images binding. Unit and route tests: a pure-TS fake. */
export interface ImageDecoder {
  decodeRgb(bytes: Uint8Array<ArrayBuffer>, request: DecodeRequest): Promise<DecodeResult>;
}

/** Pure. Every decode asks for exactly this. */
export function decodeRequestFor(format: SniffedFormat): DecodeRequest {
  return { format, width: PDQ_DECODE_EDGE, height: PDQ_DECODE_EDGE, anim: false };
}

/** Pure. Our own check, not the decoder's: exactly width × height × 3 bytes, or the image is unscannable. */
export function hasExpectedGeometry(
  result: DecodeResult,
  request: DecodeRequest,
): result is { readonly kind: "ok"; readonly rgb: Uint8Array<ArrayBuffer> } {
  return result.kind === "ok" && result.rgb.byteLength === request.width * request.height * 3;
}

/**
 * The test double. It answers only for bytes a test registered, and records every request, so a mutation of
 * OUR request (dropping anim: false, changing the geometry) fails a test.
 */
export class FakeImageDecoder implements ImageDecoder {
  readonly requests: DecodeRequest[] = [];
  private readonly frames: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  private readonly keyOf: (bytes: Uint8Array<ArrayBuffer>) => string;

  constructor(frames: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, keyOf: (bytes: Uint8Array<ArrayBuffer>) => string) {
    this.frames = frames;
    this.keyOf = keyOf;
  }

  async decodeRgb(bytes: Uint8Array<ArrayBuffer>, request: DecodeRequest): Promise<DecodeResult> {
    this.requests.push(request);
    const rgb = this.frames.get(this.keyOf(bytes));
    return rgb === undefined ? { kind: "failed", reason: "decode_error" } : { kind: "ok", rgb };
  }
}
```

**The production decoder, `ImagesBindingDecoder` (option A, recommended).** For every input, whatever its size:
`IMAGES.input(original).transform({ width: 512, height: 512, fit: "squeeze" }).output({ format: "rgb", anim: false })`.
- `fit: "squeeze"` is in the binding's `fit` union (`worker-configuration.d.ts:12574`) and drops the aspect ratio, as
  the reference does.
- Forcing 512 × 512 on **every** input, small ones included, fixes the output geometry ourselves (§3.5).
- **Formats:** the four the sniff admits (`SniffedFormat`, `sniff.ts:54`). The decoder is Cloudflare's, so no
  third-party decoder code runs on hostile bytes in our isolate.
- **It is not a conversion in the ruling's sense.** Nothing it produces is stored, served or returned. The raw pixels
  live in one local, feed PDQ and are dropped. Step 5's `.info()` already hands the same bytes to the same binding
  (`media.ts:142`).
- **An allowance error.** The pricing page says that past "5,000 unique transformations each month", new requests
  "return a `9422` error". How the **binding** surfaces that is undocumented: its types give only `code: number`
  (`worker-configuration.d.ts:12768-12771`). US2 maps it from the shape the spike records (C3), and anything unmapped
  counts as a `decode_error`, which fails closed (§6.1).
- **Its cost.** It is a billable transformation ("billed as unique transformations: each unique combination of source
  image and parameters is billed only once per calendar month"; only `.info()` is free). Every upload already spends
  one in `toWebp`, so **each upload now spends two.** That is about 2,500 uploads a month on the Images Free plan
  before both the scan decode and `toWebp` fail: decision D7.

⚠️ **Local tests cannot exercise this decoder.** The test pool (`@cloudflare/vitest-pool-workers@0.22.0`) runs
Miniflare, whose Images simulation is `sharp` (`images.ts:6-11`). Per the audit, every installed Miniflare answers an
`rgb` or `rgba` request with the error "RGB/RGBA output is not supported in local mode", and has no `anim` handling.
So:
- every unit and route test (US2, US6) injects `FakeImageDecoder` and tests **our** code: the request it builds, the
  geometry check, the PDQ, the routing of each verdict;
- `ImagesBindingDecoder` is proven only by the spike (§2.4) against a deployed preview Worker, and after each deploy
  by the self-test (§3.6). **Never by local vitest.**

**Option B (only if C3 or C6 fails): in-Worker WASM decoders with scaled decoding.** JPEG with a decoder that supports
DCT-domain scaling, WebP with libwebp's scaled decode, and PNG and GIF decoded row by row into a running filter, so no
full-resolution buffer ever exists (§2.2's 200 MB bound). Each needs the provenance step in §3.7. It puts four
third-party decoders on the hostile-input path, so it is not recommended unless option A fails.

### 3.4 Hash fidelity (spike criterion C6)

Our path is Cloudflare's decode plus a squeeze to 512, then our PDQ. The reference is CImg's load plus CImg's resize
to 512, then Meta's PDQ. C5 shows the two PDQ cores agree on identical bytes. **C6 measures what the resampler
difference costs**, because a distance that eats into the match threshold is lost recall:
- **Corpus.** Public and non-abusive only:
  - `pdq/data`'s images, if their licence permits use (§3.7 step 3);
  - plus public-domain or CC0 photographs of landscapes, buildings and objects, ≥ 2,048 px on the long side, with **no
    people in them**, each listed with its source and licence.
  - Never real abusive material, and never anything a test claims resembles it.
- **Method.** For each image, the pinned reference CLI hashes the **original file** on a developer machine. The spike
  Worker hashes the same file through `ImagesBindingDecoder` and our port.
- **Report.** The Hamming-distance distribution (min, median, p95, max), together with each image's reference
  quality.
- **Pass.** Every image of reference quality ≥ 80 is within ≤ 10, which is Meta's own bar for a correct
  implementation. Every image is within ≤ 16, about half the match threshold of 31.
- **Fail.** We do not ship option A. The PM chooses between option B, with a resize matched to the reference's, and
  the bytes fallback as the primary path (§6.3).

### 3.5 Orientation: deterministic, validated, and covered by dihedral hashes

Cloudflare always applies EXIF orientation. Its transform documentation (fetched 2026-10-07) says: "Color profiles
and EXIF rotation are applied to the image even if the metadata is discarded" (also `images.ts:146-147`). Its options
offer `rotate` and `flip`, and none that disables the EXIF rotation. **So rotation cannot be turned off, and the
orientation we hash is Cloudflare's, applied consistently to every input.** The reference loads with CImg, which shows
no orientation handling (`pdqio.cpp`, fetched 2026-10-07).

Two consequences, and how each is closed:
- **The stride bug.** At native size, an Orientation 5–8 image comes back h × w. `w × h × 3` is the same length, so
  a length check alone passes, and PDQ reads the rows with the wrong stride. That gives a garbage hash, so "no known
  match", so the image is published, and the uploader controls it with one EXIF tag. **Closed by geometry we choose:**
  every decode asks for exactly 512 × 512 (§3.3). The expected output is 512 × 512 × 3 whatever `.info()` reports and
  whatever the orientation, because a square has the same dimensions after any rotation or flip. `hasExpectedGeometry`
  checks that, and any mismatch is **unscannable: fail closed with the 503** (§6.1). The spike's C3 confirms the
  output on Orientation 6 and 8 fixtures, both small and large.
- **The content mismatch.** A rotated image's hash differs from a hash of the unrotated pixels. A list entry may have
  been hashed either way. The eight EXIF orientations are exactly the eight symmetries of a square (the dihedral
  group). PDQ computes all eight variants from one DCT (the reference's `pdqDihedralHash256esFromFile`, `pdqio.cpp`),
  and Meta says "PDQ does not guarantee exact rotational invariance".
  - **Design option, recommended:** if HMS-A's hash-only endpoint takes several hashes (the options doc §2.1 says it
    "takes an array of PDQ hashes"), send all **8 dihedral hashes** of the decoded frame in one call. A known-CSAM
    answer for any of them is a match, and **a match on any variant outranks every other answer**: an unavailable
    or malformed answer for another variant, or a clean one (§6.2 `strongest`; PM ruling N1). Meta warns against
    picking one "minimal" hash, so all eight go.
  - **Implementer check (US3):** HMS-A's API document decides it. If HMS-A already matches rotations itself, send one
    hash. If it doesn't, and it takes only one hash per call, that is reported to the PM before US6. Eight calls per
    upload would multiply the rate-limit exposure (§6.2).

### 3.6 The deployed self-test (the post-deploy smoke for the decoder)

Local tests can't reach the binding (§3.3), so production checks itself, and **uploads fail closed until it has**
(PM ruling N3).

- **What it does.** `runDecoderSelfTest(env)` decodes four committed **synthetic** fixtures through
  `ImagesBindingDecoder` and our PDQ, and compares each with its committed expected hash, recorded from the spike's
  deployed run (§2.4). Every fixture must be within distance ≤ 10 to pass. The fixtures
  (`apps/api/src/media/scan-selftest-fixtures.ts`, generated by §9.1's generator and embedded as bytes) are:
  1. a JPEG carrying an EXIF Orientation 6 tag (rotation is applied, §3.5);
  2. a PNG at ≤ 512 px (the upscale path);
  3. a JPEG larger than 512 px on both sides (the `squeeze` path);
  4. an animated GIF whose frame 0 differs from its other frames (`anim: false`).

  It calls **no** HMS-A endpoint and uses no real image of anyone. Each run costs four transformations, but repeats
  of the same source and parameters are billed once a month (§3.3), so four a month in total.
- **Where the result lives.** Each run writes one row to `upload_scan_selftests (id uuid, ran_at, version_id,
  passed boolean, failures smallint)`. `version_id` is the running Worker's version id, read from the
  `CF_VERSION_METADATA` binding (`apps/api/wrangler.jsonc:303-304`). The alarm tick only **reads** this table to
  compute U9 (§11.1); it never writes it.
- **What the gate reads.** Step 6c reads **the newest run of the current deployment's `version_id`, whatever its
  result** (`SELECT … WHERE version_id = $current ORDER BY ran_at DESC LIMIT 1`). It never reads "the newest
  passing row".
- **"Fresh"** means that newest run **passed** and is at most **24 h** old (`selfTestIsFresh`, below). **A failed
  newest run closes uploads at once**, even if an earlier run of the same version passed an hour before.
- **The gate.** With no fresh run, the upload gets the 503 (§6.1). That includes the time before the first run.
- **When it runs:**
  - The `*/2` tick runs it when the current version has no run, when its newest run **failed** (so a failure is
    retried every tick, and uploads reopen on the first pass), or when its newest pass is older than 23 h. So a
    deploy triggers one run within one tick (at most 2 minutes, during which image uploads answer 503), and a
    re-run happens about once a day, before the 24 h window lapses.
  - **A secret change** (`wrangler secret put`) is expected to create a new Worker version, and so a new
    `version_id`. That reopens the same window of up to about 2 minutes of 503s. That window is **accepted**; the
    implementer verifies in US9 whether a secret change really changes `version_id`, and the runbook triggers the
    self-test by hand after each secret change.
  - The deploy runbook's post-deploy step can also trigger it at once, through the Access-gated
    `POST /admin/upload-scan/self-test`. That returns pass or fail only, and writes the same row.
- **A failure** raises U9 (§11.1). A decoder that has drifted is treated like a scanner outage.
- **Recovery when the self-test itself is broken (runbook).** There is **no break-glass that bypasses scanning**:
  fail-closed is CireSnave's ruling (§0.1, rev-3 §11.1). Two causes are possible: Cloudflare's decoder drifted past
  distance 10, or a fixture's expected hash is wrong. Either way, image uploads **stay blocked** until one of these
  happens:
  - **roll back** to the previous Worker version in Cloudflare (`wrangler rollback`, or the dashboard's
    deployments page). That version's own passing run is on record in `upload_scan_selftests`, and the `*/2` tick
    re-runs the self-test for it at once, because its newest run may be older than 23 h;
  - or **fix forward**: re-record the expected hashes from a deployed run of US0's spike Worker, review them as a code
    change, and deploy.

  Text posts are unaffected throughout. The runbook names both steps and who may take them (the operator).

```ts
export interface SelfTestRow {
  readonly ranAt: Date;
  readonly versionId: string;
  readonly passed: boolean;
}

/** A fresh pass: the current deployment's, and at most a day old (§3.6). */
export const SELF_TEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The tick re-runs an hour before the window lapses, so a healthy deployment never has a gap. */
export const SELF_TEST_RERUN_AFTER_MS = 23 * 60 * 60 * 1000;

/** Pure. No row, a failed row, another deployment's row, or a stale row: NOT fresh, so uploads answer 503. */
/**
 * Pure. `newestRun` is the newest run of the CURRENT version, WHATEVER its result: never "the newest pass".
 * No run, a failed newest run, another deployment's run, or a stale run: NOT fresh, so uploads answer 503.
 */
export function selfTestIsFresh(newestRun: SelfTestRow | null, currentVersionId: string | null, now: Date): boolean {
  if (newestRun === null || currentVersionId === null) return false;
  if (newestRun.versionId !== currentVersionId || !newestRun.passed) return false;
  const age = now.getTime() - newestRun.ranAt.getTime();
  return age >= 0 && age <= SELF_TEST_MAX_AGE_MS;
}

/** Pure. Should this tick run the self-test? A failed newest run is retried on every tick. */
export function selfTestDue(newestRun: SelfTestRow | null, currentVersionId: string | null, now: Date): boolean {
  if (newestRun === null || currentVersionId === null) return true;
  if (newestRun.versionId !== currentVersionId || !newestRun.passed) return true;
  return now.getTime() - newestRun.ranAt.getTime() > SELF_TEST_RERUN_AFTER_MS;
}
```

### 3.7 Provenance

CireSnave, verbatim: *"I am not a plageurist."* (a standing portfolio rule).

- **Meta's code.** The candidate is the reference implementation in `github.com/facebook/ThreatExchange`, directory
  `pdq/`. The repository's `LICENSE` (fetched 2026-10-07) is a BSD licence:
  - "Copyright (c) Meta Platforms, Inc. and affiliates.";
  - "Redistributions of source code must retain the above copyright notice, this list of conditions and the following
    disclaimer", and the same for binary forms;
  - "Neither the name Facebook nor the names of its contributors may be used to endorse or promote products derived
    from this software without specific prior written permission."

  The C++ sources carry the same copyright line (`pdqio.cpp`'s header). `pdq/` has no licence file of its own.
- **Public-domain code inside it.** `pdq/cpp/hashing/torben.cpp`, the median routine, is **not** Meta's. Its header
  (fetched 2026-10-07) reads: "The following code is public domain. Algorithm by Torben Mogensen, implementation by
  N. Devillard. This code in public domain." Our port of it carries that statement verbatim and its own credit to
  Torben Mogensen (algorithm) and N. Devillard (implementation). It does **not** carry Meta's copyright line.
- **Our port is a derived work.** Its Meta-derived files keep Meta's licence, not this repo's `MIT OR Apache-2.0`
  (`LICENSE.md` §1):
  - `apps/api/src/media/pdq/` holds the port, a `LICENSE` file with Meta's licence text **verbatim**, and a
    `NOTICE` naming each upstream file. The `NOTICE` records Meta's notice for the BSD files and the public-domain
    statement for `torben.cpp`'s port.
  - Each file's header names its upstream file, the upstream commit SHA, and either Meta's copyright line or the
    public-domain statement, whichever applies. `SPDX-License-Identifier: BSD-3-Clause` is used **only if** the
    verbatim text matches the BSD-3-Clause template word for word; otherwise the header says "see LICENSE in this
    directory".
  - `LICENSE.md` §1 gains an exception paragraph for that directory, in the same form as its existing exception for
    the generated type files.
  - The credit to Meta's PDQ, Mogensen and Devillard appears in the port's headers and in this spec.
- **The scope ported (US1):**
  - `pdq/cpp/hashing/` (`pdqhashing.cpp` and its header, including the dihedral computation, and `torben.cpp`);
  - `pdq/cpp/downscaling/` (the Jarosz filters);
  - `pdq/cpp/common/` (`pdqhashtypes.h`, the 256-bit hash type and its Hamming distance);
  - the RGB-to-luminance step `fillFloatLumaFromRGB`, which is **defined** in `pdq/cpp/downscaling/downscaling.cpp:82`
    (the audit's GitHub API read of `main`, 2026-10-07; re-pinned at US1's SHA). `pdq/cpp/io/pdqio.cpp` only calls it
    (`:47`). Nothing from `io/` is ported: CImg file loading is replaced by the decoder seam.
- **The vetting step (US1, before any code is written):**
  1. pin the upstream commit SHA, and read every file in the scope at that SHA;
  2. confirm the licence that governs `pdq/` at that SHA (the root `LICENSE`), and each file's own header;
  3. check `pdq/data`'s images before using them as fixtures or in C6. They are used only if a licence covers them.
     If none does, the tests use generated images and the reference's **outputs** for them (§9.2), and no upstream
     image is copied into the repo;
  4. port by hand, function for function, keeping the reference's names in comments so a reviewer can diff them;
  5. no third-party npm PDQ package. If one is ever proposed, it is traced to its origin first.

---

## 4. Animation, originals and near matches

### 4.1 Animation (Q4): default **flatten**

`toWebp` does not set `anim` (`images.ts:161-164`), so an animated upload is stored with every frame (options doc
§3.2). PDQ hashes one still image.

- **Default (recommended): flatten.** Add `anim: false` to `toWebp`'s `.output()` (`ImageOutputOptions.anim`,
  `worker-configuration.d.ts:12629`), and decode the scan with `anim: false` too (§3.3). Then the first frame, which
  is what we hash, is exactly what we store and serve. Frames 1…n are never stored, converted or served. The cost is
  that animated images stop animating, which is a product change: it needs CireSnave's ruling (Q4, D2).
- **If Q4 rules "keep animation".** Every frame must be scanned. The binding's types have no frame selector, so that
  means one of:
  - option B's frame-aware decoders hashing every frame, which is more hostile-input code;
  - HMS-A's media endpoint for every animated upload, which needs the fallback flag and sends bytes for every GIF
    (whether it scans every frame of an animated WebP is UNVERIFIED, options doc §3.2).

  Both cost far more than flattening.

### 4.2 Record the original's hashes on the `media` row

This folds into the #114 plan's **Task 12** (`0027_media_original_hashes.sql`), which already adds `original_md5`,
`original_sha1` and `original_sha256` and is gated on board 126. The PM confirms whether the board-126 ruling in §0.1
releases that gate (D12). This design adds the scan's own columns to the same migration (or the next free number):

```sql
-- original_sha256 comes from Task 12 and is not re-added here.
ALTER TABLE media
  ADD COLUMN pdq               text CHECK (pdq ~ '^[0-9a-f]{64}$'),        -- 256 bits, lowercase hex
  ADD COLUMN pdq_quality       smallint CHECK (pdq_quality BETWEEN 0 AND 100),
  ADD COLUMN pdq_source        text CHECK (pdq_source IN ('original', 'stored_webp')),
  ADD COLUMN scan_path         text CHECK (scan_path IN ('hash', 'media')),
  ADD COLUMN scan_list_version text,                                        -- HMS-A's list version at the scan (rev-3 §11.3)
  ADD COLUMN scanned_at        timestamptz;
-- Non-unique: several uploads of identical bytes share one original hash. Read by §5.5's lookup.
CREATE INDEX media_original_sha256_idx ON media (original_sha256) WHERE original_sha256 IS NOT NULL;
```

- All the columns are nullable, because rows from before this ships have no original. `pdq_source = 'stored_webp'`
  marks a backfilled row (§4.4).
- They are written by the existing step-10 `INSERT` (`media.ts:262-263`), so a clean upload's row and its scan result
  commit together.
- `pdq` is the hash of the frame as decoded (orientation applied). The dihedral variants are recomputable from it and
  are not stored.
- `pdq` is hex text, not `bit(256)`, because nothing here searches by Hamming distance. A later local list (NCMEC hash
  sharing, options doc §2.2) can add a `bit(256)` column then.
- They are **hashes only**. The original bytes are still discarded on every clean path (`media.ts:24-30` stays true).
  A **matched** original is the one exception, and goes only to the evidence store (§5).

### 4.3 Near matches (Q3)

- **HMS-A's matching is authoritative.** Its answer has a match type (exact, near or none) and no distance or score;
  the threshold is HMS-A's, and we can't see or tune it (options doc §2.1).
- **Default:** an HMS-A near match on known CSAM counts as a **known-hash** match, so it is reported at match under
  Option B. That is the options doc's recommendation for its Q3 (§8 Q3), still awaiting CireSnave's ruling (D1). Under
  this design almost every true match is a near match, because PDQ is perceptual by construction.
- **Our own PDQ threshold** applies only where **we** compare hashes. Nothing in this design does: §5.5's lookups are
  exact SHA-256 lookups. The default for any later local matching is Meta's: distance ≤ 31.

### 4.4 Backfill of existing media (Task US8)

The originals of existing media are gone, so their `original_sha256` stays NULL. Their stored WebP can still be
scanned.

**A cursor, a snapshot of the end, and a per-key status, so the sweep always terminates:**

```sql
CREATE TABLE media_scan_backfill (                 -- one row per distinct r2_key the sweep has reached
  id          uuid NOT NULL UNIQUE DEFAULT uuidv7(), -- the alarm-mark ref for U6 (§11.1)
  r2_key      text PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('clean', 'matched', 'unscannable', 'failed', 'needs_review')),
  attempts    smallint NOT NULL DEFAULT 0,
  next_try_at timestamptz,
  case_id     uuid,                                -- set for 'matched': the case id only (rev-3 §11.3)
  reviewed_by text,                                -- 'needs_review' and 'unscannable' are closed by an admin
  reviewed_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_scan_backfill_progress (        -- a singleton, as 0016's media_backfill_progress is
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_id      uuid,                               -- media.id cursor (uuidv7, ascending)
  target_id    uuid NOT NULL,                      -- max(media.id) when the sweep started: the fixed end
  completed_at timestamptz
);
```

- **The sweep.** A resumable branch on the `*/2` tick, in the shape of the #61 backfill already there
  (`index.ts:90-92`, `media/backfill-hidden-media.ts`).
  - Each tick reads the next 50 `media` rows with `last_id < id ≤ target_id`, in `id` order. It takes their distinct
    `r2_key`s that have no `media_scan_backfill` row, up to 20 keys.
  - It processes each key once, then advances `last_id`. **The cursor advances whatever a key's result.**
  - When `last_id` reaches `target_id`, it sets `completed_at`.
  - Rows uploaded after the sweep started are past `target_id`. They were scanned at upload, so the end is fixed and
    the sweep terminates.
- **Each key.**
  - Read the object, from `MEDIA` or from `MEDIA_RESTRICTED` if it was moved.
  - Check whether it is animated. That is a RIFF `VP8X` header with its animation flag set, or an `ANIM` chunk, read
    from Cloudflare's own output, not from user bytes.
  - Not animated: decode through `ImagesBindingDecoder` (§3.3), PDQ, HMS-A hash-only.
  - The result:
    - **clean:** status `clean`, and `pdq`, `pdq_quality`, `pdq_source = 'stored_webp'`, `scan_path`,
      `scan_list_version` and `scanned_at` are set on **every** row with that key;
    - **match:** the rev-3 spec's ordinary self-scan intake (§3.1 b), `runIntake({ source: "self_scan", kind,
      sha256s })`, which quarantines that public content. The status becomes `matched`, with the case id;
    - **low quality, or decode failure:** `unscannable`, which alarms (U6). The bytes fallback is used only if its
      flag is on (§6.3);
    - **HMS-A unavailable:** `attempts + 1`, `next_try_at` backs off (2, 4, 8 … min, capped at 60), and after 5
      attempts the status becomes `failed`, which alarms (U6). A **separate** retry pass, at most 5 keys a tick and
      only for keys whose `next_try_at` has passed, retries `failed` keys and never blocks the cursor.
- **Stored animated objects (I6): flagged for review, not frame-scanned.** An animated key gets status `needs_review`
  and alarms (U6).
  - **Why review:** the binding has no frame selector (§4.1), so scanning frames 1…n needs either a new frame-aware
    decoder on bytes, for a one-off sweep over what is, pre-launch, a small population, or sending the bytes out,
    which the PM ruled is off unless its flag is on (I5).
  - An Access admin views the object through the existing restricted or public path, as ordinary moderation. If they
    see CSAM, they use the rev-3 sighting route (§3.1 c) on the embedding post.
  - Closing it sets `reviewed_by` and `reviewed_at`. The object stays as stored. New uploads are flattened (§4.1).
- **Launch blocker 5 (§11.2):** `completed_at` is set, and no key is `failed`, `unscannable` or `needs_review` without
  `reviewed_at`.

---

## 5. Match handling

### 5.1 What the uploader sees

```
HTTP 422
{ "code": "IMAGE_NOT_ACCEPTED", "message": "that image can't be included on our site" }
```

- The message is the ruled wording, verbatim (§0.1). Nothing else: no "reported", no category, no case, no hash.
- `IMAGE_NOT_ACCEPTED` joins `ApiErrorCode` (`packages/shared/src/errors.ts:20`). The code says only that this image
  was refused. Every match, every re-upload refusal, and the harmful-or-abusive answer (§5.4) get the **same** status,
  code and message.
- The web client shows `message` for this code. Today it shows only the code (`media-upload.ts:45-50`), so US6
  changes that branch.
- ⚠️ **The held-key refusal at step 8b** (#147, `media.ts:206-218`) answers the generic 415 for every hold category.
  Answering a `csam` hold with this 422 and a `dmca` or `other` hold with the 415 would be a new status-code oracle
  for the category, which #147 deliberately avoided. **Recommendation (D14):** answer **every** held-key refusal with
  this neutral 422, whatever the category. The PM decides.

### 5.2 Who the uploader of an upload-time file is (C1)

An upload-time case has no `media` row, so the #114 plan's uploader sets cannot find its uploader: they are built from
`media.owner_id` (intake, plan line 1038; CLEAR, line 1196). **The uploader is recorded on the case file at match.**
The upload is authenticated (`media.ts:103-107`), so the user id is known, and it is written in the same transaction
that queues the report:
- `csam_case_files.uploader_id uuid` (bare, nullable), with
  `CHECK (r2_key NOT LIKE 'evidence/%' OR uploader_id IS NOT NULL)`;
- `csam_case_files.content_type text` (the sniffed type), so the evidence file can be served with its own type
  (§5.6, Task 9).

**One uploader set, used everywhere a case's uploaders are needed** (intake, CONFIRM, CLEAR, and CLEAR's
"another live case" test): every `media.owner_id` of the case's keys, every `csam_case_files.uploader_id` of the
case, and every `ncmec_reports.subject_user_id` of the case.

### 5.3 The upload-time intake (`runUploadIntake`)

On a match verdict, in this order:

1. **Find already-public copies (I1).** The match means any copy we already serve must be quarantined too. There are
   two ways to find one:
   - every `media.r2_key` whose row has `original_sha256` = this upload's original SHA-256, read through
     `media_original_sha256_idx` (§4.2). Those are earlier uploads of these exact bytes, which were clean when made;
   - the WebP key these bytes would produce. On the match path only, `toWebp(bytes)` runs once to compute
     `r2KeyForSha256(sha256(webp))`. The output is hashed and dropped; it is **not stored, served or returned**. This
     finds copies uploaded before original hashes existed. It relies on deterministic encoding (C7). If C7 fails,
     this lookup is dropped. **If `toWebp` fails here** (an allowance error, say), the lookup is skipped, and that is
     recorded, never silent: the case gets `serving_lookup_incomplete = true` (§5.6, Task 3), the case page shows
     it, and U10 raises (§11.1), so an admin can search for public copies by hand.

   The **serving keys** are those keys that have a `media` row.
2. **One transaction** (`BEGIN_BOUNDED_TX`, then the intake advisory lock `CSAM_INTAKE_LOCK_ID` as its first
   statement, so it serialises with every other intake, rev-3 §3.3 step 1).
   - **Disposition.** §5.5's query, re-run inside the lock, over the original's SHA-256 and the serving keys. Exactly
     one of these branches runs:
   - **(a) A live (undecided or confirmed) case holds the original or any serving key → join it.**
     - **No duplicate case** is opened, whatever account uploads.
     - If no file of that case has `sha256` = the original's SHA-256, add one evidence file: `r2_key = evidenceKey`,
       `sha256` = the original's, `uploader_id` = this user, `content_type`, `evidence_key = evidenceKey`,
       **`evidence_state = 'pending'`** (§5.7), and `imposeLegalHold(c, { r2Key: evidenceKey, category: "csam",
       moderationActionId: <the case's hold_action_id> })`.
     - If such a file exists and is `present`, there is no new file and no new object: the identical bytes are
       already preserved. If it is `pending`, `failed`, `missing` or `file_without_evidence`, this request holds the
       very bytes that were lost, so step 4 writes them to that file's key and it becomes `present` (§5.7). For
       `file_without_evidence` that is for preservation only: its report may already have been sent without the file.
     - **The re-upload rules, exactly as rev-3 §3.7 states them (I2):**
       - **a different account** (one not in the case's uploader set, §5.2) on an already-reported case (a
         `known_hash` case under Option B, or a confirmed case) gets **its own** report (`queued_by = 'reupload'`,
         `pending` or `awaiting_credentials`), one `ncmec_report_files` row for its file (`viewed_by_esp` per rev-3
         §3.1), and its own `csam` account hold. No bar;
       - **the same account** (any account already in the case's uploader set, the original uploader included) gets
         a `csam_upload_attempts` row and the case's alarm re-armed (`alarm_next_at = now()` while undecided). **No
         new report, and no new case;**
       - **an undecided review-first case** (classifier or removal request): an attempt row and the alarm. And when
         **this** answer is `known_hash` (M3): the case's `priority` rises to `urgent`, and this uploader gets the
         `csam` account hold and an Option-B report (`queued_by = 'match'`) for their own file. A known-hash signal is
         what §12 treats as enough to report, so it isn't discarded because a weaker case got there first. This
         departs from rev-3 §3.6's "suppress" for machine detections on an undecided case, and is decision D16.
     - Serving keys found in step 1 that the case does not already hold are added to it through rev-3 §3.3 steps 3–8
       for those keys: hold, hidden embedding content, snapshots, targets, and their uploaders' holds and reports
       under R3.
   - **(b) Otherwise, open a case.**
     - The `csam_hold` action row, then the `csam_cases` row: `source = 'self_scan'`, `kind` from the verdict,
       `priority` (`urgent` for `known_hash`, `high` for review-first), `alarm_next_at = now()`,
       `opened_by = 'system:self-scan'`. The case id is generated by the database (`uuidv7()`); the evidence key is
       built from it after the insert returns.
     - The evidence file: `r2_key = evidenceKey`, `sha256` = the original's, `uploader_id` = this user,
       `content_type`, `evidence_key = evidenceKey`, **`evidence_state = 'pending'`** (§5.7), and its `csam` hold,
       `imposeLegalHold` (`legal-hold.ts:19`).
     - The serving keys from step 1, if any, through rev-3 §3.3 steps 3–8 (quarantine of the public copies).
     - For `known_hash`: the `csam` account hold for every uploader in the set (rev-3 §3.3 step 7a). Then, when
       `queuesReportAtMatch(kind, CSAM_REPORT_AT_MATCH)`, **one `ncmec_reports` row per uploader** (R3), each with
       `ncmec_report_files` rows for that uploader's own files only. For this upload's user, that is the evidence
       file (`viewed_by_esp = false`).
     - **No bar.** `barsAtMatch` is read as in rev-3 §3.4, and with R1's `false` (`CSAM_BAR_UNREVIEWED_MATCH = false`)
       nothing is barred.
     - **Review-first** (§5.4): no account hold and no report at match. They come at CONFIRM (§5.6, Task 9).
   - In both branches, Match Data is stored only with the case (rev-3 §11.3), and one `upload_scan_outcomes` row
     records `scanned` with the case id only (§6.6).
3. **COMMIT.**
4. **After commit: the evidence write (I4, N2).**
   - When step 2 created a new evidence file, or found a `pending` or `failed` one for these exact bytes:
     `env.MEDIA_RESTRICTED.put(evidenceKey, bytes, { httpMetadata: { contentType } })`, then a `head` to verify it.
   - **Retried inline, bounded:** up to 3 attempts, with 250 ms and 750 ms waits between them, so at most about
     1 s of waiting is added.
   - **Success:** a guarded `UPDATE csam_case_files SET evidence_state = 'present' WHERE id = $1 AND evidence_state IN
     ('pending', 'failed', 'missing', 'file_without_evidence')`.
   - **Still failing after the last attempt:** in the same request, `evidence_state = 'failed'`, and the **immediate**
     alarm U5 (§11.1): the request records the fact (`evidence_state`, `evidence_alarm_sent_at`) and sends the
     email itself, best effort, as rev-3 §3.3 sends a case's first URGENT email; it writes no mark (§11.1). The
     uploader gets the same neutral 422 as any match.
   - Its `csam` hold and its case row were committed first, so **the object never exists without a hold and a case**.
   - For the serving keys: `enqueueAndAttemptMove(…, "to_restricted")` and `afterContentDecision` **without**
     `legalHold`, exactly as rev-3 §3.3's "After commit".
   - The case's URGENT alarm, best effort.
5. **Answer** §5.1's 422.

**Failures:**
- **The transaction fails (M4).** No case and no object exist, so the request answers the **503** "try again later"
  (§6.1), not the 422. The retry scans again and re-runs intake, so a known-hash hit is not lost to a single database
  error. A durable alarm can't be written, because the database is the thing that failed. So the request logs
  `upload-scan: match intake failed`, with no hash, no classification and no user id, and the next upload attempt's
  scan is the recovery.
- **The evidence write fails.** The file becomes `failed`, U5 fires at once, and the report is **held** by the drain
  until the evidence is present or two admins decide (§5.7).
- **The Worker dies between COMMIT and the put.** The file stays `pending`. The `*/2` tick moves any file still
  `pending` 10 minutes after its creation to `failed`, and raises U5 at once. The request is gone, and with it the
  bytes.
- **Two simultaneous uploads of the same bytes.** The lock serialises them. The second sees the first's evidence file
  (`sha256` matches) and takes branch (a): one case and, for the same account, an attempt row. If the first's write
  failed, the second's bytes repair it.

```ts
import type { SniffedFormat } from "../media/sniff";

const EVIDENCE_EXTENSION: Readonly<Record<SniffedFormat, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** rev-3 spec §5.2's evidence-key shape, for an ORIGINAL upload (not the WebP). */
export function evidenceKeyFor(caseId: string, originalSha256: string, format: SniffedFormat): string {
  return `evidence/csam/${caseId}/${originalSha256}.${EVIDENCE_EXTENSION[format]}`;
}

/** A match found at upload. The bytes stay in the request until the transaction has committed (§5.3 step 4). */
export interface UploadMatchIntakeInput {
  readonly source: "self_scan";
  /** known_hash: reported at match (Option B). classifier: review-first (§5.4). */
  readonly kind: "known_hash" | "classifier";
  /** The authenticated uploader, recorded on the case file (§5.2). */
  readonly uploaderId: string;
  readonly originalSha256: string;
  readonly format: SniffedFormat;
  /** Already-public copies of the same bytes (§5.3 step 1). Possibly empty. */
  readonly servingKeys: readonly string[];
  readonly attemptedAt: Date;
  /** HMS-A's answer. Stored only with the case; never logged (rev-3 spec §11.2–11.3). */
  readonly matchData: unknown;
  readonly actor: "system:self-scan";
}

export type UploadMatchIntakeResult =
  | { readonly kind: "opened"; readonly caseId: string; readonly evidenceKey: string; readonly reportsQueued: number }
  | {
      readonly kind: "joined";
      readonly caseId: string;
      /** Null when the case already preserves these exact bytes: nothing to put. */
      readonly evidenceKey: string | null;
      readonly outcome: "own_report" | "attempt_only";
    };
```

### 5.4 The other HMS-A answers

| HMS-A answer | Verdict | At upload |
|---|---|---|
| no known match, match type none | clean | publish (steps 7–11) |
| known CSAM, exact | `known_hash` | §5.3 |
| known CSAM, near | `known_hash` under Q3's default; `classifier` (review-first) if Q3 rules no | §5.3 |
| the harmful-or-abusive category | review-first | §5.3 with `kind = 'classifier'`: evidence, a case with `priority = 'high'`, **no** account hold and **no** report at match (rev-3 §3.1). The same 422. Using the `classifier` kind for it is decision D5 |
| the test value | unavailable | 503, U4: in production it means a misconfiguration |
| any other combination, for example "no known match" with match type exact or near, or a malformed body | unavailable (`bad_response`) | 503, U1 |

### 5.5 The existing-case lookup (step 6b, and again inside the lock)

```sql
-- $1 = the original's SHA-256. $2 = the serving keys (§5.3 step 1; empty at step 6b, before any toWebp).
SELECT f.id AS case_file_id, f.case_id, c.kind, c.review_outcome, f.cleared_at
  FROM csam_case_files f
  JOIN csam_cases c ON c.id = f.case_id
 WHERE f.sha256 = $1
    OR f.r2_key IN (SELECT m.r2_key FROM media m WHERE m.original_sha256 = $1)
    OR f.r2_key = ANY($2::text[])
 ORDER BY (f.cleared_at IS NULL) DESC,   -- live files first (I3)
          f.created_at DESC
 LIMIT 1;
```

- **A live file comes back (`cleared_at IS NULL`).** Step 6b skips HMS-A and runs §5.3 directly with that case as
  branch (a). Its rules decide own-report or attempt-only. An identical file is already preserved, so no new evidence
  file is added.
- **Only a cleared file comes back** (two admins cleared it as a false positive). **Default: refuse** with the 422,
  write a `csam_upload_attempts` row on the cleared case, open nothing and report nothing. That follows rev-3 §3.6's
  suppression of a same-strength re-detection of a cleared file. The alternative, publishing what two admins
  cleared, would match the rev-3 CLEAR's own effect (it puts the serving copy back, §7.2 step 6). That is D6.
- **Nothing comes back:** go on to the scan.

The audit's I3 found the earlier draft's `AND f.cleared_at IS NULL` filter, which made the cleared branch
unreachable. Here the filter is gone and live files are ordered first. US5 tests all three outcomes (§13).

### 5.6 Amendments to the #114 plan, task by task

Each amendment is better folded into the named #114 task before that task is implemented than patched in afterwards.

**Task 3 (schema).**
- `csam_case_files` gains:
  - `uploader_id uuid` (bare);
  - `content_type text`;
  - the CHECK of §5.2;
  - `CHECK (content_type IS NULL OR content_type IN ('image/jpeg','image/png','image/gif','image/webp'))`;
  - a non-partial index on `(sha256)` (§5.5's lookup must see cleared files too);
  - `evidence_state text NOT NULL DEFAULT 'present' CHECK (evidence_state IN ('pending', 'present', 'failed',
    'missing', 'file_without_evidence'))`, `evidence_alarm_sent_at timestamptz` (§11.1), plus
    `without_evidence_requested_by`, `without_evidence_approved_by`,
    `without_evidence_reason` and `without_evidence_at`, with a CHECK of two different hands
    (`lower(btrim(...))`, as `csam_cases_clear_two_hands` does) whenever the state is `file_without_evidence` (§5.7).
    Serving-key files keep the default `present`: their object exists before intake.
- `csam_cases.serving_lookup_incomplete boolean NOT NULL DEFAULT false` (M5), plus `serving_lookup_ack_by text`,
  `serving_lookup_ack_at timestamptz` and `serving_lookup_ack_note text` (§11.1 U10). The `moderation_actions`
  action CHECK gains `csam_serving_lookup_ack`.
- The evidence-key guard accepts `evidence/csam/<case>/<sha256>.<jpg|png|gif|webp>`, not only `.webp`.
- `csam_alarm_marks` stays per item. Its `condition` CHECK grows from `(7, 8)` to `(7, 8, 105, 106)`: 105 is U5,
  keyed by the case file's `id`, and 106 is U6, keyed by the `media_scan_backfill` row's `id` (§4.4; round-2 M2).
  A new `csam_condition_marks (condition text PRIMARY KEY, raised_at timestamptz NOT NULL, cleared_at timestamptz)`
  gives condition-level alarms (`'U1'`, `'U3'`, `'U7'`, `'U9'`, `'U10'`) a "first raise" (§11.1). Only the alarm tick
  writes either table.
- `upload_scan_outcomes` (§6.6), `upload_scan_selftests` (§3.6) and US8's two tables may land here or in US4.

**Task 6 (intake).**
- `runUploadIntake(env, ctx, input: UploadMatchIntakeInput): Promise<UploadMatchIntakeResult>` beside `runIntake`,
  following §5.3 literally.
- It shares `runIntake`'s steps 3–8 for serving keys. Factor them as a helper that takes the case id, rather than
  copying them.
- `recordCsamReupload` takes either a serving key (the #147 path) or a case file found by §5.5's lookup, and uses
  §5.2's uploader set to tell "same account" from "different account".
- The held-key refusals answer per D14.

**Task 7 (drain).** ⚠️ **Evidence first (N2):** before a report's `submit`, every one of its `ncmec_report_files`
must be either `present` **and** found by a `head` of its `r2_key` in `MEDIA_RESTRICTED`, or
`file_without_evidence`, which is then left out of the report. Otherwise the report is **not** submitted: its status
stays `pending` (or `awaiting_credentials`), `last_error = 'evidence_not_present'`, and the drain makes no NCMEC call.
That rules out the submit → upload-fails → 24 h deletion → resubmit loop. A held report is covered by U5 and by
rev-3 §6 condition 3 (not finished within 6 h).

For a file whose `r2_key` begins `evidence/`:
- `publiclyAvailable = false`, because it was never served;
- `incidentDateTime` is the attempt time;
- no web-page URL;
- `originalFileHash` is that file's `sha256`, which is now truly the original's;
- the upload is the object's own bytes, with its `content_type`.

**Task 8 (alarms).** U1–U11 (§11.1), `csam_condition_marks` for the condition-level ones, and the two new item
conditions in `csam_alarm_marks`.

**Task 9b (destruction).** The `csam_evidence_destroyed` audit row it writes (rev-3 §5 P7 step 3) also sets
`subject_label = 'csam_case:<caseId>'`. The daily evidence check (§5.7) reads that row to skip destroyed cases
(N6).

**Task 9 (admin routes, review): reveal, serving, CONFIRM, CLEAR (C1).**
- **Reveal.** `POST /admin/csam/files/:id/reveal` opens the grant on **the case file's own `r2_key`**, not on
  `r2KeyForSha256(sha256)`, through `requestMediaAccess(c, { r2Key: file.r2_key, … , caseFileId })`. That is
  identical for serving keys, because their `r2_key` is `media/post/<sha256>.webp`, and correct for evidence keys. It
  returns `{ caseFileId, grantId }`. As before, it writes no `media_access` row.
- **Serving a case file.** A new handler `handleGetCaseFileMedia` in `routes/media-restricted.ts`, at
  `GET /media/restricted/case-file/:caseFileId?grantId=…`, beside `GET /media/restricted/:sha256`. It serves **any**
  case file, evidence or serving key, so Reveal has one path for both:
  1. `requireAdmin`. Any failure is `notFound()`, the route's convention (`media-restricted.ts:83-90`).
  2. Load the case file. It must exist, and `isKeyLegallyHeld(c, r2_key)` must be true. Otherwise 404.
  3. The grant: `SELECT … FROM media_access_requests WHERE id = $grantId AND r2_key = <the file's r2_key>`, checked by
     the **same** usability predicate as the existing branch (`media-restricted.ts:116-122`). That predicate is
     extracted into one shared `grantIsUsable(grant, adminEmail, now)`, so the two-admin rule has one copy. Unusable →
     404.
  4. `env.MEDIA_RESTRICTED.get(r2_key)`. Missing → 404 with **no** log row (the #114 Task 9 rule).
  5. The audit row: `recordModerationAction(c, { actorAdmin, action: "media_access", reason: "CSAM case file access
     via grant", subjectLabel: r2_key, internalNote: grantId })`. #114's "viewed" query then counts it unchanged: it
     matches `subject_label = r.r2_key AND internal_note = r.id::text`.
  6. Stream that same object with:
     - `content-type` = the file's `content_type`;
     - `X-Content-Type-Options: nosniff`;
     - `Content-Security-Policy: sandbox; default-src 'none'`;
     - `cache-control: private, no-store`.

     ⚠️ Evidence files are **unrasterized originals**. `media.ts`'s polyglot warning (`:24-30`) applies to them, and
     those headers are what stop a browser treating one as anything but an inert image.
- **The browser path (N4).** There is **no existing admin page that displays held media** to reuse. At `f9bc131`
  (and at `f3da62d`):
  - `apps/web/src/pages/admin/media-access.astro` only requests and approves grants (`:56-75`, `:100-136`). It never
    fetches or shows the image.
  - The only browser path to `GET /media/restricted/:sha256` is `apps/web/src/pages/api/media-restricted.ts`, the
    author's own-hidden-post proxy. It forwards only the Cookie, so it never reaches the grant tier (its header,
    `:11-21`), and it copies only `content-type` and `nosniff` (`:65-66`).
  - `git grep -n -i "sandbox"` and `git grep -n "grantId"` over `apps/web/src` find nothing at either ref.

  Today's grant tier therefore has no browser path at all. #114 Task 10's "links to the two-person media-access page
  for that sha256" would land on a page that can't show anything. The new page **reuses the mechanisms that do
  exist**:
  - the admin guard of `media-access.astro:40-43`: the `Cf-Access-Jwt-Assertion` header is required, and it is the
    first statement;
  - `markPrivate`, which sets `private, no-store` (`media-access.astro:45`; `cache.ts`);
  - the binary passthrough of `pages/api/media-restricted.ts:56-67`: raw `env.API.fetch` and a streamed body, because
    `apiFetch` and `adminApiFetch` read bodies as text (`media-restricted.ts:6-9`, `admin-api.ts`).

  The new file is `apps/web/src/pages/admin/csam-file/[caseFileId].ts`, an `APIRoute`:
  1. the guard, then `markPrivate`;
  2. `env.API.fetch("https://api.internal/media/restricted/case-file/<id>?grantId=<grantId>")` with the caller's own
     Access JWT forwarded verbatim, exactly as `adminApiFetch` forwards it (`admin-api.ts`'s confused-deputy note),
     and the client-IP header applied last;
  3. a non-200 → the same status with an empty body;
  4. a 200 → the body streamed, with `content-type` from upstream, and **set** (not copied, so a missing upstream
     header cannot drop them): `X-Content-Type-Options: nosniff`,
     `Content-Security-Policy: sandbox; default-src 'none'`, and `Cache-Control: private, no-store`.

  The grant row's `r2_key` for an evidence file shows as the full key on `media-access.astro`, because the list's
  sha256 derivation falls back to the key (`routes/admin.ts:223`), so a second admin can see which file they are
  approving.
- **Task 10 (admin UI) amendment.** Per file, Reveal POSTs `reveal` (above) and then links to
  `/admin/media-access` for the approval and to `/admin/csam-file/<caseFileId>?grantId=<grantId>` for the view. It
  never links by sha256. The case page also shows each file's `evidence_state`, `serving_lookup_incomplete`, and
  the two-step "file without evidence" control (§5.7). Tests are source pins plus a proxied-headers test:
  - the guard is the first statement of `[caseFileId].ts`;
  - a stubbed 200 upstream **without** CSP still yields all three headers on the page's response;
  - **mutation:** copy the CSP from upstream instead of setting it, and that test fails.
- **File without evidence (N2).** `POST /admin/csam/files/:id/file-without-evidence` `{ reason }`, then
  `POST /admin/csam/files/:id/file-without-evidence/approve` by a **different** admin (`sameAdminHand`, else 409
  `CSAM_SAME_HAND`). Only a `failed` or `missing` file qualifies. Each step writes a `moderation_actions` row naming
  the case file.
- **Acknowledge a skipped serving-copy lookup (U10).** `POST /admin/csam/:caseId/serving-lookup/ack` `{ note }`
  (Access-gated, `checkOrigin` first as every admin POST, a non-blank note). It is refused with 409 unless
  `serving_lookup_incomplete` is true and not yet acknowledged. It sets `serving_lookup_ack_by`, `_at` and `_note`,
  and writes a `csam_serving_lookup_ack` `moderation_actions` row (the audit row) naming the case. The note records
  what the admin searched for by hand. The case page (Task 10) shows the flag and the form.
  The approval sets `file_without_evidence`, and the drain then submits that report without the file (§5.7).
- **CONFIRM.** `confirmCaseInTx`'s uploaders are §5.2's set. For an upload-time **classifier** case, that means:
  - the uploader (from `uploader_id`) is terminated through `applyAccountActionInTx`;
  - takes the `csam` account hold;
  - and gets one report, `queued_by = 'confirm'`, with `viewed_by_esp` from the "viewed" query, so `true` after the
    two-person fetch above.

  For an upload-time `known_hash` case: terminated, and no second report.
- **CLEAR.**
  - Step 1 copies nothing for a file whose `r2_key` begins `evidence/`: it already is the evidence copy, so
    `evidence_key = r2_key`.
  - Step 2.4 releases no serving hold for it, because there is none.
  - Nothing of it goes public.
  - Step 2.5's uploaders, and its `NOT EXISTS` "another live case involves this uploader" test, use §5.2's set: add
    `OR EXISTS (SELECT 1 FROM csam_case_files f2 WHERE f2.case_id = o.id AND f2.uploader_id = $1)`.
- **Tests, added to Task 9's list:**
  - an upload-time `classifier` case can be revealed and fetched, by the two-person grant only (a single admin
    → 404), and its fetch writes exactly one `media_access` row; CONFIRM then terminates the uploader and queues a
    report with `viewed_by_esp = true`. **Mutation:** build the grant on `r2KeyForSha256(sha256)` instead of the
    file's `r2_key`, and the fetch 404s, CONFIRM answers 409 `CSAM_NOT_VIEWED`, and the test fails;
  - an upload-time `known_hash` CONFIRM terminates and queues no second report;
  - a CLEAR of an upload-time case keeps the evidence hold, puts nothing in `MEDIA`, and releases the account hold
    only under ruling d's conditions, with §5.2's set (an uploader with another live upload-time case keeps it);
  - "file without evidence": one admin only requests; the same admin approving → 409; a second admin approves; a
    `missing` file qualifies like a `failed` one; a file that is `pending` or `present` → 409;
  - the U10 acknowledgement: it sets the three columns and writes exactly one audit row; a second acknowledgement →
    409; a case without the flag → 409; a blank note → 400.

### 5.7 Evidence states, and when a report may be sent (N2)

Each case file has an `evidence_state`. The case's own evidence state is derived from its files: it is
`evidence_failed` if any file is `failed` or `missing`, `evidence_pending` if any is `pending`, and `evidence_present` otherwise.
The **file** is what the drain checks, because each report carries only its own uploader's files (R3).

| From | To | When, and by whom |
|---|---|---|
| (none) | `pending` | **the intake transaction**, when it inserts an upload-time evidence file (§5.3 step 2). It commits with the case, the hold and the report |
| (none) | `present` | **the intake transaction**, for a serving-key file: its object already exists (the default) |
| `pending` | `present` | **the upload request**, when its put and `head` succeed (§5.3 step 4) |
| `pending` | `failed` | **the upload request**, when the bounded inline retries are exhausted; or **the `*/2` tick**, when it finds the file still `pending` 10 minutes after creation (the Worker died). U5 fires **immediately** either way |
| `present` | `missing` | **the daily evidence check** (below), when its `head` finds the object gone. U5 fires **immediately**. (The drain's own `head` before `submit` only holds the report; it does not change the state. The next daily check does) |
| `failed` or `missing` | `present` | **a later upload request** of the same bytes, which joins the case and writes them (§5.3 branch (a)) |
| `failed` or `missing` | `file_without_evidence` | **two different admins**, who decide to file without it (§5.6, Task 9), with a reason. Audit rows |
| `file_without_evidence` | `present` | **a later upload request** of the same bytes. This is for preservation only: the report may already have gone without the file |

No other transition exists. Destruction under rev-3 P7 changes no state: it marks the case (`destruction_started_at`,
the `csam_evidence_destroyed` row), and the daily check skips such cases (below).

**The drain rule (#114 Task 7, §5.6):** a report is submitted only when each of its files is `present` (and its
object is found by `head`) or `file_without_evidence`. A `pending`, `failed` or `missing` file **holds** the
report, with no NCMEC call, until the bytes arrive or two admins decide.

⚠️ **Legal uncertainty: no attorney.** The reporting duty runs from actual knowledge, "as soon as reasonably
possible" (§12). Holding a report while its evidence is missing delays the filing, and the length of that delay is a
human decision once the state is `failed` or `missing`. U5's immediate alarm is what bounds it. Whether filing at once without the
file would be the safer reading is not settled. The default here, hold and alarm, keeps the report complete.

**The daily evidence check (N6).** The `30 3 * * *` tick `head`s the objects of upload-time files that are `present`
**and** either less than 2 days old, or attached to a report that isn't `finished` yet. That bounds the scan to recent
or still-relevant files, not every file ever. It **skips** every file whose case has `destruction_started_at` set, or
has a `csam_evidence_destroyed` audit row (`subject_label = 'csam_case:<caseId>'`, §5.6 Task 9b): rev-3 P7 deletes
those objects deliberately. A missing object moves the file to `missing` and raises U5 for it at once.

```ts
export type EvidenceState = "pending" | "present" | "failed" | "missing" | "file_without_evidence";

/** Pure. What the drain may do with one report file (§5.7). */
export function reportFileDisposition(
  state: EvidenceState,
  objectFound: boolean,
): "send_with_file" | "send_without_file" | "hold" {
  switch (state) {
    case "present":
      return objectFound ? "send_with_file" : "hold";
    case "file_without_evidence":
      return "send_without_file";
    case "pending":
    case "failed":
    case "missing":
      return "hold";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/** Pure. A report is submitted only when no file holds it. */
export function reportMaySubmit(files: readonly { readonly state: EvidenceState; readonly objectFound: boolean }[]): boolean {
  return files.length > 0 && files.every((f) => reportFileDisposition(f.state, f.objectFound) !== "hold");
}
```

---

## 6. Fail closed

### 6.1 Every way a scan can fail, and the answer

**Choice: reject with a neutral "try again later".** Inline, there is no processing state to hold an upload in, and
nothing has been written, so a refusal leaves nothing behind (§6.5 records why this wins over rev-3 §11.1's earlier
wording).

```
HTTP 503   Retry-After: 120
{ "code": "SERVICE_UNAVAILABLE", "message": "Image uploads are unavailable right now. Please try again later." }
```

`SERVICE_UNAVAILABLE` already exists (`packages/shared/src/errors.ts:79-82`). The same 503 answers every
"unavailable" row below, so an uploader can't tell a scanner outage from a credential fault. The web proxy rebuilds
its response headers (`apps/web/src/pages/media-upload.ts:37`, `:62`), so US6 has it copy `Retry-After` through.

| Failure | Detected by | Inline retry? | Answer | Alarm |
|---|---|---|---|---|
| flag off, or secrets missing | config read (§8) | no | 503 | U3 |
| HMS-A answers 401 or 403 (bad credentials, suspended, terminated) | status | no | 503 | U2, immediate |
| HMS-A answers 429 (throttled) | status | no; respect it | 503 | U1 |
| timeout (§6.2), network error, 5xx | `AbortSignal`, `fetch` rejection, status | once (§6.2) | 503 | U1 |
| a body over the 64 KiB cap, or one that doesn't parse to a documented shape | cap, then parse | no | 503 | U1 |
| HMS-A's test value | classification | no | 503 | U4, immediate |
| **decode failure, any kind** (the seam's `decode_error`, or a geometry mismatch, §3.5) | `hasExpectedGeometry` | no | **503**: unscannable, fail closed | U1 |
| the allowance error, as C3 records it (**superseded 2026-10-08:** with the binding removed this row goes dead, and so does U7) | the mapped `ImagesError` | no | 503 | U7, immediate |
| the VPS decoder is unreachable, times out, answers 5xx, or its response signature fails (VPS design §2.6) | `fetch`, `AbortSignal`, status, signature check | no | 503 | U1; U11 as well for a signature failure |
| the VPS decoder refuses our credentials (401) | status | no | 503, reason `decoder_credentials_refused` | its own reason, not U2: U2 is HMS-A's credentials. Counted into U1 as `unavailable` |
| the VPS decoder's `build_id` or `policy_sha256` is not on the allowlist | allowlist check | no | 503 | U11, immediate |
| PDQ quality ≤ 49 (a flat or near-flat image) | PDQ | no | **422 `IMAGE_UNSCANNABLE`**, "That image can't be checked, so it can't be uploaded. Try a different image." (D13); or the bytes fallback **only if its flag is on** (§6.3) | counted; U8 on each fallback use |
| no fresh decoder self-test (§3.6): the current version's newest run is missing, **failed**, or stale | `selfTestIsFresh` over the current version's newest run | no | 503 | U9, immediate |
| the match's intake transaction fails (§5.3) | the database error | no | 503 (M4) | log line only: the database is what failed |

**A decode failure is never routed to the bytes fallback by default** (I5). Whether a class of decode failures is
per-image rather than systemic is unknown until the spike, so it is treated as unavailable. If C3 shows such a class,
it can join the low-quality row, behind the same flag.

**Never published unscanned:** no row above leads to step 7. US6's tests drive each row and assert that `env.MEDIA`
holds nothing and that no `media` row exists (§9.4).

### 6.2 Timeouts and retry

- **Per call:** `AbortSignal.timeout(8_000)` on each HMS-A `fetch`.
- **Inline retry:** one, after 250–750 ms of jitter, only for a timeout, a network error or a 5xx. Never for a 4xx.
- **Total budget:** about 17 s of wall time at worst (8 s + 0.75 s + 8 s). CPU is unaffected (§2.2).
- **Byte cap before parse:** 64 KiB on every response body. That is the rev-3 spec's XML rule (§4.3) applied to
  JSON.
- **The user's retry:** the 503 carries `Retry-After`, through the proxy (§6.1). There is no server-side queue,
  because nothing was kept.
- **Logs:** a request log line names the operation, the status and the latency. Never a credential, a hash, a
  classification or any other Match Data (rev-3 spec §11.2, §11.5).
- **Rate:** one hash-only call per upload, carrying up to 8 hashes (§3.5). `MEDIA_LIMITER` (`media.ts:117-122`)
  bounds it per user.

```ts
/** HMS-A's answer, in our own neutral terms. The raw body is Match Data (rev-3 spec §11.2). */
export type HmsAClassification = "no_known_match" | "known_csam" | "harmful_abusive" | "test_value";
export type HmsAMatchType = "exact" | "near" | "none";

export interface HmsAAnswer {
  readonly classification: HmsAClassification;
  readonly matchType: HmsAMatchType;
  /** Near-match details, kept only with a case; never logged. */
  readonly matchData: unknown;
  readonly listVersion: string | null;
}

export type ScanPath = "hash" | "media";

export type UnavailableReason =
  | "not_enabled"
  | "not_configured"
  | "credentials_refused"
  | "throttled"
  | "timeout"
  | "network"
  | "server_error"
  | "bad_response"
  | "test_value_in_production"
  | "unscannable"
  | "images_allowance_exhausted"
  | "decoder_self_test_failed";

export type ScanVerdict =
  | { readonly kind: "clean"; readonly path: ScanPath; readonly listVersion: string | null }
  | {
      readonly kind: "match";
      readonly detection: "known_hash" | "classifier";
      readonly path: ScanPath;
      readonly answer: HmsAAnswer;
    }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason };

/** Q3's default (§4.3): an HMS-A near match on known CSAM is a known-hash match. Awaiting CireSnave (D1). */
export const NEAR_MATCH_IS_KNOWN_HASH = true;

/** Meta's README: "Quality Threshold where we recommend discarding hashes": "<=49". */
export const PDQ_MIN_QUALITY = 50;

export const HMS_A_TIMEOUT_MS = 8_000;
export const HMS_A_MAX_ATTEMPTS = 2;
export const HMS_A_RESPONSE_BYTE_CAP = 64 * 1024;

/** Pure. §5.4's table. Any combination it doesn't list fails closed. */
export function verdictFromAnswer(answer: HmsAAnswer, path: ScanPath, nearIsKnownHash: boolean): ScanVerdict {
  switch (answer.classification) {
    case "no_known_match":
      // "No known match" with a match type of exact or near is not a documented shape.
      return answer.matchType === "none"
        ? { kind: "clean", path, listVersion: answer.listVersion }
        : { kind: "unavailable", reason: "bad_response" };
    case "known_csam":
      if (answer.matchType === "exact" || (answer.matchType === "near" && nearIsKnownHash)) {
        return { kind: "match", detection: "known_hash", path, answer };
      }
      if (answer.matchType === "near") {
        return { kind: "match", detection: "classifier", path, answer };
      }
      return { kind: "unavailable", reason: "bad_response" };
    case "harmful_abusive":
      return { kind: "match", detection: "classifier", path, answer };
    case "test_value":
      return { kind: "unavailable", reason: "test_value_in_production" };
    default: {
      const unreachable: never = answer.classification;
      return unreachable;
    }
  }
}

/**
 * Pure. With 8 dihedral hashes in one call, the strongest answer wins (PM ruling N1):
 * a known-hash match > a review-first match > unavailable > clean.
 * A MATCH on any variant outranks everything else; unavailable outranks only clean.
 */
export function strongest(verdicts: readonly ScanVerdict[]): ScanVerdict {
  const rank = (v: ScanVerdict): number =>
    v.kind === "match" ? (v.detection === "known_hash" ? 3 : 2) : v.kind === "unavailable" ? 1 : 0;
  let best: ScanVerdict = { kind: "unavailable", reason: "bad_response" }; // an empty answer fails closed
  let bestRank = -1;
  for (const v of verdicts) {
    const r = rank(v);
    if (r > bestRank) {
      best = v;
      bestRank = r;
    }
  }
  return best;
}

/** Pure. Only transient failures earn the one inline retry (§6.2). */
export function isRetryable(reason: UnavailableReason): boolean {
  return reason === "timeout" || reason === "network" || reason === "server_error";
}
```

`strongest` ranks **a match above everything** (PM ruling N1). One variant's known-CSAM answer is a match even if
another variant's answer is unavailable or malformed, so the match path (§5.3) runs: evidence, case and report. An
unusable answer outranks only clean. If no variant matches and any is unusable, the upload fails closed (503) rather
than being decided clean on the others. An empty answer list is unavailable.

### 6.3 The bytes fallback (I5): off unless chosen

- **Its own flag:** `UPLOAD_SCAN_BYTES_FALLBACK`, a Worker secret (§8), `"1"` to enable. **Unset means off**, and off
  is the shipped state.
- **When it may fire, with the flag on:** only for a PDQ of quality ≤ 49, plus any decode-failure class C3 proves is
  per-image (§6.1). Never for a systemic failure (an allowance error, a self-test failure, or an outage), so it can
  never fire for every upload.
- **Every use is recorded and alarms:** an `upload_scan_outcomes` row with `scan_path = 'media'`, a log line
  (`upload-scan: bytes fallback used`, with no hash or user id), and U8. U8 raises on **every** tick that saw a use:
  the banner and the log line every time, and an email batched per tick, with the count.
- **What it sends:** the file as uploaded, by default (D4, §10.1).

### 6.4 Alarms: which mechanism

**Neither alarm mechanism exists in code yet.**
- At `f3da62d`, `git grep -n -i "ncmec"` over `apps/api/src` finds 1 hit, a comment at `media/legal-hold.ts:13`, and
  no code.
- `git grep -c "SecurityAlertSink"` over `apps/` and `packages/` finds 0.
- The same `git grep -c` for `postmarkSend` finds it in 9 files under `apps/api/src`, so the method finds code that
  exists.

Both mechanisms are designs:
- **The CSAM alarm mechanism** (rev-3 spec §6.1–§6.3; #114 plan Task 8). Conditions are computed from tables on the
  `*/2` tick and shown as the `/admin/*` banner. Email goes to `CSAM_ALARM_EMAIL`, immediately on first raise, then
  daily, and a log line is written every tick. **The scanner's alarms are added to it** as U1–U11 (§11.1). An outage of
  child-safety scanning is a child-safety control failure, and `CSAM_ALARM_EMAIL` is the urgent inbox CireSnave named
  (rev-3 spec §0).
- **The security-alert seam** (`2026-10-07-security-alerting-design.md` §3.2–§3.3 at `f3da62d`):
  `SecurityAlertSink`, `selectSecurityAlertSink`, `deliverSecurityAlert`.
  - Its only caller is `SecurityLedgerDO` (§3.3), and its signals are the brute-force set (`SecurityAlertSignal`,
    §3.2).
  - Routing U1–U3 through it as well would mean adding an `upload_scan_fault` signal to its `infra` class, which is an
    amendment to that spec.
  - Board 131 hasn't chosen its transport, so until then it would only reach the log sink.
  - **Recommendation:** the CSAM surfaces are the channel. The seam gets the signal only if the PM wants a second
    channel once board 131 lands (D10).

### 6.5 Rev-3 §11.1, amended in this commit (I8)

Rev-3 §11.1 said the upload "stays **in processing**", "is retried with backoff". This design returns a 503, keeps
nothing, and leaves the retry to the user. **This design's wording wins, and rev-3 §11.1 is amended in the same
commit to say so.** Why:
- The rule's purpose, *"An image that cannot be scanned is never published"*, is met either way.
- "In processing" needs a stored original and a queue (§2.1). That breaks `media.ts:24-30`'s "original never
  persisted" for every upload, to serve a retry the user can make themselves.
- §11.1 itself deferred "the scanner itself, and the 'in processing' state" to this plan.

If the spike's C4 fails and the queue shape returns (§2.3), §11.1 is revisited with it.

The same commit amends six other rev-3 passages that the upload-time path made stale (round-2 M1):
- §3.3 step 3: an upload-time match opens a case with no `media` row;
- §3.3 step 5: the case-file route also serves held keys;
- §3.7: the held-key refusal's status, pending D14;
- §5.2's table and P7 step 2: the evidence key's extension;
- §8: where scanning enters;
- §11.5: `HMS_A_BASE_URL` as a secret, pending D8.

### 6.6 The outcome record (I12)

The alarms need a durable count of failures that doesn't depend on logs:

```sql
CREATE TABLE upload_scan_outcomes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  at          timestamptz NOT NULL DEFAULT now(),
  outcome     text NOT NULL CHECK (outcome IN ('scanned', 'unavailable')),
  reason      text,             -- an UnavailableReason; NULL unless 'unavailable'. Amended 2026-10-08: gains the value 'decoder_credentials_refused' (VPS design §2.6). A new reason value only, so the outcome CHECK above does not change.
  scan_path   text CHECK (scan_path IN ('hash', 'media')),
  latency_ms  integer,
  case_id     uuid              -- bare; set only when the scan opened or joined a case. Nothing else about it.
);
CREATE INDEX upload_scan_outcomes_at ON upload_scan_outcomes (at);
```

- `scanned` covers both clean and matched scans. A row says nothing about the result **except** through `case_id`,
  which points to the case and carries none of HMS-A's answer.
- Match Data stays only in the case and the evidence store (rev-3 §11.3).
- The table holds no user id, no hash and no classification.
- Rows older than 30 days are deleted by the daily `15 4 * * *` branch.

---

## 7. The PhotoDNA scan step

A slot for a second layer sits after HMS-A in step 6e, `scanSecondLayer(...)`. It is called only when HMS-A answers
clean, and it is **off** until approved. Its switch is a Worker secret, `SECOND_SCAN_STEP_ENABLED`. The name is
deliberately generic; the PM OKs it (M10, D15). Once enabled, its outage fails closed exactly like HMS-A's (§6.1): an
upload it cannot check gets the 503, never a publish. A match enters the same `runUploadIntake` under `self_scan`, and
its results are Match Data under the rev-3 spec §11.2. Nothing else about it is recorded in this repo.

---

## 8. Rollout flag

**Every scan setting is a Worker secret, never a committed or `--var` setting.**
- **What the repo does today:** there is no `vars` block in `apps/api/wrangler.jsonc`, deliberately. The admin plan
  says of `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`: "Supply them exactly like `TEST_ROUTES`/`PREVIEW_ORIGIN`:
  `apps/api/.dev.vars` locally, `miniflare.bindings` in `vitest.config.ts` for tests, `--var` at deploy. Do **not** add
  a `vars` block to `wrangler.jsonc`" (`docs/superpowers/plans/2026-09-08-m4-module-2a-admin-foundation.md:43`).
- **Why not that for these:**
  - A plain var set with `--var` or in the dashboard lives only until a later `wrangler deploy` without it. Wrangler's
    docs, as the audit read them on 2026-10-07, say dashboard changes are overridden on the next deploy unless
    `keep_vars` is set.
  - A flag that switches image uploads between refused and scanned must not silently flip on a routine deploy.
  - A secret persists across deploys, and its absence means **off**, which fails closed (§8.1).
  - (Whether the api Worker has any dashboard-set plain vars today is account state, and the operator checks it before
    US9.)
- **The settings** (all via `wrangler secret put`):
  - `UPLOAD_SCAN_ENABLED` (`"1"` or anything else);
  - `HMS_A_USERNAME`, `HMS_A_PASSWORD`;
  - `HMS_A_BASE_URL`, which must be `https:` (M5);
  - `UPLOAD_SCAN_BYTES_FALLBACK` (§6.3);
  - `SECOND_SCAN_STEP_ENABLED` (§7).
- ⚠️ **`HMS_A_BASE_URL` as a secret.** As a committed var it would publish the provider's host in this public repo.
  Rev-3 §11.5 calls it "the var `HMS_A_BASE_URL`". This design reads that as "a Worker setting", and the PM confirms
  (D8). If an endpoint path would identify the provider, it moves into the secret too.
- **Re-setting the `HMS_A_*` secrets is pending with CireSnave.** The flag can't take effect before they exist:
  `uploadScanConfig` refuses to treat it as on without them.

```ts
export interface UploadScanEnv {
  readonly UPLOAD_SCAN_ENABLED?: string;
  readonly HMS_A_USERNAME?: string;
  readonly HMS_A_PASSWORD?: string;
  readonly HMS_A_BASE_URL?: string;
}

export type UploadScanConfig =
  | { readonly kind: "off" }
  | { readonly kind: "misconfigured"; readonly problems: readonly string[] }
  | { readonly kind: "on"; readonly baseUrl: string; readonly username: string; readonly password: string };

/** Pure. "off" and "misconfigured" BOTH refuse image uploads (§8.1): there is no unscanned mode. */
export function uploadScanConfig(env: UploadScanEnv): UploadScanConfig {
  if (env.UPLOAD_SCAN_ENABLED !== "1") return { kind: "off" };
  const baseUrl = (env.HMS_A_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const username = (env.HMS_A_USERNAME ?? "").trim();
  const password = env.HMS_A_PASSWORD ?? "";
  const problems: string[] = [];
  if (baseUrl === "") {
    problems.push("HMS_A_BASE_URL missing");
  } else if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== "https:") {
    // Basic credentials must never travel in clear text (M5).
    problems.push("HMS_A_BASE_URL is not https");
  }
  if (username === "") problems.push("HMS_A_USERNAME missing");
  if (password === "") problems.push("HMS_A_PASSWORD missing");
  if (problems.length > 0) return { kind: "misconfigured", problems };
  return { kind: "on", baseUrl, username, password };
}
```

The `problems` strings name keys only, never values.

### 8.2 Reading back what is on (N5)

Worker secrets are write-only: `wrangler secret list` shows names, not values. So the state is read back from the
Worker itself:
- **`GET /admin/upload-scan/status`** (Access-gated: `requireAdmin` first, as every `/admin/*` route) returns
  **booleans and key names only, never a value**:

  ```
  { scanEnabled, configured, misconfiguredKeys: ["HMS_A_PASSWORD", …], bytesFallbackOn, secondStepOn,
    selfTest: { fresh, lastPassAt, lastRunAt, lastPassed, versionMatches } }
  ```

  `misconfiguredKeys` is `uploadScanConfig`'s `problems`, which name keys only (§8).
- **The page `/admin/upload-scan`** (`apps/web/src/pages/admin/upload-scan.astro`) shows them. It is modelled on
  `media-access.astro`: the guard first (`:40-43`), then `markPrivate`, `setPublicPageCsp` and `adminApiFetch`.
- **The banner** shows "Bytes fallback is ON" on every admin page whenever `bytesFallbackOn` is true, and
  "Image uploads are refused: scanning is off or misconfigured" whenever `scanEnabled && configured` is false.
- **The `*/2` tick logs the booleans** once per tick (`upload-scan: state scan=1 configured=1 fallback=0 second=0
  selftest=fresh`), with no values.
- **What is verified against it:** launch blocker 1 (§11.2) and whether privacy-policy §9's fallback clause applies
  (§10.3). The operator pastes the page's state into the rollout PR, and re-checks it after any secret change.

### 8.1 Before registration: what happens to uploads

| Option | Effect | Verdict |
|---|---|---|
| **(a) block image uploads** | with the flag off or misconfigured, every `POST /media` that passes steps 1–6 gets §6.1's 503, and U3 shows on the banner | **Recommended** |
| (b) allow them unscanned, relying on the pipeline's other layers | publishes images nobody has checked. The other layers are Cloudflare's tool (whether it covers R2 is UNVERIFIED, rev-3 §0), admin sightings and the backfill, and all of them act **after** publication | Not recommended |

Why (a): rev-3 §11.1's rule is *"An image that cannot be scanned is never published"*, and CireSnave chose upload-time
scanning because it is *"substantially cleaner than dealing with questionable images after they are already being
served from our site"* (§0.1). Option (b) is the after-the-fact model he moved away from. The cost of (a) is small
before launch: the community is not yet open to users (rev-3 §0: the `APP.live` trigger), and text posts are
unaffected.

- **When (a) takes effect:** when US6, the route change, merges. Until then the route is unchanged, and uploads stay
  unscanned exactly as today. The PM chooses when US6 merges, and it can wait for the registration.
- **The launch blocker:** **no public launch with scanning off.** `APP.live` doesn't flip while scanning is off in
  production, or while any §11.2 item is open. That joins the rev-3 spec's own gate on #114 (§0, AC-C8).

---

## 9. Test vectors, with no real abusive material

⚠️ **No real abusive material is ever fetched, stored, generated, described or used** in any test, fixture, spike,
corpus, script, issue or PR. Every "match" in a test is a **synthetic** image that a stub has been **told** to call a
match. No real hash from any list is used either: a list hash would be Match Data or list content, and we have no
reason to hold one. The fidelity corpus (§3.4) is public, non-abusive, and has no people in it.

### 9.1 Synthetic images

A committed generator (`apps/api/test/fixtures/scan/generate.mjs`), with fixed seeds, makes the images:
- flat colours, gradients, checkerboards and seeded noise;
- the spike's edge shapes (§2.4);
- two animated files whose frames differ;
- EXIF Orientation 6 and 8 JPEGs.

For `FakeImageDecoder`, the generator also writes each image's intended 512 × 512 RGB frame, computed in pure
JavaScript: a nearest-neighbour squeeze of its own pixel array, rotated per its EXIF tag. Those frames are what the
fake returns. Their bytes are committed with the generator and the command used. No photograph of a person is used
anywhere.

### 9.2 PDQ correctness (C5)

- **The method Meta prescribes:** "Generating byte arrays from the C++ reference implementation and then piping them
  into the new implementation produces the exact same hash as the C++ reference implementation."
- The implementer runs the pinned reference once on the synthetic frames' raw RGB arrays (and on `pdq/data`'s, if its
  licence allows, §3.7). They commit the outputs together with the exact command and the upstream SHA.
- Our port must equal them **bit for bit**, for the hash, for quality, and for all 8 dihedral variants.
- That tests the port without any decoder.

### 9.3 A mock HMS-A

A `fetch` stub that routes on URL path, the same pattern as the #114 plan's NCMEC double (Task 7). It is scriptable
per test:
- a configured set of "match" PDQ hashes, each with a classification and a match type. They are PDQ hashes of the
  synthetic frames, or one of their dihedral variants (for example, the checkerboard's 90° variant is "known CSAM,
  near"), so the dihedral path is tested;
- every documented failure: 401, 403, 429, 5xx, a hang past the timeout, a malformed body, a body over the cap;
- the test value;
- the media endpoint, matching on the SHA-256 of the received bytes.

### 9.4 Contract and route tests

- **Response shapes.** Fixtures for each documented HMS-A response, transcribed from its API document with
  **synthetic values only**, parsed by the real client into `HmsAAnswer`. One case per documented shape and per
  error. An undocumented shape must fail closed (`bad_response`).
- ⚠️ **Naming.** The fixtures' field names and enum strings come from a private document. Before merge, the PM runs
  the private vendor pattern over these test files, as the #114 plan's whole-branch vendor check does. If a field
  name would identify the provider, it stays out of the public repo, and the test reads it from the same secret-held
  configuration.
- **Route tests (US6)** use `FakeImageDecoder` and the mock HMS-A (C2). They cover:
  - every row of §6.1;
  - after each failure row: `env.MEDIA` is empty and there is no `media` row;
  - a match: `env.MEDIA` is empty; after commit, `env.MEDIA_RESTRICTED` holds exactly the **original** bytes at the
    evidence key; the case, the evidence hold, the account hold, the report and the uploader id exist; the body is
    exactly §5.1's;
  - a clean upload: 201, and a row carrying `original_sha256`, `pdq`, `pdq_quality`, `scan_path` and
    `scan_list_version`.
- **Mutations of our code** (each must turn a green test red):
  1. move the scan after step 9, and "nothing in `MEDIA` after a match" fails;
  2. let `unavailable` fall through to step 7, and the fail-closed tests fail;
  3. **(revised for C2)** drop `anim: false` from `decodeRequestFor`, and the test asserting
     `fake.requests[0].anim === false` fails. Drop it from `toWebp`'s `.output()` options, and a recording wrapper
     around `env.IMAGES`, which records the options **our** code passes, fails its assertion. Neither depends on what
     Miniflare's `sharp` does with an animation;
  4. remove `hasExpectedGeometry`'s check, and a fake that returns a 300 × 400 × 3 buffer is no longer refused, so
     its 503 test fails;
  5. put the evidence `put` before the transaction, and the "transaction fails → no object" test fails (§5.3).

---

## 10. Data flows and privacy

### 10.1 What leaves our system

| Path | Sent to HMS-A | Not sent |
|---|---|---|
| hash-only (normal) | up to 8 PDQ hashes (256 bits each) per upload, plus the credentials | the image, the user id, the handle, the IP, the post |
| media endpoint (fallback; **only with its flag on**, and only for low quality or a proven per-image decode failure, §6.3) | **the image file as uploaded**, including any embedded metadata (EXIF location, for example), plus the credentials | the user id, the handle, the IP, the post |
| PhotoDNA scan step (off) | not recorded here (§7) | |
| a match | nothing more goes to HMS-A. The NCMEC report (rev-3 spec §4.5) carries the original file | |

The provider's terms let it process media submitted on the fallback outside the US, share it with partner
organisations abroad, and keep it (rev-3 spec §11.6). There is a choice about what the fallback sends (D4):
- the file **as uploaded**, metadata included, gives the best match fidelity;
- a metadata-stripped re-encode protects location data.

### 10.2 What we keep, and where

| What | Where | How long |
|---|---|---|
| a clean upload's `original_sha256`, `pdq`, `pdq_quality`, `scan_path`, `scan_list_version`, `scanned_at` | the `media` row | as long as the row |
| HMS-A's "no known match" answer | not kept beyond `scanned_at`, `scan_path` and `scan_list_version` (rev-3 spec §11.3) | |
| a matched original, **with its embedded metadata** | `MEDIA_RESTRICTED`, `evidence/csam/…`, under a `csam` hold | the rev-3 spec's §5: at least 1 year after the last submission; a confirmed case's is kept; a cleared case's is destroyed after its end (P7) |
| Match Data | only with the case | as the case's evidence (rev-3 spec §11.3) |
| outcome counts | `upload_scan_outcomes` (no personal data; a case id at most) | 30 days |

### 10.3 Wording for `docs/legal` (draft; applied at rollout, not now)

**This PR edits no file under `docs/legal`.** US9 makes these edits at rollout. It keeps `[[LEGAL_ENTITY]]` (board
129) where it stands, and inserts the provider's mandated sentence **verbatim from the private copy** at the marker.
The sentence is mandated, and is never quoted, paraphrased or attributed here. Nothing below names the provider.

**Privacy policy:**
- **§1 "We deliberately minimize"** (`privacy-policy.md:35-38`). **Replace** the existing bullet (`:36-37`, "Uploaded
  images are converted to WebP and **EXIF metadata is stripped**, so location and camera data embedded in your photos
  are removed before storage.") with this, because the existing sentence becomes false for a matched file and for the
  fallback (I11):
  > - Uploaded images are converted to WebP and **EXIF metadata is stripped** from the copy we publish and store for
  >   display, so location and camera data embedded in your photos are removed from it. Two exceptions: if an image
  >   matches known child sexual abuse material, we keep the file exactly as you uploaded it, metadata included, in
  >   restricted storage (see §5); and if our child-safety check has to send an image itself rather than its
  >   fingerprint, it sends the file as you uploaded it (see §2 and §9).
  > - Before an uploaded image is stored or shown, it is checked against known child sexual abuse material by a
  >   third-party child-safety service. Normally we send that service only digital fingerprints (hashes) computed
  >   from your image, not the image itself. We keep fingerprints of each image you upload with that image's record.

  If D4 rules "strip metadata before sending", the fallback clause in the first bullet changes to match.
- **§2 "Why we use it"** (`:44-45`, beside "scanning uploaded images for known CSAM"):
  `[[HMS_A_MANDATED_DISCLOSURE: inserted verbatim at rollout; it names [[LEGAL_ENTITY]]]]`. This placement follows
  rev-3 §11.7.
- **§4 "Sharing"** (`:70-73`), a sentence of its own, not a §3 row, because the provider is an independent controller
  (rev-3 §11.7):
  > We share an image's fingerprints, and sometimes the image itself, with a third-party child-safety service that
  > checks uploads for known child sexual abuse material. That service makes its own decisions about the data it
  > receives; it does not act on our behalf.
- **§5 "Retention"** (`:93`), a new bullet:
  > If an image you upload matches known child sexual abuse material, it is not published. We keep the file privately,
  > with access limited to two administrators acting together, for at least one year after any report we make to the
  > National Center for Missing & Exploited Children, and longer where the law allows.
- **§9 "International transfers"** (`:182-193`), only while the fallback flag is on, as `/admin/upload-scan` shows
  it (§8.2), or if D4 makes it standing. Turning the flag on or off is paired with this edit in the same change:
  > When our child-safety service can't check an image by its fingerprint, the image itself is sent to that service.
  > The service may share it with child-protection organisations outside the United States for classification, and
  > may keep it.

**Terms of service, §4 "Acceptable use"** (`terms-of-service.md:48-54`):
> We check every uploaded image against known child sexual abuse material before it is published, using a
> third-party child-safety service, and we may refuse an image without giving a reason.

---

## 11. Alerts and launch blockers

### 11.1 Alarms (added to the CSAM alarm mechanism, §6.4)

Each condition shows on the banner, and the `ncmec ALARM` log line repeats on every tick while it holds. Email
follows rev-3 §6.3's rules. **Only the alarm tick writes the mark tables** (M7). The self-test, the intake and the
backfill write their own facts (`upload_scan_selftests`, `csam_case_files.evidence_state`, `upload_scan_outcomes`,
`media_scan_backfill`), and the tick computes every condition from those facts. "First raise" means:
- **per item** in `csam_alarm_marks`, under the numbered conditions §5.6 Task 3 adds: 105 for U5, keyed by the case
  file's `id`; 106 for U6, keyed by the `media_scan_backfill` row's `id` (M2);
- **per condition** in the new `csam_condition_marks` (`'U1'`, `'U3'`, `'U7'`, `'U9'`, `'U10'`, and, from 2026-10-08, `'U11'`). A condition is first
  raised when its row has no `raised_at`, or has a `cleared_at`. The tick that finds it raised sets `raised_at` and
  clears `cleared_at`, and the tick that finds it clear sets `cleared_at`.

The U5 **request path** writes no mark (round-3 (c)1). It records two facts on the case file,
`evidence_state = 'failed'` and `evidence_alarm_sent_at = now()`, and sends the immediate email itself, best effort
(§5.3 step 4). When the tick first raises U5 for that file, it writes the mark as usual and **skips the email** if
`evidence_alarm_sent_at` is set. If the request's send failed, the field is left NULL, and the tick's first raise
sends it. Every condition is computed from recorded
events, never from a guess about which deployment this is (M14).

| # | Condition | Email |
|---|---|---|
| U1 | ≥ 3 `unavailable` outcomes in 10 minutes, or every outcome in the last 30 minutes is `unavailable` | immediate on first raise, then daily |
| U2 | any `credentials_refused` outcome since the last tick | immediate |
| U3 | any `not_enabled` or `not_configured` outcome in the last 24 h: an upload was refused because scanning is off or misconfigured | immediate on first raise, then daily |
| U4 | HMS-A's test value seen in an outcome | immediate |
| U5 | an upload-time case file in `failed` or `missing` (§5.7; the daily check skips destroyed cases); or a logged "match intake failed" (log only) | **immediate**, from the request when the request sees it |
| U6 | the backfill: not completed, or a key `failed`, `unscannable` or `needs_review` without `reviewed_at` (§4.4) | daily; immediate for each new `failed` key |
| U7 | an `images_allowance_exhausted` outcome | immediate |
| U8 | the bytes fallback was used (§6.3): the count since the last tick | banner and log every tick it holds, plus one email per such tick |
| U9 | no fresh passing self-test for the current deployment (§3.6), or the newest run failed | immediate |
| U10 | a case with `serving_lookup_incomplete = true` and `serving_lookup_ack_at IS NULL` (§5.3 step 1). It clears only when an admin acknowledges it through `POST /admin/csam/:caseId/serving-lookup/ack`, which writes an audit row (§5.6, Task 9) | immediate on first raise, then daily |
| U11 | (added 2026-10-08, VPS design §2.6) decoder identity drift: a VPS response whose `build_id` or `policy_sha256` is not on the allowlist, or whose response signature fails. It replaces U7, which goes dead once the Images binding is removed. Computed from recorded events like the others | immediate |

Every case a match opens also takes the rev-3 spec's conditions 1–6: URGENT at match, every 4 h, and OVERDUE after
24 h. A report held for missing evidence (§5.7) also reaches condition 3 after 6 h.

### 11.2 Launch blockers (`APP.live` stays off until every one holds)

1. HMS-A registration is done, the three `HMS_A_*` secrets are set (pending with CireSnave), and
   `UPLOAD_SCAN_ENABLED = "1"` in production. **Verified on `/admin/upload-scan` (§8.2):** `scanEnabled`,
   `configured`, a fresh self-test, and the fallback in the state the privacy policy describes.
2. The #114 pipeline's own gate: Tasks 3, 6, 7, 8 and 9 are merged with §5.6's amendments, and AC-C8's exttest run
   reaches `finished`.
3. The spike's C1–C7 are met, and C8 is reported, with its table in the PR (§2.3).
4. **Positive controls, without a test hook in production code:**
   - the synthetic-match chain (mock HMS-A, `FakeImageDecoder` → case, evidence object, queued report) is green in
     the test suite;
   - the operator runs `apps/api/scripts/hms-a-positive-control.mjs` from their own machine, with the production
     secrets in their shell. It sends HMS-A's documented test value to the hash-only endpoint through the same client
     module, and shows the test-value answer;
   - the deployed decoder self-test passes (§3.6), and a deploy is shown to refuse image uploads with the 503 until
     its first self-test passes.
5. The backfill is complete: `completed_at` is set, and no key is `failed`, `unscannable` or `needs_review` without
   review (U6 clear).
6. Each of U1–U11 is shown to fire, and shown **not** to fire when its condition is removed. For U10, removing the
   condition **is** the acknowledgement: the alarm fires for a case with the flag, and clears after the ack route
   records it, with its audit row.
7. The privacy-policy and terms edits (§10.3) are merged, with the mandated sentence inserted, and `[[LEGAL_ENTITY]]`
   either resolved or explicitly kept pending by the PM.
8. Images transformation capacity is decided (D7).
9. At least two Access admins exist (rev-3 §0's precondition, ruling f).
10. Rulings on D1 (Q3) and D2 (Q4).

---

## 12. Legal assumptions

⚠️ **Legal uncertainty: no attorney.** CireSnave, verbatim: *"There is no attorney nor can I afford one so proceed
with best safe guesses."* Every point below is a reading, not advice, and nothing here has been reviewed by a lawyer.
The statute text is the rev-3 spec's §0 quotation of the 2024 US Code, unchanged.

- **When actual knowledge arises.** §2258A(a)(1)(A)(i): a provider "shall, as soon as reasonably possible after
  obtaining actual knowledge of any facts or circumstances described in paragraph (2)(A), take the actions described
  in subparagraph (B)".
  - Whether a known-hash match is itself "actual knowledge" is **unsettled** (rev-3 §3.5). This design takes the safe
    side, as Option B already does: a known-hash match at upload is treated as enough to report.
  - A review-first answer (the harmful-or-abusive category, or a near match if Q3 rules no) is read as **not** actual
    knowledge on its own, only a reason for a moderator to look. The moderator's CONFIRM then files (rev-3 §3.5;
    §5.6 here, Task 9).
- **Report timing.** The report is queued **in the match's own transaction** (§5.3), and the `*/2` drain sends it.
  Option B removes human delay from the path. It can still be late, or fail to finish, in three ways that are known
  and each alarmed:
  - missing NCMEC credentials (`awaiting_credentials`, rev-3 §4.4);
  - an NCMEC outage;
  - an evidence object that never got written. The drain then **holds** the report until the bytes arrive or two
    admins decide to file without them (§5.7), and U5 fires at once. ⚠️ **Legal uncertainty: no attorney.** The duty
    runs "as soon as reasonably possible after obtaining actual knowledge". Holding a report for a missing file
    trades speed for completeness, and that trade is a reading, not a settled point. CireSnave or the PM may rule
    that a failed file is filed without evidence at once.
- **What we tell the uploader.** Only §5.1's neutral sentence.
  - The parts of §2258A that rev-3 quotes contain no duty to notify the user. Whether any other law requires notice
    is not established here.
  - The neutral wording avoids accusing an innocent parent (R1's newborn example), and avoids telling an offender a
    report was made, while still refusing the image, as CireSnave ruled. No notice follows later either (rev-3 A3).
- **Preservation.**
  - §2258A(h)(1): a completed submission "shall be treated as a request to preserve the contents provided in the
    report for 1 year after the submission to the CyberTipline".
  - (h)(2) reaches "any visual depictions, data, or other digital files that are reasonably accessible and may provide
    context".
  - We preserve the **original** upload, which is the most faithful copy we could hold, plus the account hold, the
    uploader id and the case records, under the rev-3 spec's §5 rules.
  - This design reads `MEDIA_RESTRICTED`, the two-person grant, and the absence of any human view at upload time as
    its attempt to meet (h)(3)'s "secure location" and §2258B(c)(1)'s "minimize the number of employees". Whether they
    meet those duties is a reading, and the #114 plan's Task 13 maps them to the NIST framework.
- **What we disclose.**
  - To NCMEC: the report, with the original file, `fileViewedByEsp = false` at match, `publiclyAvailable = false`,
    the attempt time and no web page (§5.6, Task 7). A quarantined serving copy is reported as rev-3 §4.5 already
    says.
  - To HMS-A: hashes, or with the fallback flag on, the file. Sending suspected material to anyone but NCMEC is the
    riskiest step in this design (options doc §3.4). That is why bytes are a fallback, off by default, and why they go
    only to a child-protection body. CireSnave permitted it (§0.1).
  - To the public: the generic policy wording (§10.3) and the mandated sentence.
- **Holding a matched file at all.** We keep it because §2258A(h) asks providers to preserve reported material. This
  design reads that as covering a file held in a restricted store from the match onward, including the moments before
  the report's submission. That reading is **unsettled**.
- **Not scanning refused uploads.** An upload refused for size, format, pixels or quota (steps 3–6) is never scanned,
  and its bytes die with the request (§1.2). §2258A(f) requires no scanning. This design reads that as leaving no
  knowledge, and so no duty, for bytes we never inspected and never kept.

---

## 13. Tasks

Plan style as in the #114 plan: red-first tests, files named, mutations recorded. Every PR body says **"Part of
#114"**. The PM allocates version numbers at gate time, and no task bumps one.

**Can ship before both the NCMEC credentials and the HMS-A registration:**
- US0 (C1–C3, C5–C7);
- US1, US2, US3 (against the mock);
- US4 (if D12 releases Task 12).

**Waits on the #114 tasks, which themselves wait on the NCMEC credentials:** US5, US6, US7, and US8's match path.
**Waits on HMS-A registration:** US0's C4, US8's run, and US9.

| Task | Depends on |
|---|---|
| US0 spike | US1 |
| US1 PDQ port | — |
| US2 decoder seam and binding decoder | US0 (C3, C6) |
| US3 HMS-A client and mock | — |
| US4 schema | #114 Task 12's gate (D12) |
| US5 #114 amendments | #114 Tasks 3, 6, 7, 8, 9 (folded in, ideally) |
| US6 route integration | US1–US5, #114 Task 6 |
| US7 alarms U1–U11 | #114 Task 8, US4 |
| US8 backfill | US1–US4, #114 Task 6 |
| US9 rollout | everything above, the registration, and the rulings |

### US0: Spike (§2.4)

- **Files:** a scratch Worker outside the repo, and the generator `apps/api/test/fixtures/scan/generate.mjs`
  (committed in US2).
- **Output:** the C1–C7 table, the C6 distance distribution, and the recorded `9422` shape.
- **Stop** and report if C1, C2, C3, C5, C6 or C7 fails. §2.3 says which design changes.

### US1: PDQ port

**Files:**
- create `apps/api/src/media/pdq/{pdq.ts,dihedral.ts,downscale.ts,torben.ts,hash-types.ts,luma.ts,LICENSE,NOTICE}`
  (§3.7's scope: `hashing/`, `downscaling/` including `fillFloatLumaFromRGB`, and `common/`);
- modify `LICENSE.md` (§3.7);
- test `apps/api/test/pdq.node.test.ts`, with fixtures in `apps/api/test/fixtures/pdq/`.

Steps:
- [ ] **Step 0: Vetting** (§3.7 steps 1–3). Record the upstream SHA, the licence text and `torben.cpp`'s
  public-domain header in the PR.
- [ ] **Step 1: Failing tests.**
  - The reference outputs bit for bit, for the hash, the quality and the 8 dihedral variants (§9.2).
  - The flat image's quality is ≤ 49.
  - A one-pixel change moves the hash by ≤ 10, and an unrelated image by > 31.
  - **Mutation:** transpose the DCT matrix, and the vectors fail.
- [ ] **Step 2:** port (§3.7 step 4). **Step 3:** pass. Commit
  `feat(media): PDQ perceptual hash, ported from Meta's reference implementation (Part of #114)`.

### US2: Decoder seam and binding decoder

**Files:**
- create `apps/api/src/media/scan-decode.ts` (§3.3's types, `decodeRequestFor`, `hasExpectedGeometry` and
  `FakeImageDecoder`);
- `ImagesBindingDecoder` goes in `images.ts`, keeping that file the only place `env.IMAGES` is touched
  (`images.ts:1-4`);
- the self-test (§3.6): `apps/api/src/media/scan-selftest.ts`, `selfTestIsFresh` and `selfTestDue`, the four
  committed synthetic fixtures (`scan-selftest-fixtures.ts`) and their expected hashes, recorded from US0's deployed
  run, the `upload_scan_selftests` table, the `*/2` branch, and the Access-gated `POST /admin/upload-scan/self-test`;
- tests: `apps/api/test/scan-decode.node.test.ts`.

Tests:
- [ ] **Failing tests, all against our code and the fake:**
  - `decodeRequestFor` always asks for 512 × 512 and `anim: false`, for each format;
  - `hasExpectedGeometry` refuses 300 × 400 × 3, 512 × 512 × 4 and 0-byte buffers, and accepts 512 × 512 × 3;
  - the fake records requests, and answers `decode_error` for unregistered bytes;
  - the allowance mapping turns US0's recorded shape into `allowance_exhausted`, and anything else into
    `decode_error`;
  - the self-test passes on the fakes' frames and fails if any one of the four differs;
  - `selfTestIsFresh`: no row, a failed row, another `version_id`, a row 24 h + 1 s old, and a future-dated row are
    all **not** fresh; a passing current-version row 1 h old is. **Mutation:** drop the `version_id` comparison, and
    the "another deployment" case fails;
  - ⚠️ **a failed newest run closes uploads at once:** a pass at T, then a failed run at T + 1 h, then an upload at
    T + 1 h + 1 s → **503** (the route test reads the newest current-version run, whatever its result). **Mutation:**
    make the gate query `WHERE passed`, and this test gets the old pass and fails;
  - `selfTestDue` is true after a deploy (new `version_id`), after a failed newest run, and after 23 h, and false at
    1 h after a pass.
- [ ] **No local test calls `ImagesBindingDecoder`.** Miniflare refuses `rgb` (§3.3). Its evidence is US0's table,
  pasted in the PR, and the deployed self-test.

### US3: HMS-A client and mock

**Files:**
- create `apps/api/src/media/hms-a-client.ts` and `apps/api/src/media/upload-scan.ts` (§6.2's types and pure helpers,
  §8's config);
- tests: `apps/api/test/hms-a-client.test.ts` and `apps/api/test/upload-scan.test.ts`, with the mock in
  `apps/api/test/helpers/hms-a-double.ts`;
- the operator's script `apps/api/scripts/hms-a-positive-control.mjs` (§11.2 item 4).

Steps:
- [ ] **Implementer check first:** from HMS-A's API document, does the hash-only endpoint take several hashes, and
  does it match rotations itself? Record the answer for the PM (§3.5), with no vendor-identifying text.
- [ ] **Failing tests:**
  - §9.3 and §9.4's cases;
  - every row of `verdictFromAnswer` for both values of `NEAR_MATCH_IS_KNOWN_HASH`, including "no known match" with
    exact or near → `bad_response`;
  - `strongest` over mixed lists, including the empty list. **N1's case:** one variant `known_hash` and another
    `unavailable` → the match. A `classifier` match and an `unavailable` → the match. `unavailable` and clean →
    `unavailable`. **Mutation:** rank `unavailable` above match, and N1's case fails;
  - `uploadScanConfig` with each secret blank in turn, and with an `http:` base URL, which gives `misconfigured`;
  - the 64 KiB cap fires before the parser (**mutation:** remove the cap, and the oversized-body test fails);
  - the timeout fires at 8 s with a fake clock;
  - one retry, and only for transient reasons;
  - no log line contains the password, a hash or a classification (asserted over captured `console` output).
- [ ] Credentials go in a `Basic` header, over `https:` only, and are never logged (rev-3 §11.5).

### US4: Schema

**Files:** extend `0027_media_original_hashes.sql` (Task 12) with §4.2's columns, §6.6's table and §4.4's two tables;
test `apps/api/test/media-scan-schema.db.test.ts`.

**Cases:**
- the CHECKs accept lowercase hex of the right length and reject other values;
- existing rows stay NULL;
- `upload_scan_outcomes` has exactly the pinned column list: no user id, hash or classification (I12);
- `media_scan_backfill.status` accepts only its five values.

### US5: #114 amendments (§5.2–§5.6)

**Files:** the #114 task files named in §5.6. Tests are added to `csam-intake.test.ts`, `csam-drain.test.ts`,
`csam-review.test.ts`, `admin-csam-route.test.ts` and `media-restricted-route.test.ts`:
- **`runUploadIntake`, open:**
  - the case, the evidence file with `uploader_id`, the evidence hold, the account hold, and the report with
    `viewed_by_esp = false`;
  - **no** bar (`disabled_at` unchanged; AC-C14);
  - no move or purge when there are no serving keys.
- **Already-public copies (I1):** a clean earlier upload of the same bytes (same `original_sha256`), and a pre-scan
  upload whose WebP key matches. Both are held, their posts hidden, their objects moved to `MEDIA_RESTRICTED`, and
  their uploaders hold-and-reported under R3, all in the **same** case.
- **Disposition and re-upload (I2):**
  - the same account uploading again → an attempt row and a re-armed alarm, no new case, no new report;
  - a different account → its own report and hold, in the same case;
  - a re-upload of bytes whose case was opened from a Cloudflare match on the WebP key → joins that case. No
    duplicate case.
- **The cleared branch (I3):**
  - only a cleared case for the SHA → 422, an attempt row, no HMS-A call, no new case or report;
  - a live case and a cleared case both present → the live one is chosen;
  - **mutation:** re-add `AND f.cleared_at IS NULL`, and the cleared-only case reaches HMS-A, so the test fails.
- **Order (I4):**
  - `beforeCommit` throws → no object in `MEDIA_RESTRICTED`, no case, no hold;
  - after commit, with both puts stubbed to fail → the case file and hold exist, there is no object, and U5 raises on
    the daily check;
  - two concurrent uploads of the same bytes make one case and, for the same account, one attempt row.
- **Evidence states (N2, §5.7):**
  - each transition in §5.7's table, by the actor it names, and no other. A `present` file whose object is deleted
    becomes `missing` on the daily check, with an immediate U5; the drain's own failed `head` holds the report but
    changes no state. A `missing` file is released only by two admins (`file_without_evidence`, then the drain
    submits) or by a re-upload of the same bytes (`present`). **Mutation:** drop `missing` from the two-admin route's
    accepted states, and the "missing file released by two admins" case fails;
  - with the put stubbed to fail three times → `failed`, an immediate U5 email, the 422, and the report row exists
    but the drain makes **no** NCMEC call (the double sees nothing). **Mutation:** drop the drain's evidence check,
    and the double receives a `submit`, so the test fails;
  - a `pending` file older than 10 minutes → `failed` on the tick;
  - a re-upload of the same bytes repairs a `failed` or `missing` file → `present`, and the drain then submits; on a
    `file_without_evidence` file it also becomes `present`, and an already-sent report is not re-sent;
  - `file_without_evidence` after two hands → the drain submits without that file;
  - `reportMaySubmit` and `reportFileDisposition` over every state.
- **The daily check (N6):** a destroyed case (with the `csam_evidence_destroyed` row) is skipped and raises nothing.
  An old file whose report is `finished` is not `head`ed. A recent file with a missing object becomes `missing` and
  raises U5.
- **M3:** a `known_hash` upload match joining an undecided classifier case raises it to `urgent`, and gives this
  uploader a hold and a report.
- **M4:** an intake transaction that fails answers 503 and leaves no case or object.
- **M5:** with `toWebp` stubbed to fail on the match path, the case has `serving_lookup_incomplete = true` and U10
  raises.
- **Drain:** `publiclyAvailable = false` and no web page for an evidence file.
- **The web proxy page (N4):** `apps/web/src/pages/admin/csam-file/[caseFileId].ts`, with §5.6 Task 10's tests: the
  guard first; the three headers set on the response even when upstream omits them; and the CSP mutation.
- **Task 9's tests in §5.6:** reveal and fetch of an evidence file under two hands, CONFIRM of an upload-time
  classifier case (terminate plus a report), and the CLEAR of an upload-time case.

### US6: Route integration

**Files to modify:**
- `apps/api/src/routes/media.ts`: steps 6a–6e, the header's order list at `:10-24`, and `anim: false` in `toWebp`
  via `images.ts:164`;
- `packages/shared/src/errors.ts`: `IMAGE_NOT_ACCEPTED` and `IMAGE_UNSCANNABLE`;
- `apps/web/src/scripts/media-upload.ts`: show `message` for those two codes and for the 503;
- `apps/web/src/pages/media-upload.ts`: copy `Retry-After` through (M6);
- `apps/api/src/worker-configuration.d.ts`: hand-added lines for the six secrets of §8, the file's pattern at
  `:20-25`;
- `apps/api/vitest.config.ts`: test bindings with `example.test` hosts and fake values;
- the status endpoint and page (§8.2): `GET /admin/upload-scan/status` in `apps/api/src/routes/admin-upload-scan.ts`,
  `apps/web/src/pages/admin/upload-scan.astro`, the banner lines, and the `*/2` state log line.

Tests are appended to `apps/api/test/media.test.ts`.
- [ ] **Failing tests:**
  - §9.4's route tests and its five mutations, all through `FakeImageDecoder` and the mock HMS-A;
  - flag off → 503 and no HMS-A call;
  - the fallback flag off and a low-quality frame → 422 `IMAGE_UNSCANNABLE` and no media-endpoint call;
  - the fallback flag on → one media-endpoint call and a U8 outcome row;
  - no fresh self-test → 503 and no decode call;
  - the status endpoint: each boolean follows its secret; the response body contains **no** secret value (assert that
    the fake password, username and base URL strings are absent); a non-admin gets 404. **Mutation:** return the
    config object instead of the booleans, and the "no secret value" test fails.
- [ ] Existing tests keep passing, with the fake decoder registered for their fixtures and the mock answering clean.
- [ ] **Merge timing is the PM's:** merging blocks image uploads until the flag and secrets are set (§8.1).

### US7: Alarms U1–U11

**Files:** `apps/api/src/csam/alarms.ts` (#114 Task 8), and `csam_condition_marks`; test `csam-alarms.test.ts`.
- Each condition fires, and does not fire with its condition removed, with a clock passed to the tick (AC-C4's
  pattern).
- First-raise emails for condition-level alarms happen once per raise.
- No email or log line carries Match Data (AC-C23's assertion, extended).

### US8: Backfill (§4.4)

**Files:** `apps/api/src/media/backfill-scan.ts`, and an `index.ts` `*/2` branch beside `runMediaBackfillBatch`
(`index.ts:90-92`); test `apps/api/test/backfill-scan.test.ts`.

**Cases:**
- the cursor advances past matched, failed, unscannable and animated keys;
- **termination:** with every key permanently failing, the sweep still reaches `target_id` and sets `completed_at`;
  **mutation:** advance the cursor only on clean, and the termination test times out against its tick budget;
- rows after `target_id` are untouched;
- the retry pass takes at most 5 keys and only due ones;
- an animated WebP becomes `needs_review` and is never decoded;
- a match goes to `runIntake` with `source = 'self_scan'`.

### US9: Rollout (after registration)

1. The operator sets the six secrets of §8 (`wrangler secret put`; the values are never in the repo or a PR).
2. §11.2 item 4's positive controls, with their evidence in the PR.
3. The `docs/legal` edits of §10.3, with the mandated sentence inserted from the private copy.
4. The runbook (`docs/runbooks/csam.md`, created by #114 Task 11) gains:
   - what U1–U11 mean, and who acts on each;
   - how to rotate the `HMS_A_*` secrets, and triggering the self-test after every secret change (§3.6);
   - the post-deploy self-test step, and the broken-self-test recovery: rollback or fix-forward, never a bypass
     (§3.6);
   - the backfill review procedure (§4.4);
   - the HMS-A incident steps (rev-3 §11.9).
5. The whole-branch vendor grep, with the PM's private pattern plus this spec's pattern (§16).

---

## 14. Decisions needed

| # | Question | Default here | Who |
|---|---|---|---|
| D1 | Q3: does an HMS-A near match on known CSAM count as a known-hash match (reported at match)? | yes (§4.3) | CireSnave |
| D2 | Q4: flatten animated images at upload (`anim: false`)? | yes (§4.1) | CireSnave |
| D3 | Before registration: block image uploads, or allow them unscanned? | block (§8.1) | CireSnave |
| D4 | The fallback, when its flag is on, sends the file as uploaded (metadata included), or a stripped re-encode? | as uploaded, disclosed (§10.1) | CireSnave |
| D5 | Is the harmful-or-abusive category rejected at upload as a review-first case, using the `classifier` kind? | yes (§5.4) | PM |
| D6 | Re-upload of a file whose only case was **cleared** by two admins: refuse or publish? | refuse (§5.5) | CireSnave |
| D7 | Images transformations: the Images Paid plan, or a written volume ceiling under 5,000 a month (two per upload)? | decide before launch (§3.3) | CireSnave |
| D8 | `HMS_A_BASE_URL` as a secret, not a committed var? | secret (§8) | PM |
| D9 | Scan after the quota check, so refused bytes aren't scanned? | yes (§1.2) | PM |
| D10 | Add an `upload_scan_fault` signal to the security-alert seam, or use the CSAM surfaces only? | CSAM only (§6.4) | PM |
| D11 | Re-check stored PDQ hashes when HMS-A's list version changes (an after-the-fact check)? | out of scope (§0.3) | CireSnave |
| D12 | Does the board-126 ruling (§0.1) release the #114 plan's Task 12 gate? | US4 waits until the PM says so | PM |
| D13 | A low-quality image with the fallback off: refuse with 422 `IMAGE_UNSCANNABLE` ("try a different image"), or the 503? | the 422: a 503 would invite retries that can never succeed (§6.1) | PM |
| D14 | Every held-key refusal (any category) answers the neutral 422, removing the category oracle? | yes (§5.1) | PM |
| D15 | The PhotoDNA scan step's switch named `SECOND_SCAN_STEP_ENABLED`? | yes (§7) | PM |
| D16 | A known-hash upload match on a file whose live case is an undecided review-first case: report this uploader at match and raise the case to urgent (departing from rev-3 §3.6's "suppress")? | yes (§5.3 (a), M3) | CireSnave |
| D17 | A report whose evidence write failed: hold it until the bytes arrive or two admins file without them, or file at once without the file? | hold, with an immediate alarm (§5.7) | CireSnave |

---

## 15. Sources (fetched 2026-10-07)

- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Images binding: <https://developers.cloudflare.com/images/transform-images/bindings/>
- Images pricing: <https://developers.cloudflare.com/images/pricing/>
- Images transform options (EXIF rotation, `rotate`, `flip`, `metadata`):
  <https://developers.cloudflare.com/images/transform-images/transform-via-url/>
- PDQ README: <https://raw.githubusercontent.com/facebook/ThreatExchange/main/pdq/README.md>
- PDQ C++ I/O (the 512 downsample, the dihedral entry point):
  <https://raw.githubusercontent.com/facebook/ThreatExchange/main/pdq/cpp/io/pdqio.cpp>
- PDQ median routine (public domain): <https://raw.githubusercontent.com/facebook/ThreatExchange/main/pdq/cpp/hashing/torben.cpp>
- PDQ WASM README: <https://github.com/facebook/ThreatExchange/tree/main/pdq/wasm>
- ThreatExchange licence: <https://raw.githubusercontent.com/facebook/ThreatExchange/main/LICENSE>
- HMS-A's documents: held privately (ruling B).
- Statute text: the rev-3 spec §0's quotation (govinfo, 2024 edition, read 2026-10-06).

## 16. Checks run on this document

- **TypeScript:** every `ts` block above was copied by script into a scratch project outside `C:\Projects` and checked
  with TypeScript 6.0.3 under `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `noImplicitReturns`. The two blocks that import `SniffedFormat` resolved it against a copy of the real `sniff.ts`.
  The result and its positive controls are recorded in this branch's commit message.
- **Vendor names:** `git grep -n -i -E` with the pattern the brief gave over this file found 0 hits; the same command
  found a hit in a control string first. The output is recorded in this branch's commit message.

## 17. Audit findings and fixes (revision 1)

| Finding | PM ruling | Fixed in |
|---|---|---|
| C1 upload-time cases unconfirmable; no uploader recorded | uploader id at match, in the report's transaction; reveal extended to evidence keys under two admins with an audit row; CONFIRM terminates and reports via #114 | §5.2; §5.3 (`uploader_id` written in the transaction); §5.6 Task 3 (columns), Task 9 (reveal on the file's `r2_key`, `handleGetCaseFileMedia`, `grantIsUsable`, CONFIRM and CLEAR uploader set, tests and a mutation); US5 |
| C2 the test pool can't produce `rgb` or honour `anim` | an injectable `ImageDecoder`; a pure-TS fake in tests; the binding proven only by the spike and a post-deploy smoke | §3.3 (the interface, the fake, the "never by local vitest" statement); §3.6 (the deployed self-test); §2.4; US2 and US6 rewritten; §9.4 mutation 3 rewritten |
| C3 EXIF orientation corrupts the hash | deterministic orientation; validate geometry; fail closed; dihedral hashes as a design option | §3.5 (Cloudflare always rotates, cited; fixed 512 × 512 geometry for every input; `hasExpectedGeometry`; a mismatch → 503; 8 dihedral hashes; the implementer check in US3); C3 fixtures in §2.4; §9.4 mutation 4 |
| I1 public copies of matched bytes not quarantined | find them by original bytes or SHA, through the existing pipeline | §5.3 step 1 and branches (a) and (b) (rev-3 §3.3 steps 3–8 for serving keys); C7; US5 test |
| I2 duplicate cases on re-upload | follow rev-3 §3.7 exactly; no duplicate cases | §5.3 branch (a) (one uploader set; join, never duplicate); §5.5 (lookup covers serving keys); US5 tests |
| I3 cleared branch unreachable | fix the SQL and test it | §5.5 (filter removed, live first); §5.6 Task 3 (non-partial index); US5 test with a mutation |
| I4 orphaned evidence | evidence never orphaned without a hold | §5.3 (hold and case committed first; the object written after commit; no object on a transaction failure; the daily `head` check, U5); US5 tests; §9.4 mutation 5 |
| I5 the bytes fallback could fire silently for every upload | off unless its own flag; every use logs and alerts; never for every upload | §6.3; §6.1 (a decode failure is 503); U8; §10.1 |
| I6 stored animated media unscanned | scan every frame or flag for review; pick and say why | §4.4: flagged for review, with the reason; launch blocker 5 |
| I7 the backfill never terminates | cursor-based, guaranteed to terminate | §4.4 (a cursor, a fixed `target_id`, per-key status, a separate bounded retry); US8 termination test with a mutation |
| I8 contradiction with rev-3 §11.1 | resolve it; say which wins and why | §6.5; rev-3 §11.1 amended in this commit |
| I9 false resize justification; corpus can't measure recall | drop the justification; a hash-fidelity spike criterion on a public non-abusive corpus | §3.1 ("matches the size, not the pixels"); §3.4 (C6, Meta's ≤ 10, pass and fail); §2.3; §9 |
| I10 `torben.cpp` misattributed; port scope incomplete | credit it as public domain with its own notice | §3.7; US1 file list |
| I11 privacy §1 "EXIF stripped" becomes false | update the claim | §10.3 §1 replacement bullet; §10.2 |
| I12 outcome rows copy Match Data | reference the case id only | §6.6 (`scanned`/`unavailable` plus `case_id`); US4 test |
| M1 grep counts | — | §6.4 (1 comment hit for `ncmec`; `postmarkSend` in 9 files) |
| M2 `original_sha256` re-added | — | §4.2 SQL |
| M3 `SniffedFormat` redeclared | — | §3.3 and §5.3 blocks import it |
| M4 "no known match" with exact or near returned clean | — | §6.2 `verdictFromAnswer`; US3 test |
| M5 `http:` base URL accepted | — | §8 `uploadScanConfig`; US3 test |
| M6 `Retry-After` dropped by the proxy | — | §6.1; US6 file list |
| M7 "staging", and a test hook in production | — | §11.2 item 4 (the operator's script; the suite; the self-test) |
| M8 how vars are set | — | §8 (secrets, with the 2a plan's `--var` pattern cited and why it doesn't fit a flag) |
| M9 condition-level alarms have no `ref` | — | §5.6 Task 3 `csam_condition_marks`; §11.1 |
| M10 the earlier switch identifier named after the PhotoDNA scan step | — | §7 `SECOND_SCAN_STEP_ENABLED`; D15 |
| M11 422/415 category oracle | — | §5.1; D14 |
| M12 legal wording | — | §12 (readings, not conclusions; the notice point limited to the quoted text; the missing-evidence path) |
| M13 `listVersion` never stored; index name | — | §4.2 `scan_list_version`, `media_original_sha256_idx` and its reader |
| M14 how "production" is known | — | §11.1: event-based conditions; U3 counts refused uploads |

**Revision 2 (the re-audit of `edcb522`):**

| Finding | PM ruling | Fixed in |
|---|---|---|
| N1 `strongest` discarded a match when another variant was unavailable | a match on any variant outranks everything; add the test | §6.2 `strongest` (match 3/2 > unavailable 1 > clean 0) and the paragraph after it; §3.5; US3 test and mutation |
| N2 evidence lost after commit, with the report still drained | `pending` in the committing transaction; a bounded inline retry; then `failed` with an immediate alarm and the neutral rejection; the drain never submits without the evidence or a two-admin decision; legal uncertainty flagged; states and transitions stated | §5.3 step 4 and "Failures"; §5.7 (states, transitions, drain rule, the legal flag, `reportMaySubmit`); §5.6 Tasks 3, 7 and 9; §12; D17; US5 tests and a mutation |
| N3 the self-test failed open and covered one format | fail closed without a fresh result; define fresh; the deploy triggers a run; four synthetic fixtures; no HMS-A call | §3.6 (the four fixtures, `upload_scan_selftests`, `selfTestIsFresh`/`selfTestDue`, the `*/2` trigger after a deploy); §1.2 step 6c; §6.1; U9; US2 tests and a mutation |
| N4 no browser path; a cloned proxy would drop the CSP | an admin page that proxies the route and keeps the sandbox CSP and no-store; cite the existing reveal page | §5.6 Task 9 "The browser path": **no existing page displays held media** (`media-access.astro` only requests and approves; the only proxy is the author's `pages/api/media-restricted.ts`; 0 hits for `sandbox` and `grantId` in `apps/web/src`), so the new `admin/csam-file/[caseFileId].ts` reuses `media-access.astro`'s guard and `markPrivate` and `pages/api/media-restricted.ts`'s binary passthrough, and **sets** the headers; Task 10 amended; US5 tests |
| N5 secrets can't be read back | an admin status endpoint and page, booleans only, plus the self-test's freshness; launch blocker 1 and the privacy clause verified against it | §8.2; §10.3 §9; §11.2 item 1; US6 tests and a mutation |
| N6 U5 alarmed forever on destroyed cases | exclude them by reading the destruction audit row | §5.7 "The daily evidence check" (the `csam_evidence_destroyed` row, now with `subject_label = 'csam_case:<id>'`, §5.6 Task 9b; `destruction_started_at`; bounded to recent or unfinished files); US5 test |
| Rev-3 consistency (round-2 M1) | amend the six stale passages in the same commit | rev-3 §3.3 steps 3 and 5, §3.7, §5.2's table and P7 step 2, §8, §11.5 |
| M2 U6 keyed by a text key in a uuid column | — | §4.4 `media_scan_backfill.id`; §5.6 Task 3 (conditions 105, 106); §11.1 |
| M3 known-hash joining an undecided classifier case files nothing | — | §5.3 (a); D16; US5 test |
| M4 a failed intake transaction answered 422 and left no trace | — | §5.3 "Failures" (503); §6.1; US5 test |
| M5 a skipped WebP lookup was silent | — | §5.3 step 1 (`serving_lookup_incomplete`); U10; US5 test |
| M6 the low-quality refusal rate is unmeasured | — | C8 in §2.3 and §2.4 |
| M7 U9's mark and the alarm tick could fight | — | §3.6 and §11.1: only the alarm tick writes mark tables |
| M8 `fillFloatLumaFromRGB`'s location | — | §3.7 and US1: `downscaling.cpp:82` |
| M9 the old identifier in §17 | — | the M10 row above no longer spells it |

**Revision 3 (the third audit, of `9684a1a`):**

| Finding | PM ruling | Fixed in |
|---|---|---|
| (a)1 the gate could read an old pass after a failed run | read the current version's newest run, whatever its result; a failed newest run closes uploads at once; test it | §3.6 (what the gate reads, "fresh", `selfTestIsFresh`/`selfTestDue` take `newestRun`, and a failure is retried every tick); §6.1; US2 test (pass at T, fail at T + 1 h, upload at T + 1 h + 1 s → 503) and a mutation |
| (a)2 a `present` file whose object vanished held its report forever | the daily check moves it to `missing` with an immediate alarm; `missing` takes the two-admin path | §5.7 (state table with the actor for each transition; `missing`; the drain's `head` only holds); §5.3 (a); §5.6 Tasks 3 and 9; U5; `EvidenceState`; US5 tests and a mutation |
| (a)3 U10 had no acknowledgement | an admin acknowledgement action with an audit row clears it; launch blocker 6 is met by it | §5.6 Task 3 (columns, the action kind) and Task 9 (the route, tests); U10; §11.2 item 6 |
| (b)1 no recovery for a broken self-test | no break-glass; rollback to the previous version or fix-forward; uploads stay blocked | §3.6 "Recovery when the self-test itself is broken"; US9 runbook item |
| (b)2 a secret change reopens the 503 window | accepted; the implementer verifies it | §3.6 "A secret change"; US9 runbook item |
| (c)1 how the request sends U5 without writing marks | — | §5.3 step 4 and §11.1 (`evidence_alarm_sent_at`; the tick skips a sent email) |
| (c)2 identical bytes arriving after `file_without_evidence` were dropped | — | §5.3 (a); §5.7 (`file_without_evidence` → `present`, preservation only); US5 test |
| (c)3 the commit message matched the vendor pattern | — | the commit message now describes the check without spelling the pattern |

**Revision 4 material (2026-10-08, PROPOSAL; not an audit):** PM rulings recorded in `2026-10-08-vps-image-service-design.md`.

| Change | PM ruling | Applied in |
|---|---|---|
| the decoder is a stateless VPS service, not the Images binding; no fallback decoder | all three transforms move to one endpoint, fail closed | Status line; §2.3 and §3.3 notes; §6.1 rows |
| alarm for decoder build/policy drift or a bad response signature | U11 approved | §11.1 (U11 and its mark), §11.2 item 6, US7 |
| a VPS credential refusal has its own record | `decoder_credentials_refused` approved, as a `reason` value, no CHECK change | §6.1, §6.6 |

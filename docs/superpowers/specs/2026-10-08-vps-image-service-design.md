# D7 (stateless ImageMagick VPS decoder) and D11 (post-launch recheck) — design

**Status:** Revision 3, 2026-10-08, PROPOSAL. Two spike passes have been run, both on Docker Desktop / WSL2 and **neither on the VPS**: pass 1 (hash fidelity, policy, no-disk) in `../spikes/2026-10-08-imagemagick-pdq-spike.md` and pass 2 (a real systemd unit, no-disk proof on the unit, logging proof, C7, C8, a cloudflared quick tunnel, local latency) in `../spikes/2026-10-08-imagemagick-systemd-spike-pass-2.md` (together "the spikes"). They are **not a pass of the whole design.** Done with limits: C7 for the ImageMagick pipeline, C8 measured on 91 hand-picked content-rich real images (flat-heavy images unmeasured), systemd directives, a quick tunnel. Still open: the TS-port leg of C5/C6 (no port exists yet), C7 for the Cloudflare Images encoder, in-process (MagickWand) blob reads, non-sRGB ICC / HEIC / TIFF input, SEGV-no-core, and every result on the VPS host itself. Docs only. Part of #114.
**Amends:** `2026-10-07-upload-scan-design.md` (revision 3). Its amendments are listed in section 8 below.
**Revision 2** replaces the assumed pipeline and `policy.xml` of revision 1 with the ones the spike proved, and adds the hard rules the spike found (sections 3.1, 3.2). **Revision 3** adds the pass-2 findings: unit hardening corrections as design rules (section 3.2), the owner's 13-item checklist (section 3.3, NOT YET BOARDED), the ICC-warning decision and the C8 launch question (section 7). Two contract decisions were APPROVED by the PM on 2026-10-08 after the pass-1 spike: `-alpha off` for the scan frame, and native-size frames for small images (section 2.3).

## Rulings

CireSnave, 2026-10-08, relayed verbatim by the PM (board 137):

> "Get the D11 recheck on the roadmap so we get the recheck built.  You're right that it shouldn't hold launch but needs to exist.  Lets go with using ImageMagick on my VPS to do image conversions.  I don't think we need to worry about my VPS holding potentially illegal child imagery so long as it receives an image, checks it, and returns the result without storing it on the VPS's drive.  If we work it that way, it is part of a system used by our services as a whole and our services already have the mechanism in place to catch and report bad images.  For rechecks that aren't performed on our system, we don't need to worry about a diff...I was only talking about a diff as an optimization for checks we run ourselves.  We will eventually expand to multiple VPSs or some sort of cloud service to replace the parts that currently run on my VPS so we don't need to worry about outages."

PM rulings, 2026-10-08:

1. All three transforms (the header and pixel-bound check, the raw scan frame, and `toWebp`) move to ONE stateless
   VPS endpoint. There is no fallback decoder: the service fails closed.
2. Cloudflare Tunnel, application-level HMAC, and a Cloudflare Access service token are approved (sections 2.1 and 2.2).
3. New alarm U11 is approved (section 2.6).
4. A separate `decoder_credentials_refused` outcome is approved (section 2.6).
5. The D11 roadmap text already lives in `PORTFOLIO-ROADMAP.md`, which the PM owns. Section 6 points to it and does not
   repeat it.
6. Section 3.3 (what CireSnave must set up on the VPS) is NOT YET BOARDED. The PM boards it only after a second spike pass.

PM rulings on the spike, 2026-10-08:

7. Alpha: `-alpha off` for the scan frame is APPROVED. The stored WebP is a separate transform.
8. Small images: native size for images with both sides <= 512 (no upscale) is APPROVED. The scan-frame contract becomes variable
   width and height, with explicit dimensions in the signed response header (section 2.3).
9. The spike's pipeline is approved. "Point first" (revision 1) is **withdrawn**.
10. The hardening findings are DESIGN RULES, not suggestions (section 3.1): seekable stdin only; any non-empty stderr is failure;
    time limits through `MAGICK_TIME_LIMIT` / `-limit time`; `LimitCORE=0`; swap off for tmpfs files.
11. The design stays a PROPOSAL pending a second pass (section 3.3). Nothing in that list is claimed to pass.

Labels used below: **READ** = seen in the files named under it; **INFERRED** = reasoning; **UNVERIFIED** = needs the
spike or CireSnave. Unverified items stay unverified until the spike reports.

Read at `origin/main` (fetched 2026-10-08): `docs/superpowers/specs/2026-10-07-upload-scan-design.md` ("spec", rev 3),
`2026-10-04-csam-self-scanning-options.md` ("options doc"), `apps/api/src/media/images.ts`, `apps/api/src/routes/media.ts`.
Provider = HMS-A only.

## 0. Facts that shape the design (READ)

- Today the Images binding is used in exactly two places: `.info()` (`images.ts:119-128`, called `media.ts:142` and `:237`)
  and `toWebp` (`images.ts:155-180`, called `media.ts:188`; 2048 edge, `scale-down`, q82, `.input()` hard cap 20 MB vs our
  `MAX_UPLOAD_BYTES` 15 MB at `media.ts:55`). `wrangler.jsonc:64` is `"images": {"binding":"IMAGES"}`.
- The scan decode (`ImagesBindingDecoder`, `rgb` output, spec §3.3) is **design only, not built** (US2 not done; spec is docs
  only). So nothing scan-related has to be torn out; D7's "two transformations per upload" cost (spec §3.3) never starts.
- The spec's whole decoder risk list (rgb unsupported locally, `9422` allowance error shape, EXIF rotation can't be
  disabled, no frame selector, resampler != reference) exists because Cloudflare's decoder is a black box. ImageMagick
  (IM) on our box gives us every one of those as an explicit option. That is the real upside of D7, beyond cost.
- Inline-scan flow and order: spec §1.2. Fail-closed 503 table: §6.1. Alarms: §11.1. Self-test gate: §3.6.
- Windows dev box (checked just now): `docker` present, WSL has Alpine + docker-desktop, `strace` exists only inside Linux,
  **no `magick`**, and `convert` on PATH is Windows' NTFS `convert.exe`, NOT ImageMagick (trap: never call bare `convert`).

---

## 1. Recommendation: what moves

**Move all three to one VPS endpoint: header inspection (`.info()` equivalent + pixel bound), the raw scan frame (512x512, or native size when both sides are <= 512, section 2.3),
and the WebP conversion. One request, one upload of the bytes, one decode pass, three outputs.**

Why one call rather than "scan decode only" or "toWebp only":

| Option | Verdict | Reason |
|---|---|---|
| A. Scan decode + toWebp + info all on VPS, one round trip (**recommended**) | yes | (1) Scan and store use the same decoder, same IM build, same policy: what we hash is what we store. With scan on VPS and toWebp on Cloudflare, two different decoders see the same hostile bytes and can disagree (frame choice, orientation, alpha, a polyglot parsed differently): a scan-vs-store differential. (2) Pays the 15 MB transfer once. (3) Retires the Images dependency entirely: no allowance error (`9422`, alarm U7), no D7 plan question, no Miniflare/sharp simulation gap for production behaviour. (4) Matches CireSnave's ruling ("ImageMagick on my VPS to do image conversions"). |
| B. Scan decode on VPS, toWebp stays on binding | no | Keeps the scan-vs-store differential; keeps Images billing (1 transform per upload) and the U7 alarm; pays the VPS round trip anyway. |
| C. toWebp on VPS, scan decode stays on binding | no | The binding's `rgb` output is unproven in production (spec C3) and costs a second transformation; the part of the design with the most unknowns stays. |

**Latency (INFERRED, to be measured):** added cost is one Worker->VPS round trip plus the body transfer. Typical post images
(1-4 MB) over a tunnel should add roughly 0.3-1.5 s; a 15 MB worst case is bounded by VPS ingress bandwidth (1.2 s at
100 Mbps) plus IM decode (~1-2 s for a 50 MP JPEG; PNG slower). The binding path had no network hop, so this is a real
regression in p50 but inside the spec's inline budget (spec §6.2 allows ~17 s wall for HMS-A; the Worker has no wall limit
while the client is connected, spec §2.2). Reorder to keep the cost on honest uploads only: sniff (Worker) -> **quota
(moved ahead of the decoder)** -> `/v1/process` -> everything after. The VPS rejects pixel bombs from the header before any
decode, so a hostile upload costs one transfer, not a decode. **Spike must record p50/p95/p99 end to end** (section 5).

**Cost (INFERRED):** marginal VPS CPU/RAM for IM (budget 2 concurrent decodes x ~300 MB); removes all per-transformation
Images charges and the monthly allowance risk. New cost: an availability dependency we operate (below).

**Failure modes introduced:** (1) VPS down => all image uploads 503 (text posts unaffected). The spec already accepts a
scanner outage stopping uploads (§2.3, §6.5); this adds a second such dependency. Mitigation is replaceability (section 2.6),
not a fallback decoder. (2) Version drift between replicas changes PDQ/WebP bytes: pin one container image digest. (3) VPS
compromise exposes uploaded images before moderation. Public-bound media, so low confidentiality loss, but integrity loss is
severe (a forged "clean" frame): hence signed responses (section 2.2).

**`.info()` on stored bytes (`media.ts:237`):** the VPS returns the WebP's width/height in the same response (IM already has
them), so the second `.info()` call disappears; `scaleDownTo` stays as the Worker-side fallback/cross-check.

**Animation (spec §4.1):** unchanged default (flatten, D2 still CireSnave's): `format:[0]` selects frame 0 for the scan frame
and the WebP, so the hashed frame is the stored frame. Upside: if Q4 ever rules "keep animation", IM can emit per-frame
512 raw pixels (capped, e.g. 64 frames), which removes the binding's "no frame selector" blocker (spec §4.1 second bullet).
Not building that now. **UNVERIFIED:** IM reading animated WebP needs libwebp demux; spike input 4 (section 5) must show it
reads frame 0 or fails cleanly (a clean failure = 503/415, acceptable; silent wrong frame = not).

**Existing Images-binding code path: remove, do not keep as a fallback.** Reasons: spec §6.1 is fail-closed and §3.6's
self-test fixtures encode ONE decoder's expected hashes; a runtime failover to a different decoder would produce PDQ values
the self-test never vouched for (C6 tolerance is per-decoder evidence). Sequence: (1) introduce a `MediaProcessor` seam in
`images.ts` (info + scan frame + webp) with `VpsMediaProcessor` and the test fake (the spec's `ImageDecoder` seam,
§3.3, folds into it); (2) cutover PR switches `media.ts:142/188/237`; (3) follow-up PR deletes `inspectImage`/`toWebp`
binding code and the `images` binding from `wrangler.jsonc`. Keep the pure helpers (`hasDimensions`, `exceedsPixelBound`,
`scaleDownTo`, `MAX_PIXELS`) but stop importing the binding's `ImageInfoResponse` type: define our own. If CireSnave wants a
standby decoder later it must be a **second IM service** (section 2.6), never a different library.

---

## 2. Interface contract

### 2.1 Routing: Cloudflare Tunnel (recommended) vs public IP

| | Cloudflare Tunnel (`cloudflared` on VPS, outbound-only) | Public IP |
|---|---|---|
| Exposure | VPS opens no inbound port; origin IP hidden | open port, internet scanners, needs firewall + TLS cert management |
| Replacement | run a second `cloudflared` replica of the same tunnel on VPS #2, or point the hostname at a cloud service; Worker config unchanged (INFERRED from Cloudflare's tunnel replica model) | new DNS/LB layer to build |
| Risk | extra hop and one more component; **UNVERIFIED** whether `cloudflared` spools request bodies to disk (must be tested by section 4's proof, it is in the byte path) | direct path, fewer parts |

Recommend Tunnel, hostname `decode.<our zone>` reached by a plain `fetch()` from the api Worker. Put a Cloudflare Access
service-token policy on it as an *outer* gate (cheap, filters scanners); it is not the security boundary (a bearer secret).

### 2.2 Auth: pick application-level HMAC (not mTLS)

Pick **HMAC-SHA256 request signing with timestamp + nonce + body hash, plus a signed response.** Reasons: (1) independent of
transport, so it survives any replacement (second VPS, tunnel replica, cloud function) with no cert lifecycle; (2) the
Worker already computes the SHA-256 of the body for step 6a (spec §1.2), so binding the signature to the body hash is free;
(3) mTLS from a Worker needs the `mtls_certificates` binding and a CA/rotation process we would have to run, and gives
nothing about *response* integrity at the application level. Costs: a shared secret in two places (Worker secret
`DECODER_HMAC_KEY_<kid>`, VPS env file mode 0400).

- Request headers: `X-TJ-Kid`, `X-TJ-Ts` (unix s), `X-TJ-Nonce` (16 random bytes b64url), `X-TJ-Body-Sha256`, `X-TJ-Sig` =
  HMAC-SHA256(key, `"POST\n/v1/process\n"+ts+"\n"+nonce+"\n"+bodySha256+"\n"+params-canonical`).
- Service: reject if |now-ts| > 60 s, nonce seen (in-memory LRU 5 min; a restart empties it: replay then only wastes CPU,
  the response goes to the replayer, who must know the 15 MB body; INFERRED acceptable), kid unknown, or the SHA-256 of the
  received body != header (computed before IM is spawned). Constant-time compare.
- **Response is signed** (`X-TJ-Resp-Sig` over request nonce + status + SHA-256 of each part). Without it an impostor or
  hijacked origin returning a plausible frame defeats the scan silently. Worker verifies before using any part; failure =
  `unavailable` (503), alarm U1 plus U11 (below).
- Two kids accepted at once for rotation. Secrets never logged.

### 2.3 Endpoints

`POST /v1/process` (HMAC). Body: raw original bytes (no multipart: multipart parsers spool to disk, section 3). Params as
signed headers: `X-TJ-Format` (Worker's sniff: jpeg|png|gif|webp; service re-sniffs magic bytes itself and returns
`invalid_image` on mismatch), `X-TJ-Max-Pixels` (50,000,000), `X-TJ-Max-Edge` (2048), `X-TJ-Webp-Quality` (82).

200 response, `application/octet-stream`, one framed body (no multipart): `u32be headerLen | header JSON | rgb | webp`.
Header JSON: `{ v:1, decoder:{build_id, magick_version, delegates:{jpeg,png,webp,gif}, policy_sha256},
info:{format,width,height,frames,animated}, stored:{width,height}, frame:{width,height}, rgb_len:N, webp_len:N, orientation_applied_to_webp:true }`.
Worker checks `rgb_len === frame.width*frame.height*3`, that `frame` matches the reference rule (it is exactly 512x512 when `info.width > 512 || info.height > 512`, and otherwise equals `info.width` x `info.height`, never upscaled; decision (b) below), that `frame` is carried in the signed header so the signature covers it, and that the dimensions are within bounds, `webp_len > 0` (the existing zero-byte guard, `images.ts:175`), the pixel bound (keep `exceedsPixelBound`, `images.ts:75`), and `decoder.build_id` + `policy_sha256` against an allowlist (section 2.5). The spec's `hasExpectedGeometry` (§3.3/§3.5) must be changed to this rule; its fixed 786,432-byte check no longer holds.

**Two contract decisions, APPROVED (PM, 2026-10-08)** (the spike measured both; see spike sections 4c, 4d):

- **(a) Alpha.** Use `-alpha off` for the scan frame, not flatten-on-white (approved). The reference ignores alpha, so `-alpha off` matches it exactly (d = 0 on both transparent fixtures), while flatten-on-white gave d = 52 and 54. The stored WebP's treatment of alpha is a separate product choice and is not decided here.
- **(b) Small images.** An image with both sides <= 512 is hashed by the reference at native size, and a forced 512x512 frame cost d = 12 to 16 (at the edge of the 16 bar). The approved rule is to emit the native-size frame for such images (no upscale), so the response frame has a **variable** width and height, carried explicitly in the signed response header (d = 0 on all 12 such fixtures). This replaces revision 1's fixed `rgb_len` of 786,432 bytes. The PDQ code (spec US1) must accept variable dimensions, and the decoder self-test (spec §3.6) must include one fixture of at most 512 on both sides and one larger than 512 on a side, and expect the right frame dimensions for each (native size, and exactly 512x512). Revision 1's fixed 512x512 frame is withdrawn.

Errors (JSON `{code}`): `invalid_image` (header unparseable/mismatch; **Worker -> existing 415**, `media.ts:77`),
`pixel_limit` (**-> existing 413**), `resource_limit` / `timeout` / `decode_error` after header parsed OK (**-> 503**, spec
§6.1 "decode failure, any kind"), `busy` (503 + `Retry-After`), `unauthorized` (**-> 503**, never shown to the user).
Anything non-JSON, non-2xx or unsigned -> 503. All Worker-visible user answers stay the spec's identical 415/413/503 bodies.

`GET /v1/health` (HMAC with empty body; also reachable by the tunnel's own probe via a separate unauthenticated
`/healthz` that returns only 200/503 and no build info). The authed health does a **real decode** of an embedded 1x1 PNG and
a policy self-check (`magick -list resource` must show `Disk: 0`, section 3.2), then returns `{ok, build_id, magick_version,
policy_sha256, uptime}`. 503 if any check fails, so a degraded box drops out of rotation.

### 2.4 Limits and timeouts

Body cap 15 MiB + 4 KiB (service-enforced while streaming, not trusting Content-Length). Response cap: rgb at most 786,432 bytes (512x512x3) + WebP
<= ~8 MiB (service aborts a larger WebP). Concurrency semaphore 2 (excess -> `busy`). IM time limit 10 s via `MAGICK_TIME_LIMIT` / `-limit time` (the policy `time` key is ignored, section 3.1); service hard
deadline 12 s (kills the process group); **Worker `AbortSignal.timeout(15_000)`**, no inline retry against the same
backend (a retry doubles a 15 MB upload), at most one attempt against a *second configured backend* if one exists.
Sits ahead of the spec's HMS-A budget (§6.2: 8 s + retry), so worst case wall time becomes ~15 s + ~17 s; CPU unaffected.

### 2.5 Replaceability behind the same interface

The contract above is the product; the VPS is one implementation. Worker config: `DECODER_BACKENDS` = ordered list of
`{id, url, kid}` (secret, like `HMS_A_BASE_URL`, spec D8). A second VPS/cloud service implements `/v1/process` + `/v1/health`
and runs the **same container image digest** (so PDQ and WebP bytes match; otherwise C7's determinism also differs per
replica). Selection rule: first backend whose newest self-test passed (below), in order; no passing backend = 503. No
"try anything that answers".

**Self-test generalised (spec §3.6):** key it on `(worker version_id, backend id, decoder build_id, policy_sha256)`, not only
`version_id`. Reason (INFERRED, important): the decoder can change without a Worker deploy (VPS upgrade), which the
current gate (`CF_VERSION_METADATA` version only) would not notice. Same four synthetic fixtures through `/v1/process`, **plus one fixture of at most 512 pixels on both sides and one larger than 512 on a side, each with its expected frame dimensions** (the native size for the first, exactly 512x512 for the second; the check fails on any other dimensions)
(no HMS-A call). **RECOMMENDED, PENDING CIRESNAVE:** one further fixture that triggers the ICC warning described in section 7 item 8 (a 16-bit PNG with an embedded ICC profile whose PCS illuminant is not D50), expecting the answer the PM chooses (under the recommendation, a 422 rejection), so that a change to the stderr rule is noticed and its false-reject rate is counted. The `*/2` tick may also record a `/v1/health` result as a selftest row so a VPS outage with zero upload
traffic still raises U9 within minutes rather than at the 23 h re-run.

### 2.6 Unreachable: fail closed and alarms (spec §6.1/§11.1 mapping)

- Unreachable, timeout, 5xx, bad/missing response signature, busy storm: upload gets the spec's 503 +
  `Retry-After: 120`; outcome `unavailable` -> **U1** (>=3 in 10 min, or all in 30 min). No decode, no storage, no
  fallback decoder, no bytes fallback (spec §6.3 covers only low quality PDQ, not decoder outage).
- No backend with a fresh passing self-test: 503 -> **U9** (immediate), exactly as for a drifted binding.
- Backend answers 401 (key mismatch/rotation error): 503 -> a new reason `decoder_credentials_refused` on an `unavailable` outcome (approved; no CHECK change, see section 8). Do not reuse U2
  (that is HMS-A credentials; mixing sends the on-call to the wrong provider).
- **New alarm U11 (approved by the PM, 2026-10-08):** "decoder identity drift": `build_id`/`policy_sha256` not on the
  allowlist, or a response signature failure. Immediate. It replaces U7 (Images allowance) which goes dead.
- Everything else about alarms: only the tick writes marks (spec §11.1 M7); the request path just records outcomes.

---

## 3. The service itself

### 3.1 Stateless design

- Small single-binary service (Go or Rust recommended: static, easy to strace; **UNVERIFIED preference**, CireSnave's call).
  Per request: read body into RAM (bounded), verify HMAC + body SHA-256, **sniff** magic bytes (jpeg/png/gif/webp only),
  run IM with **explicit coder prefixes** (`jpeg:-`, `png:-`, `gif:-[0]`, `webp:-[0]`) so IM never auto-detects a format
  (blocks SVG/MVG/MSL/PDF/`ephemeral:`/`label:`-style coder tricks), feed bytes on stdin, read outputs from pipes, return.
  No database, no cache, no queue, no disk writes, no state beyond the in-memory nonce set.
- Pipeline (single IM process, one decode; **proven by the spike** for the scan frame and for the single-pass form):
  scan frame, when either side is > 512:
  `magick <fmt>:fd:0[0 for gif/webp] -alpha off -colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 rgb:fd:1`
  scan frame, when both sides are <= 512 (report the width and height; PDQ runs at that size):
  `magick <fmt>:fd:0[0 for gif/webp] -alpha off -colorspace sRGB -depth 8 rgb:fd:1`
  No `-auto-orient` for the scan frame: the reference does not rotate, and with auto-orient on the best of the 8 dihedral hashes was only within 12 to 22 for flipped images (spike 4c). The stored WebP is auto-oriented always.
  Single pass (scan frame and WebP from one decode): the frame is written with `-write` inside parentheses (a bare `rgb:fd:3` inside parentheses is parsed as an input and fails). The scan-frame branch must come first so it is not auto-oriented. Pass 1 proved the parenthesised `-write rgb:fd:3` form (frame byte-identical to the separate-process frame). **Pass 2 ran the assembled single-pass pipeline through a hardened systemd unit**, with the stored-WebP options `-auto-orient -resize 2048x2048> -strip -quality 82 -define webp:method=4 -define webp:thread-level=0`, on all six unit inputs (200 each, p05 WebP 363,258 B, equal to pass 1) and on 65 inputs for C7 (byte-identical across runs). The assembled command line itself lives in the spike author's local test wrapper, not in this repo; the product's command must be re-verified against those same inputs. The fallback is two IM processes fed the same seekable input.
  **`-sample` with `sample:offset=0` is the resizer, not `-filter Point -resize`.** Revision 1 named Point as the first candidate; measured, Point is worse than Lanczos on real photos (max d 20 vs 10), while Sample0 has max d 8 on the same 27 photos. The reference's resampler is CImg nearest-neighbour: **verified** at the pinned commit (spike section 2). Revision 1's "forced 512x512 frame" is replaced by decision (b) in section 2.3.
- **Hard rules the spike found** (each is a DESIGN RULE, a requirement and not a suggestion):
  1. **IM must be given a SEEKABLE stdin**: a regular file or a **memfd**. With an anonymous pipe, IM copies the whole input to a `magick-XXXX` temp file before decoding (the likeliest spool, and it is in IM itself). Spike: pipe mode wrote the body to disk (75 trace violations, 85 inotify events); file and memfd modes had none. The service therefore writes the verified body into a memfd and passes that as fd 0. A regular file on tmpfs is allowed only with swap OFF on the host, because tmpfs pages can swap: `MemorySwapMax=0` and host swap disabled are part of the no-disk claim. A pipe is never allowed.
  2. **Treat ANY non-empty stderr as failure, and never trust the exit code.** IM exits 0 on time-limit-exceeded (and emits garbage) and exits 0 on a truncated JPEG with a full-length frame and `Premature end of JPEG file` on stderr; `-regard-warnings` did not change this. Cost: a benign input that merely warns (for example an odd iCCP chunk) becomes a 503. The six benign photos in the spike produced empty stderr.
  3. **Enforce time with `MAGICK_TIME_LIMIT` / `-limit time` plus the service's own deadline.** The policy `time` key is ignored (`-list resource` prints `Time: unlimited`).
  4. **`RLIMIT_FSIZE=0` on the IM child only, plus `LimitCORE=0`.** A process that exceeds `RLIMIT_FSIZE` gets SIGXFSZ, whose default action dumps core, so the core limit must be 0 as well: the unit sets `LimitCORE=0`. **Do NOT set `LimitFSIZE=0` on the unit**: RLIMIT_FSIZE applies to memfd files, so the wrapper's own write of the body into the memfd fails with EFBIG (pass 2). The unit keeps a finite `LimitFSIZE` (at least the body cap, for example 32 MiB), and the wrapper sets `RLIMIT_FSIZE=0` in the IM child's pre-exec step. This works under the seccomp filter because glibc uses `prlimit64`, which `@system-service` allows, even though `~@resources` blocks `setrlimit`.
  5. Do not rely on IM's error text to choose `pixel_limit` over `resource_limit`: an area limit and a memory limit give the same `cache resources exhausted` text. The service's header pre-check produces `pixel_limit`.
- Must not use anything that spools: no `multipart`/form parsers, no framework body buffering to temp files, no nginx or
  other proxy in front with default `client_body_buffer_size` (it writes bodies over the buffer to `/var/lib/nginx`).
  Terminate in the service (the tunnel connects straight to it) or set `proxy_request_buffering off`.
- Go: do not call `ParseMultipartForm`; Python: no `tempfile`-backed uploads; Node: no `formidable`/`multer`.

### 3.2 Hardening, exact list

**`policy.xml`** (installed read-only; `MAGICK_CONFIGURE_PATH=/etc/tj-decoder/magick` so no user/system override can win).
This is the **working** policy from the spike (`prod2.xml`, ImageMagick 7.1.1-43). **Revision 1's policy did not work**: every decode failed with `no decode delegate for this image format ''`, for two reasons: (1) `module rights="none" pattern="*"` blocks the module-built coders, fixed by an allow rule with **upper-case** coder names (lower-case names do not match); (2) `path rights="none" pattern="*"` blocks stdin `-` even with a later allow for `-`, in either order, fixed by allowing `fd:*` and feeding every input as `<coder>:fd:0`. Values below were validated on that version only; revalidate on any IM upgrade.

```xml
<policymap>
  <policy domain="resource" name="disk"   value="0"/>
  <policy domain="resource" name="memory" value="512MiB"/>
  <policy domain="resource" name="map"    value="0"/>
  <policy domain="resource" name="area"   value="128MP"/>
  <policy domain="resource" name="width"  value="16KP"/>
  <policy domain="resource" name="height" value="16KP"/>
  <policy domain="resource" name="time"   value="10"/>   <!-- IGNORED by IM; kept for documentation. Enforce with MAGICK_TIME_LIMIT -->
  <policy domain="resource" name="thread" value="2"/>
  <policy domain="resource" name="list-length" value="64"/>
  <policy domain="resource" name="file"   value="64"/>
  <policy domain="cache"  name="memory-map" value="anonymous"/>
  <policy domain="cache"  name="synchronize" value="false"/>
  <policy domain="system" name="shred"    value="0"/>
  <policy domain="coder"    rights="none"       pattern="*"/>
  <policy domain="coder"    rights="read|write" pattern="{JPEG,PNG,GIF,WEBP,RGB}"/>
  <policy domain="delegate" rights="none" pattern="*"/>
  <policy domain="filter"   rights="none" pattern="*"/>
  <policy domain="module"   rights="none" pattern="*"/>
  <policy domain="module"   rights="read|write" pattern="{JPEG,PNG,GIF,WEBP,RGB}"/>  <!-- upper-case names; lower-case do not match -->
  <policy domain="path"     rights="none" pattern="@*"/>
  <policy domain="path"     rights="none" pattern="*"/>
  <policy domain="path"     rights="read|write" pattern="fd:*"/>  <!-- input <coder>:fd:0, output rgb:fd:1 / rgb:fd:3 -->
</policymap>
```
Spike results for this policy: `-list resource` shows `Memory: 512MiB Map: 0B Disk: 0B`; a 50 MP decode fits in 512 MiB with `map 0` (peak RSS about 303 MB, 2.8 s for PNG); an over-memory decode errors (`cache resources exhausted`) and writes no temp file; reading by path, `@file`, `xc:` and `info:` are blocked.
Environment: `MAGICK_TEMPORARY_PATH=/nonexistent`, `TMPDIR=/nonexistent`, `HOME=/nonexistent`, `MAGICK_TIME_LIMIT=10`. Decoder
options pinned for determinism: `-define jpeg:dct-method=islow`, `-define webp:thread-level=0`; never `jpeg:size=` (scaled
decode changes pixels, only as a measured performance option).

**systemd unit** (VPS runs it; we ship the unit file in the repo). **Tested in pass 2 on systemd 257.13 (WSL2, not the VPS); `systemd-analyze security` exposure 0.5 SAFE, all six inputs pass, the proof suite (strace, inotify, read-only, marker) has 0 violations.** The shape is **socket-activated** (`ListenStream=127.0.0.1:<port>`, passed in as fd 3), which lets the service run with **`PrivateNetwork=yes` and `RestrictAddressFamilies=AF_UNIX`** and still accept requests. Revision 1's "`PrivateNetwork` not usable" is withdrawn, and the wrapper must adopt the passed-in fd instead of creating its own socket. Directives:
`DynamicUser=yes` (or a dedicated `User=tjdecode`, no shell, no home); `NoNewPrivileges=yes`; `CapabilityBoundingSet=` and `AmbientCapabilities=` empty; `ProtectSystem=strict`; `ProtectHome=yes`; `PrivateDevices=yes`; `ReadOnlyPaths=` the service directory; `InaccessiblePaths=/mnt /root /home /boot /srv /media`; `ProtectProc=invisible`; `ProcSubset=pid`; `ProtectKernelTunables/Modules/Logs=yes`; `ProtectControlGroups=yes`; `ProtectClock=yes`; `ProtectHostname=yes`; `RestrictNamespaces=yes`; `RestrictRealtime=yes`; `RestrictSUIDSGID=yes`; `LockPersonality=yes`; `MemoryDenyWriteExecute=yes` (works with the test wrapper, ImageMagick, libjpeg/libpng/libwebp and OpenMP; re-verify with the production service language); `SystemCallFilter=@system-service` with `~@privileged @resources @mount`; `SystemCallArchitectures=native`; `MemoryMax=2G`; `MemorySwapMax=0` (**the unit forbids swapping this service**; effective with 8 GiB of host swap present); `TasksMax=64`; `CPUQuota=200%`; `LogLevelMax=notice`; `UMask=0077`; `LimitCORE=0`; a finite `LimitFSIZE` (see rule 4 in section 3.1).
**Design rules from pass 2** (each is a requirement, not a suggestion):
1. **Nothing writable.** `PrivateTmp=yes` plus `ProtectSystem=strict` is NOT enough: `/tmp`, `/var/tmp` (disk-backed on the test box and on many VPS images), `/dev/shm` and `/run` stay writable. The unit must carry `TemporaryFileSystem=/tmp:ro /var:ro /var/tmp:ro /run:ro` and `InaccessiblePaths=/dev/shm` (tested: 6 of 6 inputs pass, 0 violations, 0 inotify events). `DynamicUser=yes` forces a private tmp even with `PrivateTmp=no`; the read-only `TemporaryFileSystem` overlay is what makes it read-only. `ReadWritePaths=` stays empty.
2. **RLIMIT_FSIZE=0 on the IM child only** (section 3.1 rule 4); the unit keeps a finite `LimitFSIZE`.
3. **`MemorySwapMax=0`, and host swap disabled.** A tmpfs file can swap, so both are part of the no-disk claim when a tmpfs file is used for stdin; a memfd is preferred.
4. **`LimitCORE=0` PLUS `kernel.core_pattern=|/bin/false` as a REQUIRED HOST setting.** With a pipe `core_pattern` the kernel runs the handler even at `RLIMIT_CORE=0` (seen for 4 of 4 processes), so `LimitCORE=0` alone is not enforced by the kernel. "SEGV leaves no core" was **NOT demonstrated** (the positive control also produced no dump on the test kernel), so it stays an open item until it is shown on the VPS with a control that does produce a dump.
5. **IM's memory limit under `MemoryMax`, and concurrency x about 0.5 GB under `MemoryMax`.** A cgroup OOM kills the whole wrapper (every concurrent request dies with it), not just the decoder. Keep `MAGICK_MEMORY_LIMIT` / the policy `memory` below `MemoryMax` so that an oversize decode ends as an IM error (clean 422), and set the concurrency limit so that `concurrent x 0.5 GB < MemoryMax` (one 50 MP decode peaked the cgroup at about 480 MB). Per-request sub-cgroups are a possible later improvement.
6. **The wrapper prefixes its log lines** with sd-daemon priority prefixes (`<5>` notice, `<4>` warning). `LogLevelMax=notice` drops unprefixed stderr (it counts as `info`), which hid the first startup failure in pass 2. A crash of the wrapper itself will not show at `notice` unless it logs at that level. The wrapper logs only fixed-format lines (`req ok in= out= ms=`, `req fail class=`) and discards IM's stderr instead of logging it.
7. **Pin the stored-WebP transform for determinism.** The 2048 resize and the WebP options are part of the contract: `-auto-orient -resize 2048x2048> -strip -quality 82 -define webp:method=4 -define webp:thread-level=0`, plus the decoder options of section 3.2 (`-define jpeg:dct-method=islow`) and `-colorspace sRGB`. With these pinned, 65 of 65 files gave byte-identical WebPs and scan frames across restarted processes, thread limits 1 and 8, two simultaneous containers, and container versus unit.
8. **`build_id` allow-list.** C7 was shown for one build on one CPU family (ImageMagick 7.1.1-43, libwebp 1.5.0-0.1, libjpeg-turbo 2.1.5-4, libpng 1.6.48-1). A library upgrade, or a different CPU (libwebp has SIMD paths), can change WebP bytes. So the decoder `build_id` that the Worker checks (section 2.3) must identify the library versions, any upgrade is a new allow-list entry, and a WebP-key lookup must be keyed with the `build_id` (rows written before an upgrade will not match).
9. `systemd-analyze security tj-decoder` must report 1.0 or lower on the VPS (0.5 on the test box); `IPAddressDeny=any` is moot with `PrivateNetwork=yes`.
**Process isolation for IM itself:** spawn IM as a child in its own session with `RLIMIT_FSIZE=0` (a kernel-level "this process can write no file" belt; shown to stop a large spill with EFBIG while the attempt is still flagged), `RLIMIT_CORE=0`, `RLIMIT_AS`, `RLIMIT_CPU`, a 20 s service deadline, and `MAGICK_TIME_LIMIT`.

**Host settings** (CireSnave's machine; this repo cannot enforce them): swap **off** (`swapoff -a`, remove from fstab) or
encrypted swap (`cryptsetup` random-key swap) — `MemorySwapMax=0` is the per-service control but a host with
ordinary swap can still page *other* processes' memory containing... only this service's pages matter, and the unit stops
those; still recommend swap off on the box; `kernel.core_pattern=|/bin/false` (**required**, rule 4 above) and `fs.suid_dumpable=0`; `systemd-coredump`
disabled/`Storage=none`; no crash reporter (apport etc.); journald: this unit's `LogLevelMax=notice`; no request/body/URL
logging in the service, the tunnel (`cloudflared --loglevel warn`, no access logs), or any fronting proxy; no backup/
snapshot of `/proc`-style memory; unattended-upgrades for IM/libjpeg/libwebp (the decoder faces hostile bytes); firewall
default-deny inbound; the container (if used) as `--read-only`, no volumes, `--tmpfs` **not** used (tmpfs is RAM, can swap),
`--cap-drop=ALL --security-opt no-new-privileges --pids-limit 64 --memory-swap == --memory`.

### 3.3 What this repo can and cannot enforce (NOT YET BOARDED)

**NOT YET BOARDED: the PM boards it as ONE item after review.** Nothing here is yet a request to CireSnave. The 13 items below are copied from pass 2 (`../spikes/2026-10-08-imagemagick-systemd-spike-pass-2.md` section 8); their commands and expected outputs were written on the test distro and must be re-run on the VPS. Items the spikes could not show are the reason the list exists.

Repo can enforce: the service code, `policy.xml`, systemd unit, container build (pinned base digest, IM version), the
Worker client, the HMAC contract, the proof tests (run by the PR author and, on a Linux GitHub runner, by CI), the
self-test, the allowlist of `build_id`/`policy_sha256`. Repo **cannot** enforce, so CireSnave/ops must set up and attest the list below. A `verify-host.sh` that prints each setting's current value (read-back, not assumption) for CireSnave to run and paste is the plan; the commands below are its content. Run them on the production host, as root, after the service and tunnel are installed.

1. **Host swap absent or encrypted.** Run `swapon --show --noheadings | wc -l; cat /proc/swaps; grep -i swap /etc/fstab; zramctl; systemctl list-units --type=swap --no-legend`. Expect `0`, only the header line in `/proc/swaps`, no fstab swap line, empty `zramctl`, no swap units. If swap must exist, `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT` must show the swap partition under a `crypt` device, with an `/etc/crypttab` entry using `/dev/urandom` and `swap`. Also `systemctl is-enabled hibernate.target` must say `static` or `masked`, and `cat /sys/power/state` must be empty or lack `disk`. The unit's own control: `systemctl show tj-decoder -p MemorySwapMax` gives `MemorySwapMax=0`, and `cat /sys/fs/cgroup/system.slice/tj-decoder.service/memory.swap.max` gives `0` (needs `stat -fc %T /sys/fs/cgroup` to print `cgroup2fs`).
2. **Core dumps and kdump.** Run `sysctl kernel.core_pattern fs.suid_dumpable`; expect `kernel.core_pattern = |/bin/false` and `fs.suid_dumpable = 0`. **Mandatory:** with a pipe `core_pattern` the kernel runs the handler even at `LimitCORE=0`. Then `systemctl is-enabled kdump kdump-tools apport systemd-coredump.socket 2>&1` must say `disabled`, `masked` or `No such file` for each; `grep -o 'crashkernel=[^ ]*' /proc/cmdline` must print nothing; `coredumpctl list 2>&1` must say `No coredumps found.`; `ls /var/crash /var/lib/systemd/coredump /var/lib/apport/coredump 2>&1` must be empty or absent; `cat /etc/systemd/coredump.conf.d/* 2>/dev/null` must show `Storage=none`. Finally the real test, not done in the spikes: `kill -SEGV $(systemctl show -p MainPID --value tj-decoder); sleep 3; coredumpctl list --no-pager; find / -xdev -name 'core*' -mmin -2 -type f` must find nothing, **after first doing the same with `LimitCORE=infinity` and a temporary file `core_pattern` and seeing that control produce a dump** (otherwise an absent dump proves nothing).
3. **Provider snapshots and backups** (cannot be checked from inside the VM). Get in writing from the provider's dashboard, API or support: (a) whether automatic or manual snapshots of this server are enabled, and whether they include RAM (live snapshot) or only disk; (b) whether backups are enabled and what they cover; (c) whether provider staff can take a memory snapshot. With a provider CLI, list the server's snapshot images (for the `hcloud` CLI: `hcloud server describe <name> -o json` and `hcloud image list -t snapshot`); expect no images for this server. Inside the VM, `crontab -l; ls /etc/cron.*; systemctl list-timers --all --no-legend | grep -i -E 'backup|snap|restic|borg|rsync'` must show nothing, or excludes for `/var/log/journal` and `/var/tmp`. The legal text must name the live-snapshot residual risk if (a) cannot be switched off.
4. **Firewall: default-deny inbound.** Run `ufw status verbose` (expect `Default: deny (incoming)` and only the SSH rule), or `nft list ruleset` / `iptables -S` (policy DROP on INPUT; accept only established, loopback and SSH). `ss -ltnup` must show the decoder only on `127.0.0.1:<port>` (or the unit has `PrivateNetwork=yes` and the socket unit binds loopback) and cloudflared metrics only on `127.0.0.1`. From another machine, `nmap -Pn -p- <public-ip>` must show only the SSH port or nothing. Check the provider-level firewall rules in the dashboard too.
5. **Tunnel and proxy logging and spooling config.** Run `systemctl cat cloudflared` and `ps -o args= -C cloudflared`; expect `--loglevel warn` (or `error`), no `--logfile`, `--no-autoupdate`, an unprivileged user. `cat /etc/cloudflared/config.yml` must have no `logDirectory` and no `loglevel: debug`; `ls -la /var/log/cloudflared* 2>&1` must say absent; `journalctl -u cloudflared --since '-1h' -o cat | grep -c -i -E 'GET|POST|request'` must print `0`. If any nginx, Caddy or Apache sits in front, `nginx -T 2>/dev/null | grep -E 'access_log|client_body_temp_path|proxy_request_buffering|client_body_buffer_size'` must show `access_log off` and `proxy_request_buffering off`, and `ls -la /var/lib/nginx/body` must be empty. Then repeat the marker test and the cloudflared no-disk check of pass 2 (sections 3 and 6) against the production hostname: POST a 15 MB or larger image carrying a marker, then `journalctl -a | grep -c <marker>` must print `0` and `inotifywait` on the tunnel user's home and `/tmp` must show no events. **Cloudflare side** (dashboard, not readable from the VPS): Zero Trust > Logs > Access (what is retained), Logpush jobs for the zone (none that include request bodies), WAF and rate limits, the Access policy and service token on the hostname.
6. **Kernel and hypervisor differences.** Run `uname -r; systemd --version | head -1; systemd-detect-virt; stat -fc %T /sys/fs/cgroup; cat /sys/fs/cgroup/cgroup.controllers; grep Seccomp /proc/$(systemctl show -p MainPID --value tj-decoder)/status`. Expect a kernel of 5.x or later, `cgroup2fs`, `memory` among the controllers, and `Seccomp: 2`. Re-run the whole proof suite (unit, strace, inotify, read-only and marker tests) on the VPS and compare with pass 2: `systemd-analyze security tj-decoder` must report 1.0 or lower (0.5 on the test box) and the six inputs must pass. Watch for: `MemoryDenyWriteExecute` with the VPS's service-language and ImageMagick builds, `PrivateNetwork` with socket activation, `ProtectProc=invisible` with its systemd version, whether `/tmp` is tmpfs or disk (`findmnt -no FSTYPE /tmp /var/tmp /dev/shm`; `/var/tmp` was disk-backed ext4 on the test box), and that the pipe `core_pattern` handler exists on that kernel.
7. **Real CPU and RAM sizing.** Run `nproc; lscpu | grep -E 'Model name|Flags' | grep -o -E 'Model name.*|avx2|sse4_2'; free -m; cat /sys/fs/cgroup/system.slice/tj-decoder.service/memory.max`, and the latency script on the VPS. Then `systemd-run --wait --pipe -p MemoryMax=2G -p CPUQuota=200% ...` with 3 to 4 simultaneous 50 MP uploads, reading `memory.peak` and `memory.events`; expect `oom_kill 0`. One 50 MP request peaked at about 480 MB on the test box and a cgroup OOM kills the whole wrapper, so set the concurrency limit so that `concurrent x 0.5 GB < MemoryMax`. Also confirm the WebP bytes equal pass 2's SHA-256s for the six inputs (CPU and SIMD determinism; the p05 WebP is 363,258 B).
8. **Persistent journal and log forwarding.** Run `journalctl --disk-usage; ls -d /var/log/journal 2>&1; systemd-analyze cat-config systemd/journald.conf | grep -E '^(Storage|MaxLevelStore|ForwardTo|Compress|Seal)'; systemctl show tj-decoder -p LogLevelMax`. Expect `Storage=volatile` (or a persistent journal accepted knowingly) and `LogLevelMax=notice`. Forwarding agents: `systemctl list-units --no-legend | grep -i -E 'rsyslog|syslog-ng|promtail|vector|fluent|filebeat|journalbeat|datadog|otel|newrelic|vmagent'` must show none, or confirm they do not ship this unit. Re-run the marker test and `journalctl -a | grep -c <marker>` must print `0`. (The test box's journal was persistent by default.)
9. **Backups and file-level capture of writable paths.** Run `findmnt -no TARGET,FSTYPE,OPTIONS /tmp /var/tmp /dev/shm /run`, and the unit's namespace view `nsenter -m -t $(systemctl show -p MainPID --value tj-decoder) findmnt -rn -o TARGET,OPTIONS | awk '$2 ~ /(^|,)rw(,|$)/'`. Expect only `/dev/pts`, `/dev/mqueue`, `/dev/hugepages`, `/proc` and `/sys/...`, and none of `/tmp /var /var/tmp /dev/shm /run`. If `/var/tmp` is disk-backed on the VPS, a leak there would be in provider disk snapshots.
10. **Patching of the decoder libraries.** Run `systemctl is-enabled unattended-upgrades; apt-config dump | grep -E 'Unattended-Upgrade::(Allowed-Origins|Automatic-Reboot)'; apt list --upgradable 2>/dev/null | grep -E 'imagemagick|libmagick|libjpeg|libwebp|libpng|libheif|libtiff'; magick -version | head -1; dpkg -l libwebp7 libjpeg62-turbo | awk '/^ii/{print $2,$3}'`. Expect unattended upgrades enabled with the security origin allowed, nothing upgradable, and the reported versions equal to the allow-listed `build_id`. A library upgrade may change WebP bytes (rule 8).
11. **Access to memory by the box's administrators.** Run `getent group sudo adm; last -n 20; ss -tnp | grep :22`. Expect only the owner. Root can read `/proc/<pid>/mem` of the decoder; document it (an operational, not a technical, control).
12. **HMAC secret and tunnel credentials handling** (section 2.2). Run `stat -c '%U %a %n' /etc/tj-decoder/* /etc/cloudflared/* ~/.cloudflared/*`; expect mode 600 or 640, owner root or the service user, none world-readable. `systemctl show tj-decoder -p LoadCredential,EnvironmentFiles` shows how the secret is passed (systemd credentials preferred over `Environment=`, which is visible in `systemctl show`).
13. **Wall-clock and network path from Cloudflare to the VPS** (what the Worker will actually see). From a Worker, or `curl` through the production tunnel hostname, POST 15 MB and read `%{time_total}`. The spike's 21 MiB upload took 47 to 62 s over a home line, which says nothing about this path.

Legal/privacy edits needed (spec §10.1/§10.3 text): originals now also flow Worker -> our own VPS -> Worker, never stored.
Not attorney-reviewed (spec §12 stance).

---

## 4. The no-disk proof test plan (goes in the PR)

Run on Linux only (WSL2 Alpine/Ubuntu or Docker Desktop on the Windows box is enough for the pipeline proof; the VPS run is
the one that counts). Inputs: synthetic images only (spec §9.1 generator): 1 MB JPEG, 15 MB noise JPEG, the 50 MP PNG, and
a deliberately over-limit image. Let `RUN` = the real service started exactly as systemd does it.

1. **Syscall proof (primary).** `strace -f -ff -tt -y -e trace=openat,open,creat,mkdir,rename,link,symlink,truncate,ftruncate,
   fallocate,memfd_create,mmap,write,pwrite64,sendfile,copy_file_range -o /run/trace/tj RUN` while driving all inputs.
   Pass = **no `openat` with `O_WRONLY|O_RDWR|O_CREAT|O_TRUNC` on any path that is not a pipe/socket/`/dev/null`/`/proc/self`**,
   no `memfd_create` surviving to a file, no `mmap` of a regular-file fd with `PROT_WRITE` and `MAP_SHARED`, and every
   `write`'s `-y` fd annotation resolves to `pipe:`/`socket:`/`/dev/null`. Script: parse the trace by fd, print the allowlist of
   observed write targets, fail otherwise. Paths read (policy.xml, libs) are fine.
2. **Filesystem-level proof.** Run `RUN` with root mounted read-only and no writable mounts (`systemd-run --property=
   ProtectSystem=strict --property=ReadWritePaths= --property=PrivateTmp=yes ...`, or `docker run --read-only` with no
   tmpfs/volume). Same inputs: **all must still succeed.** If anything needs a writable path it fails loudly (EROFS). That is
   the strongest statement: "it works with nowhere to write".
3. **Event proof (belt).** `inotifywait -m -r -e create,modify,moved_to,attrib /tmp /var/tmp /dev/shm /var/lib /run $HOME /proc/self/fd`
   in the namespace (container: via `nsenter`) during the run; expect zero events. Also snapshot `find / -xdev -newer <stamp>
   -type f` (and `find /proc/<pid>/fd -lname '/*'` sampled during a 50 MP decode) before/after.
4. **Resource-limit proof (IM specifics).** `magick -list resource` under the production env prints `Disk: 0`. Then force the
   spill condition: decode the 50 MP PNG with `MAGICK_MEMORY_LIMIT=64MiB` (policy memory lowered) and assert IM **errors**
   ("cache resources exhausted" or similar) *instead of* creating a `magick-*` file. This proves the failure direction is
   closed, not "quietly writes a temp file".
5. **Kernel-enforced belt.** Run IM child with `prlimit --fsize=0`; a decode must succeed (nothing to write) — and a
   control (below) with the limit lifted must be caught by 1.
6. **Memory/swap/core.** During a 50 MP decode: `grep -E 'VmSwap' /proc/<pid>/status` = 0; `ulimit -c` = 0 and a
   `kill -SEGV` of the service leaves no `core*` anywhere (`find`), with `coredumpctl list` empty.
7. **Logging proof.** Drive an input with a unique marker in its EXIF (`TJ-MARKER-<random>`); afterwards `grep -r` the marker
   across journald (`journalctl -a | grep`), the tunnel logs, `/var/log`, and the strace output of `write` calls to fd 1/2.
   Expect zero (marker only appears on the socket write back to the client).
8. **Fronting components included.** Repeat steps 1 and 3 with the *whole path* running (tunnel/proxy + service) and a 15 MB
   upload, because the likeliest spool is not our code (nginx buffers, `cloudflared`).

**Negative controls (the test must be able to fail; portfolio rule section 6):** for each of 1, 3, 4, 7 run once with a
deliberately broken config and require the checker to FAIL: (a) set `policy resource disk` to `1GiB` and
`MAGICK_MEMORY_LIMIT=64MiB`, decode the 50 MP PNG: IM must write a temp file and checks 1, 3 and `find` must flag it;
(b) a tiny wrapper that does `echo x > /tmp/probe` and checks 1/3 flag it; (c) run with `ReadWritePaths=/tmp` and a service
build flag that spools bodies and check 2 must show it failing/being caught; (d) log the EXIF marker once and check 7 flags
it. Assert **each negative produced the predicted flag** (count == 1 on each), so a never-applied mutation can't read as
"not caught". Also record the trace line count so an empty trace (strace attached to the wrong pid) can't pass.

---

## 5. Spike plan: re-run spec C3 and C6 against ImageMagick

**Standing rule for any spike or test run on a shared machine:** no unscoped `docker kill`, `stop`, `rm` or `prune`; never touch containers, volumes or networks you did not create; name yours with a unique prefix (for example `tjspike-`) and act only on that prefix; run nothing that needs more than the Docker/WSL resources the spike itself created. (The first spike broke this once, see spike section 6, item 9.)

**Status: pass 1 run on 2026-10-08, see `../spikes/2026-10-08-imagemagick-pdq-spike.md`; pass 2 (C7, C8, systemd, quick tunnel, latency) in `../spikes/2026-10-08-imagemagick-systemd-spike-pass-2.md`.** What follows is the plan; the spike's results supersede it where they differ, and the items the spike did not run remain open. The spec's US0 spike used a throwaway Worker with the Images binding (spec §2.4). Replace it with a **throwaway container
(same image that will ship) + a script**; the Worker only matters for C1/C2/latency (PDQ CPU in the Worker is unchanged, and
the decoder is no longer inside the isolate, so C2's memory worry mostly disappears: INFERRED). Nothing here needs HMS-A
or any real abusive material.

**Setup (Linux needed for final numbers; Docker Desktop on the Windows box is fine for development):**
- Build the image pinned by digest: IM 7 (record `magick -version`, `magick -list format | grep -E 'JPEG|PNG|GIF|WEBP'`
  with delegates, libjpeg-turbo and libwebp versions). Record everything in the PR.
- Reference PDQ: `facebook/ThreatExchange` `pdq/cpp` built at a **pinned SHA** (cmake is on the Windows box, `g++` is not;
  build inside the container/WSL). Read at the pinned SHA which loader `pdq-photo-hasher` uses (CImg native codecs vs an
  external `convert` call): **UNVERIFIED**, the spec's claim that it is CImg nearest-neighbour is itself second-hand
  (spec §3.1). The PM's note says the reference uses ImageMagick; confirm in source, then match IM options to it.
- Our PDQ: the TS port (spec US1). Until it exists, use the reference's own raw-input mode on IM's 512 raw output for (b).

**C3 re-expressed (decode shape), per input of spec §2.4 list items 1-8:** output `512*512*3` bytes (or `w*h*3` at native size when both sides are <= 512, section 2.3 (b)) for JPEG, PNG,
GIF, WebP; EXIF Orientation 6 and 8 at 400x300 and 3000x2000; GIF/animated-WebP frame 0 only (PDQ within 10 of a frame-0
still, > 31 from a frame-1 still); alpha background colour recorded; 1x1 and 10000x5; flat image (low quality). **New for
IM:** (i) forced resource errors recorded verbatim (disk-limit, memory, time, pixel-limit exit codes and stderr: these map to
`resource_limit`/`pixel_limit`); (ii) animated-WebP read behaviour; (iii) whether `rgb:fd:3` single-pass works vs two
processes; (iv) peak RSS and wall time per input at 50 MP; (v) with `-auto-orient` on/off for the scan frame.

**C6 (hash fidelity), method:** corpus = spec §3.4 (public/CC0, no people, >= 2048 px, plus `pdq/data` if licence permits
and the generated non-photographic set from C8; each listed with source and licence). For each file F:
- (a) `ref_hash(F)`: reference CLI on the original file (the true list-hash analogue);
- (b) `ref_core(IM_raw512(F))`: reference PDQ core fed the VPS's 512x512 raw bytes;
- (c) `ts_pdq(IM_raw512(F))`: our port on the same bytes — **must equal (b) bit for bit** (this is C5; it isolates the port
  from the resampler);
- distance d = Hamming((a),(b)); also dmin over the 8 dihedral variants of (b).
Sweep IM `-filter` in {Point, Box, Triangle, Mitchell, Lanczos} x auto-orient {off,on}. *(Revision 1 said `Point` is the first candidate. Run: Point is worse than Lanczos on real photos, and `-define sample:offset=0 -sample` was the match, section 3.1.)* The original reasoning was: if
the reference truly uses nearest-neighbour to 512 (spec §3.1, unverified), IM `-filter Point` may reproduce it almost
exactly, which is better than the binding could ever be. **Pass (spec §3.4, unchanged): d <= 10 for every image of reference
quality >= 80, and d <= 16 for every image.** Pick the configuration with the best max/p95 and freeze it into the contract
(it becomes part of `policy_sha256`/`build_id`). **Fail:** do not ship; PM chooses between a different resize matched to the
reference or the bytes fallback as primary (spec §3.4 Fail line).
**Report:** per configuration the Hamming distribution (min/median/p95/max), counts per reference-quality bin, the names of
every image over 10, over 16 (by name, not only counts), and C8's share of quality <= 49. Also C7: same input -> same WebP
SHA-256 twice, and across two container instances.

**Where it runs:** Windows box can do Docker-based C3/C6 and the synthetic generator (spec §9.1; Node is present).
Authoritative numbers must come from the **production image on a Linux host** (the VPS, or Docker with the digest that ships);
a native Windows IM build is not evidence (different delegates/SIMD). The strace/inotify proof (section 4) is Linux-only
(`strace` seen only on the Git-Bash PATH, not for Windows processes).
**No abusive material needed anywhere:** every input is synthetic or public non-abusive (spec §9, §3.4); HMS-A is not
called; PDQ "matches" in route tests stay stubbed (spec §9.3).

---

## 6. D11 — post-launch recheck (design only; DO NOT BUILD)

Ruling (CireSnave, via PM, 2026-10-08): the recheck must exist, must not gate launch. Replaces spec §0.3's "not carried
forward" and §14 D11's "out of scope"; the options doc already favoured it ("yes, re-check old media when a list updates",
options doc lines 448-453).

**Trigger:** the `*/2` tick (or a daily cron) reads HMS-A's current list version. **UNVERIFIED:** how HMS-A exposes a list
version (spec leans on rev-3 §11.3, `scan_list_version`). If it exposes none, fall back to a time cadence (e.g. weekly full
pass). A diff is only an optimisation for exact-hash lists we hold and run ourselves (NCMEC sync later; PM's note): HMS-A is
a black box, so we cannot compute "what changed", we re-ask.

**Selection:** `media` rows where `scan_list_version IS DISTINCT FROM current` AND `pdq IS NOT NULL`, ordered by
`scanned_at` ascending, resumable cursor + fixed `target` snapshot (the same cursor/snapshot/per-key-status shape as the
backfill, spec §4.4: `media_recheck_progress` singleton + per-key `media_recheck` status, keyed by `r2_key` since rows share
objects). Batch 20-50 keys/tick, bounded by HMS-A rate limits (the call takes an array of up to 8 dihedral hashes per image,
spec §3.5, so budget calls = images).

**What is re-sent (hash-only, no R2 read, no decode, original never needed):**
- rows with `pdq` set (`pdq_source = 'original'`, from upload): send `pdq`'s 8 dihedral variants (recomputed, not stored,
  spec §4.2);
- rows with `pdq_source = 'stored_webp'` (backfilled; hashed from the WebP, spec §4.4): same call, but note these hashes
  came from a different pixel source, so they carry lower recall; flag in results;
- rows with `pdq IS NULL` (pre-launch media never backfilled, quality <= 49 "unscannable" rows, `needs_review` animated
  keys): **cannot be rechecked by hash**; they stay on their existing U6/review paths. Count them on the recheck dashboard;
  the recheck is not complete for them. (A low-quality row has no usable PDQ by definition, spec §6.1.)
- `original_sha256` (exact, step 6a): also usable for an exact-hash lookup where a list we hold supports it (future NCMEC
  list); HMS-A's hash-only endpoint takes PDQ, so SHA-256 is **not** sent there. **UNVERIFIED:** whether HMS-A has an exact
  hash endpoint.

**Outcomes:** clean -> update `scan_list_version`, `scanned_at` on every row sharing the key (the `UPDATE ... WHERE r2_key =`
shape of backfill). Match on public media -> the same hold-and-report path as the backfill/self-scan intake
(`runIntake({source:"self_scan"...})`, spec §4.4 match row; quarantine to `MEDIA_RESTRICTED`, case, NCMEC clock), not a
second intake. HMS-A unavailable -> attempts/backoff, never advances `scan_list_version` (stays eligible), alarm like U6
(proposed U12: recheck stalled or a key `failed`, daily; immediate on any new match). Idempotent via the case-file unique
key `r2_key` (options doc line 441).

**Not in scope / notes:** rows under `csam`/legal hold or already restricted are skipped; deletions are skipped; the recheck
never fetches bytes; the PhotoDNA scan step is on-demand only (options doc line 454). Needs no new decoder; independent of D7.

**Roadmap:** the D11 entry already lives in `PORTFOLIO-ROADMAP.md` (the PM owns it). It is not repeated here. When D11 is
built, this section moves into the upload-scan spec as a numbered section.

---

## 7. Open questions, risks, unverified

1. **[Decided, PM 2026-10-08, see Rulings]** Tunnel + app-level HMAC over mTLS/public IP (section 2.1/2.2); U11 and the
   `decoder_credentials_refused` reason are approved as amendments to spec §11.1 (the spec is rev 3, this is rev 4 material).
2. **[Decided, PM 2026-10-08: no fallback decoder]** Remove the Images binding code (recommended) vs keep a flag-selected `binding` mode. Fail-closed argues for
   removal; a flag mode needs its own C3/C6 evidence.
3. **[Residual risk]** The VPS is now a single point of failure for all image uploads. CireSnave accepted multi-VPS later; until
   then a VPS outage is a content outage for images. Not a launch problem if monitored (U1/U9).
4. **[Residual risk]** Hosting-provider-level snapshots/live migration can capture RAM; swap/core settings cannot reach it.
   The "never on the VPS drive" claim is about the guest filesystem; state it that way in the legal wording.
5. **[Partly verified]** The `policy.xml` in section 3.2 works on ImageMagick 7.1.1-43 only. `map 0`, the `module` and `path` rules, and `cache memory-map anonymous` were verified there; revalidate on any upgrade.
6. **[Done with limits, pass 2]** C7 (WebP determinism, 65 of 65 across processes, thread limits and containers; **says nothing about the Cloudflare Images encoder**, one build and one CPU family only); C8 on 91 hand-picked real images (0 of 91 at quality <= 49) with flat-heavy images still unmeasured (item 9); the systemd directives (section 3.2, on systemd 257.13 under WSL2); the no-disk proof against the running unit; the marker logging proof; a cloudflared **quick** tunnel (no named tunnel, no Access, HTTP/2 not QUIC, binary 2026.10.0 only); latency, **local only**. **Remaining open:** the TS PDQ port leg (item 7); C7 for the Cloudflare Images encoder (needs a Cloudflare account); MagickWand in-process blob reads (not tested); non-sRGB ICC, HEIC and TIFF input; SEGV-no-core (section 3.2 rule 4); animated inputs of more than 4 frames; and every result on the VPS host (section 3.3).
7. **[OPEN ITEM]** The TS PDQ port leg of C5/C6 (our port equals the reference core on the IM frame) was not run: no port exists on `origin/main`. All distances in the spike are reference core on the IM frame against reference on the original. The reference's CImg nearest-neighbour resampler is now **verified** (revision 1 called it secondhand). The reference's loader is itself ImageMagick `convert`, so decode agreement with it is not independent evidence (pass 1, 4d).
8. **[OPEN PRODUCT DECISION, RECOMMENDED, PENDING CIRESNAVE]** *"Any non-empty stderr is failure" rejects some legitimate images.* IM exits 0 on a time limit and on a truncated JPEG, so the service must treat any stderr as failure (section 3.1 rule 2). That same rule rejected 1 of 66 fixtures (1.5%): a 16-bit PNG with an embedded ICC profile (`iCCP: profile 'icc': 0h: PCS illuminant is not D50`); IM exited 0 and the frame was fine. The same profile in a JPEG decoded without a warning. A real user PNG with a quirky ICC profile would be refused as undecodable (the spec's §6.1 decode-failure row, 503, not C8). Options: **(i) reject**, fail closed; **(ii) allow-list** known-benign warnings by exact text; **(iii) strip the ICC profile** before decode (needs a first pass, which costs a decode or a header rewrite). **Recommendation: (i) reject** (fail closed, 422), count it in the self-test (section 2.5), and revisit if real uploads hit it. RECOMMENDED, PENDING CIRESNAVE (not the PM).
9. **[OPEN QUESTION, launch impact]** **Content-rich real images 0/91 (CI 0-4.1%); flat-heavy images unmeasured.** C8 on 91 hand-picked Wikimedia Commons screenshots, diagrams, charts, maps, slides, logos, pixel art, line art and scans found none at PDQ quality <= 49 (Wilson 95% upper bound 4.1% for that selection, not for user uploads); details, the manifest and the limits are in `../spikes/2026-10-08-c8-real-corpus-measurement.md`. The positive control in that run does fail as it should (flat white 0, red-blue gradient 0, white with one small rectangle 13), and mostly-flat images (solid-colour memes, one-colour logos, blank editors, phone chat screenshots) were underrepresented, so this is not the production rate. Earlier numbers here: real photos 0 of 27 and photo-derived variants 0 of 29 at quality <= 49; the generated set of pass 2 is not a valid estimate. An image at quality <= 49 is never sent and, with the bytes fallback off (the default), gets 422 `IMAGE_UNSCANNABLE` (spec C8, §6.1). **D13 stays an OPEN decision for CireSnave:** what to tell a user whose flat logo is refused, and whether the bytes fallback is on. Owner: the PM, with D13.
10. **[Behaviour change]** IM re-encode will not byte-match Cloudflare's WebP for the same upload; old objects stay as stored.
   Colour management: applying an embedded ICC profile needs an sRGB ICC file on disk (read-only is fine); otherwise
   `-colorspace sRGB` only. Decide in the spike which is acceptable visually; the old binding applied profiles
   (`images.ts:146-147`).
11. **[Ordering change]** Quota check moves ahead of the decoder call (section 1); the pixel-bomb 413 is now produced by the
   VPS. Both keep user-visible bodies identical to today's.
12. **[Not read]** I did not read the rev-3 CSAM reporting spec, the #114 plan, or HMS-A's API document (the spec cites them);
    D11's "list version" source and 8-hash call shape rest on the upload-scan spec's description only.

---

## 8. Amendments this design makes to the upload-scan spec (revision 4 material)

Applied in `2026-10-07-upload-scan-design.md`:

- Section 11.1 gains alarm U11 (decoder identity drift), and U7 (Images allowance) goes dead once the binding is removed.
- Sections 6.1 and 6.6 gain the reason `decoder_credentials_refused`. It is a new value of the free-text `reason` column. The
  `outcome` CHECK (`scanned`, `unavailable`) is unchanged, so no schema change is needed.
- Section 3.3 (frame geometry) and the §3.6 self-test change with this design: the scan frame is 512x512 only when a side is > 512, and otherwise native size. The spec's `PDQ_DECODE_EDGE` / `hasExpectedGeometry` text must follow when it is next revised.
- Sections 2 and 3.3 note that the decoder seam's production implementation is the VPS service. The binding-based text stays and
  is marked superseded by this document.

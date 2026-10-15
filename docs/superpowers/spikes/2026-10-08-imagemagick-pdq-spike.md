# ImageMagick vs reference PDQ spike (C3/C6) and policy / no-disk checks (Stage B)

**Date:** 2026-10-08. **Part of #114.** Evidence for `../specs/2026-10-08-vps-image-service-design.md` (revision 2).
Provider named only as HMS-A. No abusive or questionable material, no HMS-A call, no database.

**Read this first.** The spike ran on **Docker Desktop (WSL2 backend) on the founder's Windows box, not on the production
VPS**. It is **not a pass of the whole design.** It answers the resize/hash-fidelity questions (C3/C6 in part) and several
no-disk questions. The items listed in section 7 are still open. The spike scripts are committed under `scripts/pass1/` (see `scripts/README.md`); raw outputs and
fixture images are not committed.

## 1. Environment

| item | value |
|---|---|
| Host | Windows 11, Docker Desktop 29.5.3, WSL2 kernel 6.18.33.1-microsoft-standard-WSL2. Not the production VPS. |
| Base image | `debian:trixie-slim`, `debian@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f` |
| Built image | `tj-spike:1`, id `sha256:f028a2e74b7d0e4e19ca5e2a0ce20ef1fb486e9134791b0948456eba93f5fc1a` (local only; apt packages not pinned individually) |
| ImageMagick | `7.1.1-43 Q16 x86_64 22550`, Debian `imagemagick 8:7.1.1.43+dfsg1-1+deb13u12` (modules build, OpenMP 4.5) |
| Libraries | libjpeg62-turbo 1:2.1.5-4, libwebp7 / libwebpdemux2 / libwebpmux3 1.5.0-0.1, libpng16-16t64 1.6.48-1+deb13u6, liblcms2-2 2.16-2+deb13u2, libtiff6 4.7.0-3+deb13u3, libheif1 1.23.4-1~deb13u1, g++ 4:14.2.0-1, strace 6.13 |
| Reference PDQ | `facebook/ThreatExchange` commit `85978d7cabdf631c0e4be9cb2be2816b2b9a6911` (2026-10-02), `pdq/cpp`, built with g++ -O3. `pdq-photo-hasher`, plus a small tool that calls the reference core (modes `file`, `frame`, `raw`, `rawdih`). |
| Sanity control | `pdq-photo-hasher` on `pdq/data/reg-test-input/dih/bridge-1-original.jpg` is byte-equal to the repo's own `pdq/cpp/reg_test/expected/out`. (The README example hash differs by about 10 bits, so it is stale.) |
| TS PDQ port | Does not exist on `origin/main`. **The "TS port equals reference on the IM frame" leg (C5) was NOT run.** All distances below are reference core on the IM frame vs reference on the original. |

## 2. What the reference does (source read at the pinned commit)

- `pdq/cpp/io/pdqio.cpp` loads through CImg (vendored, version 2.2.0), then `if (h > 512 || w > 512) input = input.resize(512, 512)`.
  **Images with both sides <= 512 are not resized** (hashed at native size). Aspect ratio is not kept.
- The resampler is `CImg::resize(sx, sy)` with the default interpolation type 1, documented in the same header as
  nearest-neighbour. **The earlier "CImg nearest-neighbour" claim is verified for the vendored source.** ImageMagick
  `-define sample:offset=0 -sample 512x512!` reproduces it (d = 0, 2, 2, 0, 0, 0 on photos p01-p06).
  `-filter Point -resize` and the default `-sample` (offset 50) do not.
- **The reference's loader is ImageMagick, not CImg codecs.** No `cimg_use_jpeg`/`cimg_use_png` is defined, so `load()` falls
  through to `load_imagemagick_external`, which runs `convert "<file>" pnm:-`. So the reference hash depends on the
  installed ImageMagick. Consequences:
  - It ignores EXIF orientation (rotated JPEGs hash unrotated; the dihedral hashes cover the rest).
  - PNM output carries no flattened alpha: transparent pixels contribute their stored RGB.
  - **Non-8-bit sources are mis-read** (PNM maxval is not rescaled): 16-bit, 1-bit and 4-bit PNGs give garbage reference frames
    (a 16-bit PNG measured d about 126 until an 8-bit re-save was used as the reference input). Treat a reference hash of such a
    file as invalid. Synthetic fixtures were regenerated at 8 bits for this reason.

## 3. Fixtures (64 files, all benign)

- **27 real photos**, each CC0 per Wikimedia Commons `LicenseShortName` (fetched through the Commons API). p01-p06 are original
  files. p07-p27 are Commons-generated thumbnails at width = min(original, 3840), because original downloads were rate-limited
  (HTTP 429). Each file is its own hashed input, so this does not affect the comparison. Subjects: landscapes, architecture,
  macro flowers, coast, forest, desert, two museum artworks (a painting and a drawing), a panorama. A manifest with URL, sha256
  and licence per file was kept locally.
- **Deviation from "no people":** p08 has one very small distant figure, p23 a small distant beach crowd, p01 a tiny distant
  figure on a rock. No portraits. Three fixtures therefore carry incidental figures.
- **Derived or generated** (same CC0 licence as the source, or synthetic): 64 px JPEG, 300 px PNG, 12 MP progressive JPEG,
  grayscale JPEG and PNG, CMYK JPEG, lossy WebP, lossy WebP with alpha, PNG with alpha, 16-bit PNG, palette PNG, animated GIF and
  animated WebP (4 frames each), EXIF Orientation 1-8 JPEGs at 400x300 and 3000x2000, synthetic gradient, checkerboard, seeded
  noise, flat colour, 1x1, 10000x5, 5x10000, shapes. Stage B used a 7071x7071 PNG (15.5 MB) and JPEG (10.2 MB) of about 50 MP.
- **Not covered:** a JPEG with a non-sRGB ICC profile under control (no profile file available), HEIC, TIFF, 10-bit anything.

## 4. Stage A: hash fidelity (C6)

Method. `H_ref` = reference loader plus resize on the original. `H_im` = reference PDQ core on
`magick <fmt>:- [-auto-orient] <alpha> -colorspace sRGB <resize 512x512!> -depth 8 rgb:-` (explicit coder prefix, `[0]` for
GIF/WebP). d = Hamming(H_ref, H_im). 28 configurations x 64 files = 1792 runs, 0 errors. Bars: d <= 10 for reference quality
>= 80, d <= 16 for all. Candidate resizes: Point, Box, Triangle, Mitchell, Lanczos (`-filter F -resize 512x512!`), Sample50
(`-sample 512x512!`, offset 50 default) and **Sample0** (`-define sample:offset=0 -sample 512x512!`); alpha `off` (`-alpha off`)
vs `white` (flatten on white).

### 4a. Real photos only (p01-p27, all reference quality 100)

| resize | min | median | p95 | max | n > 10 | n > 8 |
|---|---|---|---|---|---|---|
| **Sample0** | 0 | 2 | 6 | **8** | 0 | 0 |
| Lanczos | 2 | 6 | 10 | 10 | 0 | 6 |
| Triangle | 2 | 6 | 10 | 10 | 0 | 5 |
| Mitchell | 2 | 6 | 10 | 10 | 0 | 5 |
| Box | 2 | 6 | 11.4 | 12 | 2 | 6 |
| Point (`-resize`) | 2 | 8 | 17.4 | 20 | 8 | 12 |
| Sample50 | 0 | 8 | 17.4 | 20 | 8 | 12 |

Worst files: Point p06 20, p21 18, p22 16; Box p05 12, p06 12; Sample0 p15 8, p23 6, p27 6. A frame check: the Sample0 frame
equals the reference's own 512 frame for 99.8% of bytes on p01 (94% on p05, 74% on p02); the rest is from CImg's float index
arithmetic, and the hash distance stays <= 8.

### 4b. All 43 non-EXIF fixtures larger than 512 px (photos, format variants, synthetic), alpha off, auto-orient off

| resize | min | median | p95 | max | quality >= 80 and d > 10 | d > 16 |
|---|---|---|---|---|---|---|
| **Sample0** | 0 | 2 | 8 | 74 | **none** | s_checker (44, quality 13), s_flat (74, quality 0): both quality <= 49, never sent |
| Triangle | 2 | 8 | 111 | 147 | d_alpha 12, s_noise 92 | s_10000x5 147, s_5x10000 113, s_checker 28, s_flat 74, s_gradient 130, s_noise 92 |
| Lanczos | 2 | 6 | 111 | 144 | d_alpha 14, d_lossy.webp 12, s_noise 92 | s_10000x5 113, s_5x10000 130, s_checker 30, s_flat 74, s_gradient 144, s_noise 92 |
| Box | 2 | 8 | 112 | 128 | d_alpha 14, d_progressive12mp 12, p05 12, p06 12, s_noise 96 | s_10000x5 118, s_5x10000 114, s_checker 56, s_flat 74, s_gradient 128, s_noise 96 |
| Point | 2 | 8 | 104 | 120 | 12 files (p05, p06 20, p12, p15, p21 18, p22, p23, p27, d_alpha, d_lossy, d_progressive12mp, s_noise 120) | p06, p21, s_10000x5, s_5x10000, s_checker, s_flat, s_gradient, s_noise |

(Mitchell and Sample50 behave like Triangle and Point.) Over the 39 fixtures of quality >= 50, Sample0 has min 0, median 2, p95
6, max 8. Extreme-aspect and noise images are where area-averaging filters and nearest-neighbour legitimately diverge; only
Sample0 matches the reference there. All 27 photos and every format variant are reference quality 100; quality below 80 occurs
only for some synthetic files. **C8's share of quality <= 49 was not measured** (the 100-image non-photographic corpus was not
built).

### 4c. Other cases

- **Alpha** (PNG and lossy WebP with alpha): `-alpha off` with Sample0 gives d = 0 and 0. Flatten on white gives d = 52 and 54.
  The reference ignores alpha. Flattening on white is a product choice that costs fidelity to the reference on transparent
  images; `-alpha off` matches exactly.
- **Format variants, Sample0, alpha off:** CMYK JPEG 0, gray JPEG 2, gray PNG 2, 16-bit PNG 0 (against an 8-bit reference),
  palette PNG 2, lossy WebP 0, 12 MP progressive JPEG 0. (Lanczos: 4, 8, 8, 6, 2, 12, 10.)
- **Animated GIF/WebP frame 0** (`gif:-[0]`, `webp:-[0]` from stdin works): frame 0 vs the frame-0 still = 2 (GIF) and 6 (WebP);
  frame 0 vs the frame-1 still = 130 and 130 (target: <= 10 and > 31). Pass. Without `[0]`, GIF returns all frames.
- **Small images (both sides <= 512).** The reference does not resize. A forced 512x512 frame costs d = 12 to 16 (64 px: 12,
  300 px: 16, the 400x300 EXIF set 8 to 16, 1x1: 58 at quality 0), the edge of the 16 bar. **Measured fix:** emit the native-size
  frame (no resize) and run PDQ at that size: d = 0 on all 12 such fixtures. The contract and any TS port must then accept a
  variable width/height for small images.
- **EXIF orientation** (8 tags x 2 sizes), Sample0:

  | | 3000x2000 | 400x300 (reference hashes native size) |
  |---|---|---|
  | auto-orient OFF, d vs H_ref | 0 for all 8 orientations | 8 to 14 (forced 512 upsample) |
  | auto-orient ON, d vs H_ref | 120 to 140 (rotated) | 122 to 136 |
  | auto-orient ON, best of 8 dihedral variants | 0 to 18 (tags 2 to 8: 16, 18, 14, 0, 16, 18, 14) | 12 to 20 |

  With auto-orient OFF the hash equals what the reference computes, and the 8 dihedral hashes cover a list entry made from the
  rotated rendition. With auto-orient ON the best dihedral variant is only within 12 to 22 for flips, because nearest-neighbour
  sampling of a flipped source lands on different pixels. **Result: auto-orient OFF for the scan frame, ON for the stored WebP.**
- **Determinism C7** (same input gives the same WebP twice, and across two instances): NOT run.

### 4d. Verdict against the bars

- **Pass:** `-define sample:offset=0 -sample 512x512!` with `-alpha off` and no auto-orient, for images the reference resizes
  (more than 512 on a side). Every image of reference quality >= 50 is within 8 (bar 10); the only fixtures over 16 are quality
  <= 49 and are never sent.
- **Standard filters fail the stated bars on realistic fixtures.** Lanczos, Triangle and Mitchell pass on the 27 photos (max 10)
  but fail on alpha, lossy WebP and extreme-aspect or noise images. Point and Box fail on real photos.
- **Fail unless handled:** images with both sides <= 512 (handle by hashing native size), and transparent images (handle with
  `-alpha off`).
- **Limits of this evidence:** one decoder, ImageMagick 7.1.1-43, and the reference loader is the same ImageMagick, so decode
  agreement is not independent evidence; only the margin and the resize choice are informative. 27 photos of a narrow range of
  subjects. The TS port was not tested. HMS-A's own list pipeline is unknown. No controlled ICC test.

### 4e. Pipeline the numbers support

```
magick <fmt>:fd:0[0 for gif/webp] -alpha off -colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 rgb:fd:1   (a side > 512)
magick <fmt>:fd:0[0 for gif/webp] -alpha off -colorspace sRGB -depth 8 rgb:fd:1                                           (both sides <= 512; report w,h)
```

## 5. Stage B: policy and no-disk results

| check | result | evidence |
|---|---|---|
| Design `policy.xml` as first written | **FAIL** | every decode errors `no decode delegate for this image format ''`. Cause (1): `module rights="none" pattern="*"` blocks the module-built coders; fixed by an **upper-case** `module read\|write {JPEG,PNG,GIF,WEBP,RGB}` allow (lower-case names do not match). Cause (2): `path rights="none" pattern="*"` blocks stdin `-` even with a later allow for `-`, in either order. |
| Working policy (`prod2.xml`, in the design doc) | **PASS** | the first policy plus the upper-case module allow, `path none *`, and `path read\|write fd:*`. Input `<coder>:fd:0` and output `rgb:fd:1` / `rgb:fd:3` work. Reading a file by path, `@file`, `xc:` and `info:` are blocked. |
| `disk 0` turns an over-memory decode into an error | **PASS** | 50 MP PNG with memory 64 MiB: `cache resources exhausted 'fd:0' @ error/cache.c/OpenPixelCache/3931`, rc 1, 0 output bytes, 0 `magick-*` files. Control (policy disk 1 GiB): temp file written. |
| `map 0` with a 50 MP decode in 512 MiB | **PASS** | 7071x7071 PNG peak RSS 303 MB, 2.8 s; JPEG 303 MB, 1.2 s; 12 MP 0.5 to 0.8 s and 80 to 115 MB; 24 MP 0.5 s and 142 MB. Memory 1 GiB or map 512 MiB gives the same numbers. VmSwap 0. |
| `-list resource` under the policy | **PASS** | `Memory: 512MiB Map: 0B Disk: 0B` (Debian default 1GiB / 2GiB / 2GiB) |
| `time` policy key enforces | **FAIL** | `-list resource` prints `Time: unlimited`; a 2.8 s decode with `time=1` succeeded. `MAGICK_TIME_LIMIT=N` and `-limit time N` do work. |
| Exit status on time-limit or damaged input | **FAIL (important)** | with `MAGICK_TIME_LIMIT=1` IM printed `time limit exceeded` but **exited 0** and emitted garbage (PNG: 150 MB un-resized raw; JPEG: 786,432 partial bytes). A truncated JPEG also exits 0 with a full-length frame and `Premature end of JPEG file` on stderr; `-regard-warnings` did not change the exit code. Six benign photos produce empty stderr. |
| Forced-error shapes (rc 1, stderr only) | recorded | area or memory limit: `cache resources exhausted 'fd:0' @ error/cache.c/OpenPixelCache/3931` (a 10 MP area limit gives the same text, so IM's text cannot tell `pixel_limit` from `resource_limit`); width over 16KP: `Image width exceeds user limit in IHDR` and `Invalid IHDR data`. |
| Pipe stdin spools to disk | **FAIL (hazard)** | with stdin an anonymous pipe, IM copies the whole input to `magick-XXXX` (in `MAGICK_TEMPORARY_PATH`, or the cwd `/` if that does not exist) before decoding. strace: 15 to 30 writes of 512 KiB; the path policy then blocks the re-open so the decode fails, but the bytes were already written. inotify saw 85 events. Unprefixed `fd:0` spools the same way. **Fixes tested:** stdin as a regular file (no spool) and stdin as a memfd (RAM, seekable; no spool, all 6 inputs decode, writes only to pipes and the memfd). In-process blob reads were not tested. |
| Single pass: scan frame and WebP in one process | **PASS after fix** | `rgb:fd:3` inside `\( ... \)` fails (`must specify image size 'fd:3'`). `\( +clone ... -write rgb:fd:3 +delete \)` works: the 786,432-byte frame is byte-identical to the separate-process frame; WebP 363,258 bytes (q82, method 4). |
| Animated GIF/WebP frame 0 from stdin | **PASS** | see 4c |
| Coder confusion | **PASS** | `jpeg:` on an SVG payload: `insufficient image data`; `png:` on a JPEG: `improper image header`; unprefixed stdin: a spool attempt (blocked); `coder none *` blocked `xc:` |
| Proof step 1, syscall trace | **PASS** in file and memfd modes; pipe mode FAIL as expected | 6 inputs (12 MP JPEG, alpha PNG, GIF, lossy WebP, 50 MP PNG, 50 MP JPEG). File mode: 3,562 trace lines, writes only to pipes, 0 violations. memfd mode: 3,568 lines, 6 `memfd_create`, writes to pipes and the memfd only, 0 violations. Pipe mode: 75 violations (writes to `/magick-*`). |
| Negative controls | **PASS** (each predicted flag fired) | (a) spill policy (disk 1 GiB, memory and map 64 MiB, tmp `/tmp`): 24,219 violations, writes to `/tmp/magick-*`, 23,445 inotify events; (b) `echo x > /tmp/probe` wrapper: 1 violation; (c) pipe mode (above). Trace non-empty each time. inotify positive control (touch) = 1 event. |
| Proof step 2, read-only root | **PASS** | `docker run --read-only`, no tmpfs or volumes, fixtures mounted read-only: 12 of 12 decodes succeed (6 inputs x file/memfd). Control: spill policy with `TMPDIR=/tmp` on a read-only root fails with `Read-only file system`. Caveat: Docker's default `/dev/shm` is still a writable tmpfs. |
| Proof step 3, inotify | **PASS** | file and memfd modes: 0 events over /tmp, /var/tmp, /dev/shm, /run, /var/lib, /var/cache, /root, /. Controls: 23,445 and 85 events. |
| Proof step 5, `RLIMIT_FSIZE=0` | **PASS** | `ulimit -f 0`: 12 MP and 50 MP decodes in file mode still succeed. Control: a shell write is killed by SIGXFSZ; pipe-mode spool and spill-policy decode die with rc 25. SIGXFSZ dumps core by default, so `LimitCORE=0` is needed. |
| Proof step 6, swap and core | **PARTIAL** | VmSwap 0 kB and VmHWM 302 MB during a 50 MP decode (this box's swap configuration unknown); `ulimit -c` 0. `kill -SEGV` and `coredumpctl` not run. |
| Proof steps 4 (as a systemd run), 7, 8; systemd directives; tunnel or proxy spool; EXIF-marker logging proof; `MemoryDenyWriteExecute` | **not run** | no systemd or VPS here; `cloudflared` not tested |

## 6. Deviations

1. The design's first `policy.xml` does not work (module and path rules). Replacement in the design doc. Every input must be fed as
   `<coder>:fd:0` from a seekable fd.
2. The `time` policy key is ignored; use `MAGICK_TIME_LIMIT` or `-limit time`, plus the service's own deadline. IM exits 0 on time-limit.
3. `rgb:fd:3` inside parentheses needs `-write`.
4. Resize: the design assumed `-filter Point` first. Measured, `-filter Point -resize` is worse than Lanczos on real photos; the
   faithful choice is `-define sample:offset=0 -sample`.
5. The design forced a 512x512 frame for all images; for images with both sides <= 512 the reference hashes native size and the
   forced frame costs 12 to 16 bits.
6. Alpha: the design said flatten on a recorded background; the reference-faithful choice is `-alpha off`.
7. Fixtures: 21 of the 27 photos are Commons thumbnails, not originals; three photos contain tiny incidental figures; only 6 are full-size originals.
8. **No TS port leg.** The port does not exist, so C5 (port equals reference on the IM frame) was not run.
9. Incident: while stopping the spike's own stuck downloader with a broad `docker kill`, three other local containers (a CI
   database and two development databases) were also stopped. They were restarted within about a minute and came back healthy;
   a CI run using the CI database container may have seen a dropped connection around 08:3x MST. Later container operations
   used `--name tjspike-*` and `--rm`.

## 7. Not run, not verified

TS PDQ port equality (C5); C7 WebP determinism; C8 low-quality share; C2 CPU in a Worker (out of scope here); latency p50/p95/p99
through a tunnel; any result on the VPS host (this ran on Docker Desktop WSL2); systemd hardening directives; `cloudflared`
spooling and proof steps 7 and 8; non-sRGB ICC handling; HEIC and TIFF; GIF/WebP with more than 4 frames and animated-WebP
demux failure behaviour beyond the 4-frame fixtures; process-group kill on deadline; `MemoryDenyWriteExecute`; per-package apt
pinning (the image is reproducible only from the base digest plus the repositories of that day); `kill -SEGV` and `coredumpctl`.

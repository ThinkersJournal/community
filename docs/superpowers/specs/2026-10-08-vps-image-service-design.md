# D7 (stateless ImageMagick VPS decoder) and D11 (post-launch recheck) — design

**Status:** Revision 1, 2026-10-08, PROPOSAL. The C3/C6 spike has NOT been run, no numbers exist. Docs only. Part of #114.
**Amends:** `2026-10-07-upload-scan-design.md` (revision 3). Its amendments are listed in section 8 below.

## Rulings

CireSnave, 2026-10-08 (the only words of his that this design quotes; the draft carried no longer quotation):

> "ImageMagick on my VPS to do image conversions"

CireSnave's later acceptance of multiple VPSes (section 7, item 3) is paraphrased in this design, not quoted.
D11 ruling, relayed by the PM: the recheck must exist and must not gate launch (section 6).

PM rulings, 2026-10-08:

1. All three transforms (the header and pixel-bound check, the 512x512 raw scan frame, and `toWebp`) move to ONE stateless
   VPS endpoint. There is no fallback decoder: the service fails closed.
2. Cloudflare Tunnel, application-level HMAC, and a Cloudflare Access service token are approved (sections 2.1 and 2.2).
3. New alarm U11 is approved (section 2.6).
4. A separate `decoder_credentials_refused` outcome is approved (section 2.6).
5. The D11 roadmap text already lives in `PORTFOLIO-ROADMAP.md`, which the PM owns. Section 6 points to it and does not
   repeat it.
6. Section 3.3 (what CireSnave must set up on the VPS) is NOT YET BOARDED. The PM boards it only after the spike passes.

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

**Move all three to one VPS endpoint: header inspection (`.info()` equivalent + pixel bound), the 512x512 raw scan frame,
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
info:{format,width,height,frames,animated}, stored:{width,height}, rgb_len:786432, webp_len:N, orientation_applied_to_webp:true }`.
Worker checks `rgb_len === 512*512*3` itself (spec `hasExpectedGeometry`, §3.3/§3.5), `webp_len > 0` (the existing
zero-byte guard, `images.ts:175`), the pixel bound (keep `exceedsPixelBound`, `images.ts:75`), and `decoder.build_id` +
`policy_sha256` against an allowlist (section 2.5).

Errors (JSON `{code}`): `invalid_image` (header unparseable/mismatch; **Worker -> existing 415**, `media.ts:77`),
`pixel_limit` (**-> existing 413**), `resource_limit` / `timeout` / `decode_error` after header parsed OK (**-> 503**, spec
§6.1 "decode failure, any kind"), `busy` (503 + `Retry-After`), `unauthorized` (**-> 503**, never shown to the user).
Anything non-JSON, non-2xx or unsigned -> 503. All Worker-visible user answers stay the spec's identical 415/413/503 bodies.

`GET /v1/health` (HMAC with empty body; also reachable by the tunnel's own probe via a separate unauthenticated
`/healthz` that returns only 200/503 and no build info). The authed health does a **real decode** of an embedded 1x1 PNG and
a policy self-check (`magick -list resource` must show `Disk: 0`, section 3.2), then returns `{ok, build_id, magick_version,
policy_sha256, uptime}`. 503 if any check fails, so a degraded box drops out of rotation.

### 2.4 Limits and timeouts

Body cap 15 MiB + 4 KiB (service-enforced while streaming, not trusting Content-Length). Response cap: rgb 786,432 + WebP
<= ~8 MiB (service aborts a larger WebP). Concurrency semaphore 2 (excess -> `busy`). IM `time` limit 10 s; service hard
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
current gate (`CF_VERSION_METADATA` version only) would not notice. Same four synthetic fixtures through `/v1/process`
(no HMS-A call). The `*/2` tick may also record a `/v1/health` result as a selftest row so a VPS outage with zero upload
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
- Pipeline (single IM process, one decode; syntax **UNVERIFIED**, spike confirms; fallback = two IM processes fed the same
  in-RAM buffer):
  `magick jpeg:- -auto-orient ( +clone -filter <F> -resize 512x512! -depth 8 rgb:fd:3 +delete ) -resize 2048x2048> -strip -quality 82 -define webp:method=4 webp:-`
  with `fd:3` an extra pipe the service reads. Flatten alpha onto a recorded background (`-background white -alpha remove
  -alpha off`; colour chosen and recorded by spike input 8). For the scan frame, `-auto-orient` is a **spike variable**
  (reference does not rotate; dihedral hashes cover both, spec §3.5): default OFF for the scan frame if C6 is better that
  way, ON for the stored WebP always.
- Must not use anything that spools: no `multipart`/form parsers, no framework body buffering to temp files, no nginx or
  other proxy in front with default `client_body_buffer_size` (it writes bodies over the buffer to `/var/lib/nginx`).
  Terminate in the service (the tunnel connects straight to it) or set `proxy_request_buffering off`.
- Go: do not call `ParseMultipartForm`; Python: no `tempfile`-backed uploads; Node: no `formidable`/`multer`.

### 3.2 Hardening, exact list

**`policy.xml`** (installed read-only; `MAGICK_CONFIGURE_PATH=/etc/tj-decoder/magick` so no user/system override can win).
Base = ImageMagick's own "secure" policy example, then tighten (key names are IM's policy keys; **values are proposals the
spike must validate against the installed IM version**):

```xml
<policymap>
  <policy domain="resource" name="disk"   value="0"/>       <!-- never spill; exceed memory => hard error (fail closed) -->
  <policy domain="resource" name="memory" value="512MiB"/>
  <policy domain="resource" name="map"    value="0"/>       <!-- UNVERIFIED: 0 may break; else equal to memory -->
  <policy domain="resource" name="area"   value="128MP"/>   <!-- > MAX_PIXELS 50MP with room for the 2x working copy -->
  <policy domain="resource" name="width"  value="16KP"/>
  <policy domain="resource" name="height" value="16KP"/>
  <policy domain="resource" name="time"   value="10"/>      <!-- seconds -->
  <policy domain="resource" name="thread" value="2"/>
  <policy domain="resource" name="list-length" value="64"/>
  <policy domain="resource" name="file"   value="64"/>
  <policy domain="cache"  name="memory-map" value="anonymous"/>   <!-- no file-backed pixel cache -->
  <policy domain="cache"  name="synchronize" value="false"/>
  <policy domain="system" name="shred"    value="0"/>
  <policy domain="coder"    rights="none"       pattern="*"/>
  <policy domain="coder"    rights="read|write" pattern="{JPEG,PNG,GIF,WEBP,RGB}"/>   <!-- RGB: raw out; confirm needed in/out -->
  <policy domain="delegate" rights="none" pattern="*"/>
  <policy domain="filter"   rights="none" pattern="*"/>
  <policy domain="module"   rights="none" pattern="*"/>   <!-- UNVERIFIED: breaks module-built coders; use per-coder instead if so -->
  <policy domain="path"     rights="none" pattern="@*"/>  <!-- no @file indirection -->
  <policy domain="path"     rights="none" pattern="*"/>   <!-- UNVERIFIED: must still allow "-" and fd:N; spike -->
</policymap>
```
Environment: `MAGICK_TEMPORARY_PATH=/nonexistent`, `TMPDIR=/nonexistent`, `HOME=/nonexistent`, `MAGICK_TIME_LIMIT=10`. Decoder
options pinned for determinism: `-define jpeg:dct-method=islow`, `-define webp:thread-level=0`; never `jpeg:size=` (scaled
decode changes pixels, only as a measured performance option).

**systemd unit** (VPS runs it; we ship the unit file in the repo):
`User=tjdecode` (dedicated, no shell, no home), `DynamicUser=yes` acceptable; `NoNewPrivileges=yes`; `CapabilityBoundingSet=`
(empty); `AmbientCapabilities=`; `ProtectSystem=strict`; `ProtectHome=yes`; `PrivateTmp=yes`; `PrivateDevices=yes`;
`ReadWritePaths=` **(empty: nothing writable)**; `TemporaryFileSystem=/var:ro`; `ProtectProc=invisible`; `ProcSubset=pid`;
`ProtectKernelTunables/Modules/Logs/ControlGroups/Clock=yes`; `RestrictNamespaces=yes`; `RestrictAddressFamilies=AF_INET
AF_INET6 AF_UNIX`; `RestrictRealtime=yes`; `LockPersonality=yes`; `MemoryDenyWriteExecute=yes` (**UNVERIFIED** vs IM/libwebp
SIMD JIT: none expected, spike); `SystemCallFilter=@system-service` with `~@privileged @resources @mount`; `SystemCallArchitectures=native`;
`LimitCORE=0`; `MemoryMax=2G`; `MemorySwapMax=0` (**the unit forbids swapping this service**); `TasksMax=64`; `CPUQuota=200%`;
`IPAddressDeny=any` + `IPAddressAllow=` the tunnel/loopback only; `StandardOutput=null` for the IM children (service logs
only its own fixed-format lines to journald); `UMask=0077`; `PrivateNetwork` not usable (it must accept requests).
**Process isolation for IM itself:** spawn IM as a child with its own seccomp/`prlimit` (`RLIMIT_FSIZE=0` is a cheap,
kernel-level "this process can write no file" belt; verified by section 4), `RLIMIT_CORE=0`, `RLIMIT_AS`, `RLIMIT_CPU`.

**Host settings** (CireSnave's machine; this repo cannot enforce them): swap **off** (`swapoff -a`, remove from fstab) or
encrypted swap (`cryptsetup` random-key swap) — `MemorySwapMax=0` is the per-service control but a host with
ordinary swap can still page *other* processes' memory containing... only this service's pages matter, and the unit stops
those; still recommend swap off on the box; `kernel.core_pattern=|/bin/false` and `fs.suid_dumpable=0`; `systemd-coredump`
disabled/`Storage=none`; no crash reporter (apport etc.); journald: this unit's `LogLevelMax=notice`; no request/body/URL
logging in the service, the tunnel (`cloudflared --loglevel warn`, no access logs), or any fronting proxy; no backup/
snapshot of `/proc`-style memory; unattended-upgrades for IM/libjpeg/libwebp (the decoder faces hostile bytes); firewall
default-deny inbound; the container (if used) as `--read-only`, no volumes, `--tmpfs` **not** used (tmpfs is RAM, can swap),
`--cap-drop=ALL --security-opt no-new-privileges --pids-limit 64 --memory-swap == --memory`.

### 3.3 What this repo can and cannot enforce (NOT YET BOARDED)

**NOT YET BOARDED:** the PM boards the ops items below for CireSnave only after the spike passes. Nothing here is yet a request to him.

Repo can enforce: the service code, `policy.xml`, systemd unit, container build (pinned base digest, IM version), the
Worker client, the HMAC contract, the proof tests (run by the PR author and, on a Linux GitHub runner, by CI), the
self-test, the allowlist of `build_id`/`policy_sha256`. Repo **cannot** enforce, so CireSnave/ops must set up and attest:
swap off/encrypted; core dump settings; VPS firewall; that `cloudflared`/proxy do no logging or body spooling; unattended
upgrades; backups/snapshots that exclude memory; hypervisor-level live-snapshot policy of the hosting provider (a provider
snapshot can capture RAM: residual risk, **name it in the legal draft, spec §10.3 style**); the tunnel + Access policy;
secret handling for the HMAC key. Provide an **ops checklist with a `verify-host.sh`** that prints each setting's current
value (read-back, not assumption) for CireSnave to run and paste.

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

The spec's US0 spike used a throwaway Worker with the Images binding (spec §2.4). Replace it with a **throwaway container
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

**C3 re-expressed (decode shape), per input of spec §2.4 list items 1-8:** output exactly `512*512*3` bytes for JPEG, PNG,
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
Sweep IM `-filter` in {Point, Box, Triangle, Mitchell, Lanczos} x auto-orient {off,on}. `Point` is the first candidate: if
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
5. **[UNVERIFIED]** Every `policy.xml` value/key behaviour (esp. `map 0`, `path *` vs stdin/`fd:N`, `module` domain, `coder`
   pattern syntax, `cache memory-map anonymous` existing in the installed IM version). Spike + section 4 test 4 settle it.
6. **[UNVERIFIED]** Single-pass `rgb:fd:3` pipeline, animated-WebP read, `MemoryDenyWriteExecute` compatibility, whether
   `cloudflared` body-spools to disk, whether the 50 MP decode fits `memory 512MiB` (it may need ~1 GB; the failure is closed,
   so it is a tuning question, not a safety one).
7. **[UNVERIFIED]** Reference PDQ's actual loader/resampler; the spec's CImg-nearest claim is secondhand (spec §3.1: "reported
   by the audit... unchecked"). C6 outcome could be excellent with `-filter Point` or poor; unknown until run.
8. **[Behaviour change]** IM re-encode will not byte-match Cloudflare's WebP for the same upload; old objects stay as stored.
   Colour management: applying an embedded ICC profile needs an sRGB ICC file on disk (read-only is fine); otherwise
   `-colorspace sRGB` only. Decide in the spike which is acceptable visually; the old binding applied profiles
   (`images.ts:146-147`).
9. **[Ordering change]** Quota check moves ahead of the decoder call (section 1); the pixel-bomb 413 is now produced by the
   VPS. Both keep user-visible bodies identical to today's.
10. **[Not read]** I did not read the rev-3 CSAM reporting spec, the #114 plan, or HMS-A's API document (the spec cites them);
    D11's "list version" source and 8-hash call shape rest on the upload-scan spec's description only.

---

## 8. Amendments this design makes to the upload-scan spec (revision 4 material)

Applied in `2026-10-07-upload-scan-design.md`:

- Section 11.1 gains alarm U11 (decoder identity drift), and U7 (Images allowance) goes dead once the binding is removed.
- Sections 6.1 and 6.6 gain the reason `decoder_credentials_refused`. It is a new value of the free-text `reason` column. The
  `outcome` CHECK (`scanned`, `unavailable`) is unchanged, so no schema change is needed.
- Sections 2 and 3.3 note that the decoder seam's production implementation is the VPS service. The binding-based text stays and
  is marked superseded by this document.

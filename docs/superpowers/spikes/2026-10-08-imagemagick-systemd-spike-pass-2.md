# D7 second-pass spike: systemd unit, no-disk proof on the unit, logging proof, C7, C8, quick tunnel, latency, VPS checklist

**Date:** 2026-10-08. **Part of #114.** Second pass of `2026-10-08-imagemagick-pdq-spike.md` (pass 1). Evidence for
`../specs/2026-10-08-vps-image-service-design.md` (revision 3). Provider named only as HMS-A. Benign fixtures only (the pass-1
fixtures plus fixtures derived from them). No HMS-A call, no database, no account. Fixtures, binaries and raw outputs are not
committed; the spike author kept them locally.

**Read this first.** Everything below was measured inside a **throwaway WSL2 distro** (`tjspike2-systemd`: Debian 13 userland from
the pass-1 image, **real systemd 257.13**, kernel 6.18.33.1-microsoft-standard-WSL2, cgroup v2; the host has 8 GiB swap and 32
cores). **This is not the VPS.** Section 8 lists what only the VPS can show. It is not a pass of the whole design.

## Summary

| # | item | result |
|---|---|---|
| 1 | hardened unit runs the 6 inputs; `systemd-analyze security` | **PASS** (exposure 0.5 SAFE; all 6 inputs 200, WebP sizes equal to pass 1). One directive **FAIL**: unit-level `LimitFSIZE=0` breaks the wrapper (EFBIG writing the memfd); moved to the IM child only (PASS) |
| 2a | strace on the running unit, 6 inputs | **PASS**, 0 violations. The pass-1 checker had a blind spot, fixed here |
| 2b | inotify on the unit's writable paths | **PASS**, 0 events from 6 requests (positive control: 2 events on touch) |
| 2c | read-only-everything run | **PASS** (6/6, 0 violations, 0 events) after tightening: the unit as first written still had writable `/tmp`, `/var/tmp` (disk-backed ext4 here), `/dev/shm`, `/run` |
| 2d | negative controls | **PASS**: pipe-stdin, spill policy and probe write each flagged as predicted |
| 2e | VmSwap 0 and `MemorySwapMax` | **PASS** with control (193 MiB swapped without `MemorySwapMax=0`; oom-kill with it) |
| 2f | `kill -SEGV` leaves no core with `LimitCORE=0` | **PARTIAL / NOT DEMONSTRATED**: no core and no coredumpctl entry, but the positive control (`LimitCORE=infinity`) ALSO produced none on this kernel, so the absence proves nothing. The kernel did invoke the pipe handler even with limit 0 |
| 2g | oversize decode fails closed | **PASS** (area and width bombs 422 in under 0.15 s; `MemoryMax=200M` OOM-kills and the client gets a dropped connection; the policy memory limit gives a clean 422) |
| 3 | EXIF/COM marker logging proof | **PASS** (0 hits everywhere; positive controls found) |
| 4 | C7 WebP determinism | **PASS for the ImageMagick pipeline** (65/65 byte-identical across 2 processes, 2 containers, thread limits 1 and 8). Not evidence about Cloudflare's Images binding |
| 5 | C8 share of PDQ quality <= 49 | fixtures: real photos 0/27, photo-derived variants 0/29, synthetic 6/10; 120 generated non-photographic images: 34 at quality <= 49 (generated, not a screenshot corpus; not a launch estimate). Not pass/fail |
| 6 | cloudflared quick tunnel, 21 MiB POST | **PASS (no body written to disk by cloudflared or the wrapper)**; torn down. Quick tunnel only |
| 7 | latency | measured, **local only** (section 7) |
| 8 | unprovable list | section 8 |

## 1. The unit (task 1)

Test wrapper (harness only, not the product): Python standard-library HTTP server. It reads the body into RAM, creates a memfd,
runs one `magick` process (the approved pipeline: single pass, `-write rgb:fd:3` in parentheses) with `stdin` = the memfd
(seekable), reads the scan frame from an extra pipe and the WebP from stdout, treats **any stderr or non-zero exit as failure**
(422), has a 20 s deadline, runs the child in its own session, and frames the response as `u32be headerLen | header JSON | rgb |
webp`. Native size is used when both sides are <= 512, with explicit dimensions in the header. Stored WebP options:
`-auto-orient -resize 2048x2048> -strip -quality 82 -define webp:method=4 -define webp:thread-level=0`. The wrapper's dimensions
came from its own header parser (harness only); the product must take them from the same decode.

Unit: socket-activated (`ListenStream=127.0.0.1:8088`, passed in as fd 3), so the service runs with **`PrivateNetwork=yes` and
`RestrictAddressFamilies=AF_UNIX`** and still serves requests. Directives: `DynamicUser=yes`, `NoNewPrivileges`,
`CapabilityBoundingSet=` and `AmbientCapabilities=` empty, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`,
`PrivateDevices=yes`, `ReadOnlyPaths=/opt/tj`, `InaccessiblePaths=/mnt /root /home /boot /srv /media`,
`TemporaryFileSystem=/var:ro`, `ProtectProc=invisible`, `ProcSubset=pid`, `ProtectKernel{Tunables,Modules,Logs}`,
`ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`,
`LockPersonality`, **`MemoryDenyWriteExecute=yes`** (works with the wrapper's Python, ImageMagick, libjpeg/libpng/libwebp and
OpenMP), `SystemCallFilter=@system-service` then `~@privileged @resources @mount`, `SystemCallArchitectures=native`,
`LimitCORE=0`, `LimitFSIZE=32MiB`, `MemoryMax=2G`, `MemorySwapMax=0`, `TasksMax=64`, `CPUQuota=200%`, `LogLevelMax=notice`,
`UMask=0077`. The ImageMagick policy is pass 1's working policy, installed at `/opt/tj/magick/policy.xml` and selected with
`MAGICK_CONFIGURE_PATH`.

`systemd-analyze security`: **overall exposure 0.5 SAFE**, 76 checks pass. The five that do not: `RootDirectory=/RootImage=`
(0.1), `RestrictAddressFamilies=~AF_UNIX` (0.1, needed for the passed-in socket and the journal), `PrivateUsers=` (0.2),
`DeviceAllow=` (0.1, char-rtc:r), `IPAddressDeny=` (0.2, moot with `PrivateNetwork`).

Six inputs through the unit (same bytes as pass 1; p05 WebP 363,258 B as in pass 1):

| input | format, dims | HTTP | scan frame | stored WebP | latency (cold first call) |
|---|---|---|---|---|---|
| p05.jpg | jpeg 4000x3000 | 200 | 512x512 (786,432 B) | 363,258 B | 1.78 s |
| d_alpha.png | png 1200x900 | 200 | 512x512 | 226,494 B | 0.74 s |
| d_anim.gif | gif 400x300, 4 frames | 200 | 400x300 native (360,000 B) | 11,394 B | 0.06 s |
| d_lossy.webp | webp 2000x1329 | 200 | 512x512 | 106,750 B | 0.56 s |
| s_50mp.png | png 7071x7071 | 200 | 512x512 | 36,544 B | 3.97 s |
| s_50mp.jpg | jpeg 7071x7071 | 200 | 512x512 | 38,796 B | 3.00 s |

**Directive findings**
- **`LimitFSIZE=0` on the unit: FAIL.** Every request failed with `OSError: [Errno 27] File too large` when the wrapper wrote
  the body into the memfd (RLIMIT_FSIZE applies to memfd/shmem files). Fix tested: unit `LimitFSIZE=32MiB` (at least the 24 MiB
  body cap; it also bounds any spill, section 2d) and `RLIMIT_FSIZE=0` set **on the IM child only** in the wrapper's
  `preexec_fn`. The IM child shows `Max file size 0 0` and `Max core file size 0 0` in `/proc/PID/limits`; the six inputs still
  pass. `setrlimit` is blocked by `~@resources`, but glibc uses `prlimit64`, which `@system-service` allows.
- **`LogLevelMax=notice` hides stderr lines written without a priority prefix** (they count as `info`). The first startup
  failure (a traceback) was invisible in the journal until the limit was lifted. The wrapper must write `<5>`/`<4>` sd-daemon
  prefixes, and a crash of the wrapper itself will not show at `notice` unless it logs at that level.
- The standard-library threaded HTTP server creates an AF_INET socket in its constructor, which `RestrictAddressFamilies=AF_UNIX`
  kills; the wrapper adopts the passed-in fd instead.
- `PrivateTmp=yes` is not enough for "nothing writable" (section 2).

## 2. No-disk proof against the unit (task 2)

Method. The unit is socket-activated. `strace -f -y -s 256 -p MainPID` with the open, create, mkdir, rename, link, symlink,
truncate, fallocate, memfd_create, mmap, write, pwrite64, writev, sendfile, copy_file_range and unlink families is attached from
outside (it follows the Python threads and every `magick` child). The 6 inputs are driven and checked with a checker script that
allows the memfd. inotify runs **inside the unit's mount namespace** (`nsenter -m -t PID inotifywait -m -r /tmp /var/tmp /dev/shm
/run /var /opt/tj`) and, for the `PrivateTmp` case, also on the host-side private tmp dir. Every run shows the trace line count (an
empty trace cannot pass) and a positive control.

**Checker blind spot found and fixed.** The pass-1 checker's regex for `openat` did not match `strace -y` output
(`openat(AT_FDCWD</>, "path", ...)`): `readonly_opens` was 0 on a trace with 332 opens. So pass 1's open-for-write leg never
fired. Its write-target leg (`write(fd<path>)`) was sound and its negative controls fired on that leg, so the pass-1 conclusion
stands, but the openat leg was untested. Fixed (332 read-only opens now counted on the base trace); self-test: a synthetic
`openat(AT_FDCWD</>, "/tmp/magick-XYZ", O_RDWR|O_CREAT|O_EXCL...)` line is flagged (rc 1). All numbers below use the fixed checker.

| case | what it is | trace lines | opens (ro) | write targets | violations | inotify events (6 requests) | 6 inputs |
|---|---|---|---|---|---|---|---|
| **base** | unit as in section 1 | 2,576 | 332 | memfd 37, pipe 1,060, socket 6, memfd_create x6 | **0** | **0** (positive control: touch gave 2) | 6x 200 |
| **ro** | `PrivateTmp=no`, `TemporaryFileSystem=/tmp:ro /var:ro /var/tmp:ro /run:ro`, `InaccessiblePaths=/dev/shm` | 2,578 | 332 | same | **0** | **0** (control: /tmp not touchable, as expected) | 6x 200 |
| neg_pipe | anonymous-pipe stdin + `IMTMP=/tmp`, child FSIZE not 0 | 10,327 | 354 | `/tmp/magick-*` files (including the JPEG's own bytes) | many (open O_RDWR\|O_CREAT\|O_EXCL plus write-to-file) | **85** (+2 control) | 5x 422, gif 200 |
| neg_spill | spill policy (disk 1 GiB, memory/map 64 MiB), `IMTMP=/tmp` | 1,829 | 302 | `/tmp/magick-*` | open-write, write and unlink flagged | **9** (+2) | 3x 422 (the large ones), 3x 200 |
| neg_probe | wrapper does `open('/tmp/probe','w').write('x')` per request | 2,586 | 332 | `/tmp/probe` x6 | **12** (6 opens + 6 writes = exactly the 6 requests) | **12** (+2) | 6x 200 |
| belt_spill | spill policy + child `RLIMIT_FSIZE=0` | 1,828 | 302 | as neg_spill | flagged | 9 (+2) | 3x 422: the belt stops the large spill (EFBIG); the attempt is still flagged |

In neg_spill the unit-level `LimitFSIZE=32MiB` alone already stopped the 72 MB and 300 MB spill files (`pwrite64(...) = -1
EFBIG`); the checker flagged the open, pwrite and unlink anyway.

**What is writable in the unit's mount namespace** (`nsenter -m -t PID findmnt` plus root `touch` probes; only a read-only mount
stops root). Base unit: `/tmp` (tmpfs here, **disk on many VPS images**), **`/var/tmp` = ext4 (disk-backed)**, `/dev/shm` (tmpfs),
`/run`; probes: `WRITABLE /tmp;/var/tmp;/dev/shm;/run`. That is what `PrivateTmp=yes` plus `ProtectSystem=strict` leave. In the `ro`
case the probes read `ro/denied` for `/ /tmp /var /var/tmp /dev /dev/shm /run /opt/tj /etc /home /root /srv /usr`; the only
read-write mounts left are `/dev/pts /dev/mqueue /dev/hugepages /proc`, a `memory.pressure` file under the cgroup tree,
`/sys/fs/selinux`, and a covered `/tmp`. **The `ro` directives belong in the shipped unit.** (`DynamicUser=yes` forces a private
tmp even with `PrivateTmp=no`; the `TemporaryFileSystem=...:ro` overlay on `/tmp` and `/var/tmp` is what makes them read-only.)

### 2e. VmSwap and MemorySwapMax
- During 3 x 50 MP PNG decodes, sampling every 50 ms: 238 samples of the unit's cgroup processes (115 of the `magick` child):
  **max VmSwap 0 kB**, peak sampled RSS 412 MB, cgroup `memory.peak` 482,664,448 B, `memory.swap.peak` 0, `memory.max` 2 GiB,
  `memory.swap.max` 0.
- That alone could be 0 because the box never swapped it. **Control** (own transient units `tjspike2-swap-*`, 380 MiB touched
  under `MemoryMax=200M`): without `MemorySwapMax` the process survived with **VmSwap 195,852 kB** and `Memory peak: 200M (swap:
  193.2M)`; with `MemorySwapMax=0` it was **oom-killed** (`Finished with result: oom-kill`, `swap: 0B`, VmSwap 0 throughout). The
  directive is effective on this host, which has 8 GiB of swap.

### 2f. `kill -SEGV` and core (PARTIAL, NOT DEMONSTRATED)
- `/proc/PID/limits`: service `Max core file size 0`; its IM child `Max core 0` and `Max file size 0`.
- SEGV to the service MainPID and to an in-flight `magick` child: unit state `failed` (service) / `422` to the client with the
  service still active (child). `coredumpctl list`: "No coredumps found." `/var/lib/systemd/coredump`: empty. `find / -xdev -name
  'core*' -newer stamp`: nothing.
- **Not demonstrated:** the positive control (a transient unit with `LimitCORE=infinity` killed by SEGV) ALSO produced no dump and
  no coredumpctl entry. `dmesg` shows `coredump: PID(python3): |/usr/lib/systemd/systemd-coredump pipe failed` for the service
  (limit 0), the magick child, `sleep` with `LimitCORE=0` and `sleep` with `LimitCORE=infinity`: the WSL2 kernel cannot run the
  pipe handler here, so no dump can occur in any case. `kernel.core_pattern` is global to the whole WSL2 VM (shared with the Docker
  Desktop distro) and was not changed, so a file-pattern control was not possible.
- **What the dmesg lines do show:** with a pipe `core_pattern`, the kernel invokes the handler even when `RLIMIT_CORE` is 0 (all
  four processes). `LimitCORE=0` is therefore not enforced by the kernel in that configuration; the handler has to refuse. That is
  why the host `core_pattern` check in section 8 is mandatory, not a belt.

### 2g. Oversize decode
- 144 MP (12000x12000) and 400 MP (20000x20000, 431 KB file) PNGs: HTTP 422 in 0.09 s and 0.14 s; cgroup `memory.peak` 15 MB and
  31 MB; service stays `active`; no output bytes.
- 50 MP PNG under `MemoryMax=200M` + `MemorySwapMax=0`: the client got `RemoteDisconnected` (no response, no partial output).
  `memory.events: max 37 oom 1 oom_kill 1`, `swap.peak 0`; the journal says "A process of this unit has been killed by the OOM
  killer"; unit `Result=oom-kill`, `ActiveState=failed`. **The OOM killer took the wrapper (the main process), not just the
  decoder**, so every concurrent request dies with it. The socket unit re-activated the service for the next request (p24.jpg:
  200). Fail-closed holds, but a cgroup OOM is not a per-request failure.
- Policy-level (`MAGICK_MEMORY_LIMIT=64MiB`, `disk 0`): clean `422`, `memory.events oom 0`. **Keep IM's own memory limit below
  `MemoryMax` so an oversize decode ends as an IM error, not an OOM kill of the whole service.**

## 3. EXIF marker logging proof (task 3)

Marker `TJ-MARKER-` plus 24 random hex characters (fresh per run). Inputs: a valid JPEG with the marker in EXIF ImageDescription,
Artist and COM; the same truncated at 60,000 B (IM warns, so 422); a PNG with the marker in tEXt and a Description; a non-image
text file (422 unsupported); a bad GIF containing the marker (422). Each file contains the marker once. The 3 valid decodes
returned 200, the 3 bad ones 422.

Searched after the run: `journalctl -a -o verbose` (all units, kernel included), the unit's own journal, `dmesg`, `grep -r -a -l`
over `/var/log /var/tmp /tmp /dev/shm /run /var/lib/systemd /var/cache /etc /opt`, the unit's host-side private tmp dir, and `/tmp
/var/tmp /dev/shm` inside the unit's mount namespace; also the returned WebP bytes (was the marker stripped?).

| run | journald (all) | unit journal | dmesg | files with marker | marker in returned WebP |
|---|---|---|---|---|---|
| approved unit | **0** | **0** | **0** | **none** | 0 |
| POSITIVE CONTROL: wrapper deliberately logs it | 1 | 1 | 0 | the system journal file | n/a |
| control for the greps: `logger` plus a file in `/var/tmp` | 2 | 1 | 0 | journal and the `/var/tmp` file | n/a |

**PASS.** The wrapper logs only fixed-format lines (`req ok in= out= ms=` / `req fail class=`) and discards IM's stderr instead of
logging it. Caveats: (a) the journal here is persistent, so anything logged would have hit disk; (b) IM's stderr was never logged,
so whether IM echoes metadata in its warnings was not tested; (c) raw journal files are compressed for large objects, so the check
used `journalctl` output, not `grep` on the journal files.

## 4. C7: WebP determinism (task 4)

Inputs: the 66-file set; 65 decode (200); `d_rgb16.png` is rejected (422, section 5). Pinned: `-auto-orient -resize 2048x2048>
-strip -quality 82 -define webp:method=4 -define webp:thread-level=0`; IM 7.1.1-43 (`8:7.1.1.43+dfsg1-1+deb13u12`), libwebp7
1.5.0-0.1, libjpeg62-turbo 1:2.1.5-4, libpng16-16t64 1.6.48-1+deb13u6 (identical in the container and the distro). Policy `thread
2`. Each comparison is a per-file SHA-256 of the stored WebP and of the scan frame.

| comparison | files | WebP differing | scan frame differing |
|---|---|---|---|
| distro unit run 1 vs run 2 (separate process instances, restarted) | 65 | **0** | **0** |
| run 1 vs `MAGICK_THREAD_LIMIT=1` | 65 | **0** | **0** |
| run 1 vs `MAGICK_THREAD_LIMIT=8 OMP_NUM_THREADS=8` | 65 | **0** | **0** |
| two simultaneous containers from the pass-1 image | 65 | **0** | **0** |
| container vs distro unit (different host layer) | 65 | **0** | **0** |

**C7 PASS for this pipeline.** The spec's C7: "the WebP encoder is deterministic: the same original bytes, transformed twice, give
the same SHA-256"; if it fails, the WebP-key lookup (spec §5.3) is dropped. **Limits, stated exactly:** (1) the spec's C7 is about
`toWebp`, i.e. the Cloudflare Images binding at `images.ts:161`; D7 replaces that with this ImageMagick pipeline, so this answers
C7 for the VPS design only. **It says nothing about the Cloudflare Images encoder; C7 for the binding itself is NOT RUN** (it
needs a Cloudflare account). (2) All runs used the same ImageMagick/libwebp build on the same CPU family. NOT tested: other CPUs
(libwebp has SIMD paths), other ImageMagick/libwebp versions. A WebP-key lookup must therefore be keyed with the decoder
`build_id`, and rows written before a decoder upgrade will not match. (3) It was not isolated whether `-define
webp:thread-level=0` matters; results are identical with it pinned.

## 5. C8: share of PDQ quality <= 49 (task 5)

Method: a throwaway container from the pass-1 image; each file goes through the approved scan-frame pipeline (native size when both
sides are <= 512; `[0]` for GIF/WebP), then the reference PDQ core (`facebook/ThreatExchange` `85978d7`) reports quality.

| group | n | quality <= 49 | share | note |
|---|---|---|---|---|
| real photos (p01-p27) | 27 | 0 | **0%** | all quality 100 |
| photo-derived variants (formats, EXIF orientation, alpha, animated, 16-bit) | 29 | 0 | 0% | **1 not measured**: `d_rgb16.png` is rejected by the stderr rule |
| synthetic fixtures (s_*) | 10 | **6** | 60% | q=0: s_1x1, s_flat, s_gradient; q=44: s_5x10000; **q=35: s_50mp.png and s_50mp.jpg (the spec's own input 2, gradients plus sparse noise)**; q=100: s_checker, s_noise, s_text; q=68: s_10000x5 |
| all fixtures | 66 | 6 | 9.1% | misleading: it is not a screenshot corpus |
| **generated non-photographic corpus** (the spike's seeded generator, 120 images; caveat below) | 120 | **34** | n/a | generated non-photographic images, not a screenshot corpus; not a launch estimate. By kind below |

Generated corpus by kind (generated, not a screenshot corpus, not a launch estimate; quality <= 49): text screenshots light 0/20, dark 0/15; bar charts 0/15; line charts 2/15 (13%);
diagrams (boxes and lines) 4/15 (27%); UI mocks 4/15 (27%, quality 34 to 89); flat logos (1 to 4 flat shapes on a flat colour)
14/15 (93%); gradient banners 10/10 (100%, quality 0).

**Caveat, stated exactly: this corpus is the spike's own generator (ImageMagick draw primitives), NOT real screenshots. It brackets
the range (text and charts with detail are fine, large flat areas are not) but is not an estimate of the real rate. The 34 of 120
count is from a generated non-photographic set, not a screenshot corpus, and is not a launch estimate.** The spec's input 10 (at least 100 public-domain or
synthetic non-photographic images, each listed with its source) is not met; the real C8 still needs a real-world corpus.

What the spec says happens to them (spec C8, §6.1 and its error table): a hash with quality <= 49 (Meta's discard threshold) is
never sent to the hash-only endpoint. With the bytes fallback **off** (the default) the upload is refused with **422
`IMAGE_UNSCANNABLE`** ("That image can't be checked, so it can't be uploaded. Try a different image.", D13), counted and alarmed as
`unscannable` (U6). With the flag **on**, the image bytes (including embedded metadata) go to HMS-A's media endpoint, and U8 raises
on every tick that saw a use. C8 itself is "measured, not pass/fail": the rate is reported to the PM with D13.

**Second finding for the same decision (decode rejection):** the "any non-empty stderr is failure" rule rejected `d_rgb16.png` (a
16-bit PNG derived from p01 with an embedded ICC profile): `magick: iCCP: profile 'icc': 0h: PCS illuminant is not D50`. IM exits 0
and the frame is fine; the wrapper returns 422. That is 1 of 66 fixtures (1.5%); p01 itself (JPEG, same odd profile) decodes
without a warning. A real user photo with a quirky PNG ICC profile would be refused as undecodable, behind the same "decode
failure" row of the spec (§6.1), not C8. Options for the PM: allow-list known-benign warnings, or accept the false-reject rate.
Not decided in the spike.

## 6. cloudflared quick tunnel (task 6)

- Binary: `cloudflared-linux-amd64`, version **2026.10.0** (built 2026-10-05 17:37 UTC), fetched from the GitHub release. **Its
  SHA-256 `d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db` equals the checksum published in the release notes**
  (read from the GitHub API body). Run from `/opt/cf` with `HOME=/srv/cfwork/home`, cwd `/srv/cfwork/cwd`, `--no-autoupdate`.
- Topology: Windows host `curl.exe` -> a random `trycloudflare.com` quick-tunnel name -> Cloudflare edge -> cloudflared (in the
  distro, started under `strace -f`) -> `http://127.0.0.1:8088` (the hardened unit, strace attached to it). The precheck reported
  QUIC failing on this network, so cloudflared used **HTTP/2**.
- Requests: GET (200); POST of a 3300x3300 noise JPEG (**22,006,271 B = 20.99 MiB**): HTTP 200, 3,107,106 B back, 56.7 s total
  (upload-bound on a home line: the wrapper's own time was 46 s for receive plus about 3 s processing); POST of the same image with
  a tunnel-specific marker in EXIF/COM (22,006,425 B): 200, 62.5 s. Responses are byte-correct: the scan-frame and WebP hashes equal
  a direct local call, and both tunnel responses are identical to each other.
- Disk checks:
  - cloudflared, `strace -f -y` over 9,662 lines: write targets are `socket` 5,812 writes (43,162,615 B, the two ~22 MB bodies moving
    through sockets), `anon_inode` (eventfd) 2,489 writes (19,912 B), and the spike's own stdout/stderr redirect file 43 writes
    (5,947 B, cloudflared's log). **0 write-capable `open`/`creat` of any path; 0 mkdir/rename/unlink/truncate/fallocate.** Not
    traced for cloudflared: `mmap` (a shared writable mapping was not checked) and RAM buffering size.
  - wrapper under the same two requests: 1,659 lines (172 read-only opens), writes only memfd 63 / pipe 582 / socket 3, **0
    violations**.
  - inotify on the cloudflared cwd and home, `/tmp`, `/var/tmp`, `/dev/shm`: **0 events** during the POSTs (the 6 lines in the
    file are two touch/delete controls, 3 events each, from before the POSTs).
  - `ls -la` of those directories before and after: identical except the mtime of `/tmp` itself (the control touch). New regular
    files since the pre-run snapshot (whole filesystem, excluding the journal and the spike's own work dirs): none. Home and cwd
    empty.
  - Marker through the tunnel: hits in cloudflared's log 0, in its strace payload prefixes 0, journald 0, dmesg 0, files 0.
    cloudflared at its default log level logged nothing per request (43 startup lines, 5,947 B total).
- Teardown: the cloudflared process the spike started (PID checked as `comm=cloudflared`) was killed; the log shows "Tunnel server
  stopped / Metrics server stopped"; 0 cloudflared, strace or inotifywait processes remain; after teardown the tunnel URL answers
  **HTTP 530**; no listener on 8088 or the metrics port in the distro or on Windows (`netstat`); no cloudflared process on
  Windows (`tasklist`).

**What a quick tunnel does not prove about a named tunnel in production:** (1) a named tunnel has credentials and config on disk
(`~/.cloudflared/*.json`, `config.yml`, an origin cert if `cloudflared tunnel login` was used) and its own unit, user and flags
(`--loglevel`, `--logfile`, `--transport-loglevel`, metrics, auto-update), none of which was exercised; (2) the transport
differed (HTTP/2 fallback here; production may use QUIC with different buffering); (3) whatever the Cloudflare edge does is
invisible from the origin (TLS terminates there, so bodies are plaintext inside Cloudflare; request metadata is in Cloudflare
analytics, Logpush and Access logs; WAF and size limits); (4) a quick-tunnel name is anonymous and has no Access policy or service
token, so authentication and the HMAC contract through Access were not exercised; (5) cloudflared's own memory use for 15 MB
bodies, concurrent requests, and behaviour under restart or disk-full were not measured; (6) the proof is for binary version
2026.10.0 only; (7) the Worker as the client (fetch from Cloudflare's network, not a home line) was not used, so the 47 to 62 s
upload time says nothing about production latency.

## 7. Latency (task 7)

**Local only: Ryzen 9 7940HX, WSL2, unit capped at `CPUQuota=200%`, `thread 2` policy, client in the same distro over loopback; not
representative of the VPS, the tunnel or Cloudflare.** 20 sequential runs per input; wall time of the whole HTTP request (receive,
memfd, decode, WebP encode, frame, response).

| input | format, dims | p50 | p95 | max |
|---|---|---|---|---|
| photo4mp.jpg (4 MP photo, 751 KB) | jpeg 2400x1667 | 662 ms | 718 ms | 725 ms |
| p05.jpg (12 MP photo) | jpeg 4000x3000 | 1,250 ms | 1,308 ms | 1,322 ms |
| d_alpha.png | png 1200x900 | 503 ms | 544 ms | 562 ms |
| d_anim.gif | gif 400x300 | 49 ms | 60 ms | 63 ms |
| d_lossy.webp | webp 2000x1329 | 425 ms | 460 ms | 467 ms |
| s_50mp.png | png 7071x7071 | 2,932 ms | 3,233 ms | 5,324 ms |
| s_50mp.jpg | jpeg 7071x7071 | 2,622 ms | 2,715 ms | 2,723 ms |

Rule of thumb from these: roughly 100 ms per megapixel of JPEG at this quota, one request at a time. One 50 MP decode peaks the
cgroup at about 480 MB.

## 8. What remains unprovable without the VPS (owner's setup checklist)

Each item: the command to run on the VPS as root and the output that proves it, run after the service and tunnel are installed.
(A `verify-host.sh` that prints these read-backs is the design's plan; the commands are its content.) The 13 items are copied into
the design doc, section 3.3.

1. **Host swap absent or encrypted.** `swapon --show --noheadings | wc -l; cat /proc/swaps; grep -i swap /etc/fstab; zramctl;
   systemctl list-units --type=swap --no-legend` -> `0`, only the header line in `/proc/swaps`, no fstab swap line, empty
   `zramctl`, no swap units. If swap must exist: `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT` shows the swap partition under a `crypt`
   device with an `/etc/crypttab` entry using `/dev/urandom` and `swap`. Also `systemctl is-enabled hibernate.target` ->
   `static`/`masked`, and `cat /sys/power/state` empty or without `disk`. The unit's own control: `systemctl show tj-decoder -p
   MemorySwapMax` -> `MemorySwapMax=0`, and `cat /sys/fs/cgroup/system.slice/tj-decoder.service/memory.swap.max` -> `0` (needs
   `stat -fc %T /sys/fs/cgroup` -> `cgroup2fs`). Measured here: effective with 8 GiB of swap present (2e).
2. **Core dumps and kdump.** `sysctl kernel.core_pattern fs.suid_dumpable` -> `kernel.core_pattern = |/bin/false` and
   `fs.suid_dumpable = 0`. **Mandatory: with a pipe `core_pattern` the kernel runs the handler even at `LimitCORE=0` (2f).** Then
   `systemctl is-enabled kdump kdump-tools apport systemd-coredump.socket 2>&1` -> all `disabled`/`masked`/`No such file`; `grep -o
   'crashkernel=[^ ]*' /proc/cmdline` -> no output; `coredumpctl list 2>&1` -> `No coredumps found.`; `ls /var/crash
   /var/lib/systemd/coredump /var/lib/apport/coredump 2>&1` -> empty or absent; `cat /etc/systemd/coredump.conf.d/* 2>/dev/null`
   -> `Storage=none`. Finally the real test, not done here: `kill -SEGV $(systemctl show -p MainPID --value tj-decoder); sleep 3;
   coredumpctl list --no-pager; find / -xdev -name 'core*' -mmin -2 -type f` -> nothing found, **after first doing the same with
   `LimitCORE=infinity` and a temporary file `core_pattern` to see the control produce a dump** (otherwise an absent dump proves
   nothing, as here).
3. **Provider snapshots and backups (cannot be checked from inside the VM).** From the provider's dashboard, API or support (get it
   in writing): (a) are automatic or manual **snapshots** of this server enabled, and do they include **RAM** (live snapshot) or
   only disk; (b) are backups enabled and what do they cover; (c) can provider staff take a memory snapshot. Provider CLI example
   (for the `hcloud` CLI): `hcloud server describe <name> -o json | jq '.backup_window, .protection'` and `hcloud image list -t snapshot` -> no
   images for this server; other providers: the equivalent listing. Inside the VM: `crontab -l; ls /etc/cron.*; systemctl
   list-timers --all --no-legend | grep -i -E 'backup|snap|restic|borg|rsync'` -> nothing, or excludes for `/var/log/journal` and
   `/var/tmp`. The legal text must name the live-snapshot residual risk if (a) cannot be switched off.
4. **Firewall: default-deny inbound.** `ufw status verbose` (-> `Default: deny (incoming)`, only the SSH rule) or `nft list
   ruleset` / `iptables -S` (policy DROP on INPUT, accept only established, loopback, SSH); `ss -ltnup` -> the decoder only on
   `127.0.0.1:<port>` (or the unit has `PrivateNetwork=yes` and the socket is bound by the socket unit on loopback), cloudflared
   metrics only on `127.0.0.1`; from another machine `nmap -Pn -p- <public-ip>` -> only the SSH port (or nothing). Also the
   provider-level firewall rules (dashboard).
5. **Tunnel and proxy logging/spooling config.** `systemctl cat cloudflared` and `ps -o args= -C cloudflared` -> `--loglevel warn`
   (or `error`), no `--logfile`, `--no-autoupdate`, runs as an unprivileged user; `cat /etc/cloudflared/config.yml` -> no
   `logDirectory` / `loglevel: debug`; `ls -la /var/log/cloudflared* 2>&1` -> absent; `journalctl -u cloudflared --since '-1h' -o
   cat | grep -c -i -E 'GET|POST|request'` -> `0`. If any nginx/Caddy/Apache sits in front: `nginx -T 2>/dev/null | grep -E
   'access_log|client_body_temp_path|proxy_request_buffering|client_body_buffer_size'` -> `access_log off`, `proxy_request_buffering
   off`; `ls -la /var/lib/nginx/body` empty. Then repeat sections 3 and 6 of this spike against the production hostname: POST a 15+
   MB image with a marker, then `journalctl -a | grep -c MARKER` -> `0` and `inotifywait` on the tunnel user's home and `/tmp`
   shows no events. **Cloudflare side (dashboard, cannot be read from the VPS):** Zero Trust > Logs > Access (what is retained),
   Logpush jobs for the zone (none that include request bodies; bodies are never in standard logs), WAF and rate limits, the
   Access policy and service token on the hostname.
6. **Kernel and hypervisor differences.** `uname -r; systemd --version | head -1; systemd-detect-virt; stat -fc %T
   /sys/fs/cgroup; cat /sys/fs/cgroup/cgroup.controllers; grep Seccomp /proc/$(systemctl show -p MainPID --value
   tj-decoder)/status` -> a kernel >= 5.x with `cgroup2fs`, controllers include `memory`, `Seccomp: 2`. Re-run the whole proof suite
   (the unit, strace, inotify, read-only and marker tests) on the VPS and compare with this report: the same unit must reach
   `systemd-analyze security tj-decoder` <= 1.0 (here 0.5) and the six inputs must pass. Differences to watch:
   `MemoryDenyWriteExecute` with the VPS's Python/ImageMagick build, `PrivateNetwork` with socket activation, `ProtectProc=invisible`
   with its systemd version, whether `/tmp` is tmpfs or disk (`findmnt -no FSTYPE /tmp /var/tmp /dev/shm`; `/var/tmp` was
   disk-backed ext4 here), and that the pipe `core_pattern` handler actually exists on that kernel.
7. **Real CPU/RAM sizing.** `nproc; lscpu | grep -E 'Model name|Flags' | grep -o -E 'Model name.*|avx2|sse4_2'; free -m; cat
   /sys/fs/cgroup/system.slice/tj-decoder.service/memory.max` and the latency script on the VPS; then `systemd-run --wait --pipe -p
   MemoryMax=2G -p CPUQuota=200% ...` with 3 to 4 simultaneous 50 MP uploads, reading `memory.peak` / `memory.events` (`oom_kill
   0`). Here one 50 MP request peaks at about 480 MB and a cgroup OOM kills the whole wrapper (2g), so the concurrency limit must be
   set so that `concurrent x 0.5 GB < MemoryMax`. Also confirm the WebP bytes equal this report's SHA-256s for the six inputs
   (CPU/SIMD determinism; the p05 WebP is 363,258 B).
8. **Persistent journal and log forwarding.** `journalctl --disk-usage; ls -d /var/log/journal 2>&1; systemd-analyze cat-config
   systemd/journald.conf | grep -E '^(Storage|MaxLevelStore|ForwardTo|Compress|Seal)'; systemctl show tj-decoder -p LogLevelMax` ->
   `Storage=volatile` (or a persistent journal accepted knowingly), `LogLevelMax=notice`; forwarding agents: `systemctl list-units
   --no-legend | grep -i -E 'rsyslog|syslog-ng|promtail|vector|fluent|filebeat|journalbeat|datadog|otel|newrelic|vmagent'` -> none,
   or confirmed not shipping this unit. Re-run the marker test (section 3) and `journalctl -a | grep -c <marker>` -> `0`. The
   journal here was persistent by default.
9. **Backups and file-level capture of writable paths.** `findmnt -no TARGET,FSTYPE,OPTIONS /tmp /var/tmp /dev/shm /run` and the
   unit's namespace view: `nsenter -m -t $(systemctl show -p MainPID --value tj-decoder) findmnt -rn -o TARGET,OPTIONS | awk '$2 ~
   /(^|,)rw(,|$)/'` -> only `/dev/pts`, `/dev/mqueue`, `/dev/hugepages`, `/proc`, `/sys/...`, none of `/tmp /var /var/tmp /dev/shm
   /run` (the `ro` case of 2c). If `/var/tmp` is disk-backed on the VPS, a leak there would be in provider disk snapshots.
10. **Patching of the decoder libraries.** `systemctl is-enabled unattended-upgrades; apt-config dump | grep -E
    'Unattended-Upgrade::(Allowed-Origins|Automatic-Reboot)'; apt list --upgradable 2>/dev/null | grep -E
    'imagemagick|libmagick|libjpeg|libwebp|libpng|libheif|libtiff'; magick -version | head -1; dpkg -l libwebp7 libjpeg62-turbo | awk
    '/^ii/{print $2,$3}'` -> enabled, security origin allowed, nothing upgradable, and the reported version equals the allow-listed
    `build_id`. A library upgrade may change WebP bytes (C7 was shown for one build only).
11. **Access to memory by the box's administrators.** `getent group sudo adm; last -n 20; ss -tnp | grep :22` -> only the owner;
    root can read `/proc/<pid>/mem` of the decoder; document it (an operational, not a technical, control).
12. **HMAC secret and tunnel credentials handling** (design section 2.2). `stat -c '%U %a %n' /etc/tj-decoder/* /etc/cloudflared/*
    ~/.cloudflared/*` -> mode 600 or 640, owner root or the service user, none world-readable; `systemctl show tj-decoder -p
    LoadCredential,EnvironmentFiles` shows how the secret is passed (systemd credentials preferred over `Environment=`, which is
    visible in `systemctl show`).
13. **Wall-clock and network path from Cloudflare to the VPS** (what the Worker will actually see). From a Worker or `curl` through
    the production tunnel hostname, POST 15 MB and read `%{time_total}`; here the 21 MiB upload took 47 to 62 s over a home line,
    which says nothing about this path.

## 9. Findings that change the design or correct pass 1

1. **Pass-1 checker blind spot** (openat regex vs `strace -y`): fixed and re-run; pass-1 conclusions stand because they also rested
   on the write-target leg and on controls that fired there.
2. **A unit with only `PrivateTmp=yes` + `ProtectSystem=strict` still has writable `/tmp`, `/var/tmp` (disk-backed), `/dev/shm`,
   `/run`.** Add `TemporaryFileSystem=/tmp:ro /var:ro /var/tmp:ro /run:ro` and `InaccessiblePaths=/dev/shm` (tested, 6/6 pass, 0
   events).
3. **`LimitFSIZE=0` cannot be set on the wrapper unit** (memfd writes fail); set it on the IM child (works under the seccomp filter
   via `prlimit64`) and keep the unit at a finite bound.
4. **`LimitCORE=0` is not enforced by the kernel with a pipe `core_pattern`** (handler still invoked, 4 of 4 processes);
   `kernel.core_pattern=|/bin/false` is a required host setting. The SEGV-no-core check was not demonstrable here (the positive
   control failed).
5. **A cgroup OOM kills the whole wrapper**, not the decoder child alone; keep IM's memory limit under `MemoryMax`, and consider
   per-request sub-cgroups.
6. `LogLevelMax=notice` drops unprefixed stderr; the wrapper must prefix its lines.
7. "Any stderr is a failure" rejects some legitimate images (ICC PCS illuminant warning on a PNG: 1 of 66 fixtures). Needs a product
   decision.
8. The spec's own spike input 2 (50 MP gradient + sparse noise) has PDQ quality 35, so it is "unscannable" by §6.1 and would 422 in
   production; fine for the spike, but do not use it as a positive end-to-end case.
9. C7 holds for ImageMagick/libwebp on this build (65/65); C7 for Cloudflare Images is still untested.

## 10. Teardown evidence

- Distro: `wsl -l -v` before the work showed `Alpine Stopped 2` (default) and `docker-desktop Running 2`. During: plus
  `tjspike2-systemd`. After `wsl --unregister tjspike2-systemd` (that name only; `wsl --terminate` of it once, never `--shutdown`;
  no other distro's files edited): `Alpine Stopped 2`, `docker-desktop Running 2`. The spike's distro directory (the 808 MB export
  tar and the vhdx) was deleted and confirmed absent.
- Containers created: one export container (create, export, `docker rm` of that name), a probe container, two PDQ containers and
  two determinism containers, all named `tjspike2-*` and all `--rm` except the export one; afterwards `docker ps -a` shows 0
  `tjspike2-*`. The only docker commands run were `run --rm --name tjspike2-*`, `create`/`rm` of the export container, `ps -a` and
  `images`; no kill, stop, prune or compose, and no pipe into any destructive command.
- `docker ps -a` before: a CI Postgres container (`ci-pg-...-backend`, `postgres:16`, up 17 to 26 seconds), `humboldtkidtracker-db`
  (`postgres:18`, up 43 minutes) and `thinkersjournal-db` (`postgres:18`, up 43 minutes, healthy). After: `humboldtkidtracker-db`
  and `thinkersjournal-db` up about an hour. **The CI Postgres container is gone after.** No command was run against it; it was a
  seconds-old CI container at the start and looks like a short-lived CI test database that exited and removed itself, but its exit
  was not observed, so that cannot be proved; the PM may want to confirm with the CI run that owned it.
- Tunnel: the cloudflared process was killed by PID; 0 processes; the URL returns 530; no listener on 8088 or the metrics port in
  the distro or Windows; the remaining TCP listeners in the WSL network namespace at the end (ports 53, 5432 and 5433) were not the
  spike's (the WSL VM network is shared across distros: the resolver and the Docker-published Postgres ports).
- Images: the pass-1 image and `debian:trixie-slim` untouched; nothing new pulled (fonts for the C8 generator were installed inside
  a `--rm` container only).

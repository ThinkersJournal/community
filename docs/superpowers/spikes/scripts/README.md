# D7 spike scripts (archived)

These are the scripts behind the three spike write-ups in `docs/superpowers/spikes/`:

| Directory | Write-up | Ran in |
|---|---|---|
| `pass1/` | `2026-10-08-imagemagick-pdq-spike.md` | A Docker container the spike owner created (mounts seen in the scripts: `/fix` fixtures, `/s` this pass1 directory, `/o` output). |
| `pass2/` | `2026-10-08-imagemagick-systemd-spike-pass-2.md` | A throwaway WSL2 systemd distro (`tjspike2-systemd`), as root; `c8.py` in a container named `tjspike2-pdq`. |
| `pass3/` | `2026-10-08-c8-real-corpus-measurement.md` | `fetch.py` and `report.py` on the host, `measure.py` in a container. |

They are **archived evidence, not product code**. Nothing here is built, imported or run by CI. Each file starts with a
header saying what it proves, its inputs, its effects and its safety statement.

## What is and is not preserved

- **Preserved verbatim** from the spike session: every script, `policy.xml` variant, systemd unit and `pass3/manifest.tsv`
  (the pass-3 Commons corpus: file, category, licence, author, source URL). The only edits are the headers and the parameterisation below.
- **Parameterised** (the originals hard-coded a session scratchpad path and, in `pass3/fetch.py`, a contact address):
  `pass2/*.sh` take `SPIKE_DIR` (the work directory holding `fixtures/`, `vendor2/`, `out2/`, `pass1/`, `pass2/`) and
  `SPIKE_PASS2` (the `pass2` directory); `pass3/fetch.py` takes `SPIKE_CONTACT`. The scripts refuse to start without them.
  Pass 2's `$SP/scripts/` and `$SP/scripts2/` references were renamed to `$SP/pass1/` and `$SP/pass2/` to match this layout.
- **Not committed** (and needed to re-run): the fixture images (`fixtures/` and the pass-3 images). `pass3/fetch.py`
  re-fetches a corpus of the same kind from Commons (the committed `manifest.tsv` lists the files it chose);
  `pass1/download.py` needs a wanted-titles list and candidate JSON that were **not preserved**, so the pass-1 photo set
  cannot be re-fetched from this directory. Also not committed: the ImageMagick and PDQ builds (`build/`, `vendor/`), the
  `cloudflared` binary (`vendor2/`) and every raw output (`out/`, `out2/`). The write-ups carry the results; they are not
  reproducible byte for byte from this directory alone.

## Safety

No script issues a `docker`, `wsl` or host-level kill, stop or prune command. They act only inside the environment they
are run in. **Run them only in a throwaway container or distro you created yourself, with a unique name (`tjspike*`),
and never against another lane's containers, volumes, networks or WSL distros.** Two scripts do more than read:
`pass2/t6a.sh` starts a `cloudflared` quick tunnel that exposes the test harness (`wrapper.py`, not the product) to the
internet until `pass2/t6c.sh` stops it, and the `pass2/t*.sh` scripts `rm -rf` their own work directories and
stop/reset the `tj-wrapper` units inside the distro.

## t2b and t2c

Both are preserved (`pass2/t2b.sh`, `pass2/t2c.sh`). Their headers map them to the pass-2 write-up's swap, SEGV/core and
oversize-decode checks (sections 2e to 2g), not to section 8 item 6 (kernel and hypervisor differences), which is a host
command list and not a script. The swap control appears in both; `t2c.sh` is the later one.

## Known defects, left as archived (not fixed)

- `pass2/cmp7.py:13-14` compares field 3 (`webp_len`), not the WebP hash, so its "webp differ" counts compare lengths only.
  `t4.sh`'s own comparison is correct.
- `pass2/t2b.sh:68-70` sends SEGV to the first process whose command line matches `magick`, not necessarily the decoder child;
  `:82` runs `systemctl reset-failed` with no unit. Several `kill`s read a PID from a file or variable (`t6c.sh`, `t6b.sh`,
  `t2.sh`); a stale file would kill the wrong process. Read the header of each before running.
- `pass2/t6a.sh:7-8` prints the published `cloudflared` sha256 beside the computed one but never compares them.
- Hidden dependencies: `t6a.sh` needs `/srv/markers` from `t3.sh`; `t6b.sh` needs `out2/tunnel_out_*.bin` and `cmp7.py` needs
  `c7/ctr*.txt`, which no committed script produces (the container half of the C7 run is not archived).
- `pass1/stageb2.sh` and `stageb3.sh` need `SYS_PTRACE` in the container and run `rm -f` on the container's `/` and `/tmp`;
  `stageb3.sh` has no `set -e`.
- `pass3/fetch.py` overwrites `OUTDIR/../manifest.tsv`; `pass3/report.py` hard-codes its narrative text and local path names.

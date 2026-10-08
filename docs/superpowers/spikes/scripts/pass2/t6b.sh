#!/bin/bash
# PROVES: Task 6 (write-up section 6, disk checks and marker through the tunnel): tunnel response equals a direct response; strace-check of the wrapper; cloudflared
#   write/open classification; inotify, before/after file listings; marker hits.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh (reads out2/tunnel_out_noise16.bin and tunnel_out_marker.bin, which
#   no script in pass2/ produces; the write-up says the requests came from the Windows host) and SPIKE_PASS2 (this pass2 directory, to find lib.sh); state from t6a.sh
#   in /srv/work/t6; unit running. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: copies the two .bin files into /srv/work/t6; sends one POST to 127.0.0.1:8088; kills the strace whose PID is in wstrace.pid; whole-filesystem find to
#   files_after.txt; greps logs, journal and dmesg. Does not tear down the tunnel (despite killing that strace).
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: the one kill targets the strace recorded in wstrace.pid (see EFFECTS).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 6b: analysis of the tunnel run (cloudflared + wrapper), then nothing is torn down here
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
T=/srv/work/t6
cp $SP/out2/tunnel_out_noise16.bin $SP/out2/tunnel_out_marker.bin $T/
echo "== A. tunnel response equals a direct (local, no tunnel) response?"
python3 -I $W/client.py 8088 /srv/fix/noise16.jpg 1 $T/direct_noise16.webp | cut -c1-260
python3 -I - <<'PY'
import struct, json, hashlib
for n in ('tunnel_out_noise16.bin', 'tunnel_out_marker.bin'):
    d = open('/srv/work/t6/' + n, 'rb').read()
    hl = struct.unpack('>I', d[:4])[0]; h = json.loads(d[4:4 + hl])
    rgb = d[4 + hl:4 + hl + h['rgb_len']]; webp = d[4 + hl + h['rgb_len']:]
    print(n, 'rgb_sha', hashlib.sha256(rgb).hexdigest()[:16], 'webp_sha', hashlib.sha256(webp).hexdigest()[:16], 'webp_len', len(webp), 'header', h['info'], h['scan'])
PY
echo "== B. wrapper under the tunnel requests: strace-check"
kill $(cat $T/wstrace.pid) 2>/dev/null; sleep 1
ALLOW_MEMFD=1 python3 -I $W/stracecheck.py $T/wrapper_trace.txt | cut -c1-300
echo "== C. cloudflared: strace write/open classification (all threads, -f), -y fd annotations"
python3 -I - <<'PY'
import re, collections
t = open('/srv/work/t6/cf_trace.txt', errors='replace').read().splitlines()
print('trace lines', len(t))
tgt = collections.Counter(); bytes_by = collections.Counter(); wopen = []; fsmut = []
for l in t:
    m = re.search(r'\b(write|pwrite64|writev|pwritev|sendfile|copy_file_range)\((\d+)<([^>]*)>.*= (\d+)$', l)
    if m:
        k = m.group(3)
        kind = 'socket' if k.startswith('socket:') else 'pipe' if k.startswith('pipe:') else 'anon_inode' if k.startswith('anon_inode') else k
        tgt[kind] += 1; bytes_by[kind] += int(m.group(4)); continue
    m = re.search(r'\b(openat|open|creat)\((?:AT_FDCWD(?:<[^>]*>)?, )?"([^"]*)"(?:\.\.\.)?(?:, ([A-Z_|0-9x]+))?', l)
    if m and (m.group(1) == 'creat' or (m.group(3) and re.search(r'O_WRONLY|O_RDWR|O_CREAT|O_TRUNC', m.group(3)))):
        wopen.append((m.group(2), m.group(3))); continue
    if re.search(r'\b(mkdir|mkdirat|rename|renameat2?|unlink|unlinkat|ftruncate|truncate|fallocate)\(', l) and 'ENOENT' not in l:
        fsmut.append(l.strip()[:140])
print('write targets (count):', dict(tgt))
print('bytes written (success) by target:', dict(bytes_by))
print('write-capable opens of PATHS (distinct):', sorted(set(wopen)))
print('fs mutations (mkdir/rename/unlink/trunc):', fsmut[:8], 'n=', len(fsmut))
PY
echo "== D. inotify on cwd/home/tmp since baseline (baseline had 6 setup events + 2 control lines before POSTs)"
echo "total events now: $(wc -l < $T/ino_cf.txt)"; sed -n '1,40p' $T/ino_cf.txt | cut -c1-140
echo "== E. file system before/after"
diff <(ls -la /tmp /var/tmp /dev/shm /srv/cfwork/home /srv/cfwork/cwd 2>&1 | grep -v -E '^total|systemd-private|^$') <(grep -v -E '^total|systemd-private|^$' $T/ls_before.txt) && echo "ls -la of /tmp /var/tmp /dev/shm /srv/cfwork/{home,cwd}: IDENTICAL before/after"
find / -xdev \( -path /proc -o -path /sys -o -path /mnt -o -path /var/log/journal -o -path /srv/work -o -path /srv/det -o -path /srv/markers -o -path /run/log/journal \) -prune -o -type f -print 2>/dev/null | sort > $T/files_after.txt
echo "new regular files since before-snapshot (excl. journal, /srv/work, /srv/markers):"; comm -13 $T/files_before.txt $T/files_after.txt | head -20
echo "files modified since stamp (mtime) outside /proc /sys /mnt /srv/work /var/log/journal /run:"; find / -xdev \( -path /proc -o -path /sys -o -path /mnt -o -path /srv/work -o -path /srv/det -o -path /srv/markers -o -path /var/log/journal -o -path /run \) -prune -o -type f -newermt @$(cat $T/stamp) -print 2>/dev/null | head -20
ls -laR /srv/cfwork | head -20
echo "== F. marker through the tunnel: grep cloudflared log, trace, journal, dmesg, tmp"
M=$(cat /srv/work/tunnel_marker.txt); echo "marker=$M"
echo "cf.log hits: $(grep -a -c -F "$M" $T/cf.log); cf strace hits (-s 64 payload prefixes): $(grep -a -c -F "$M" $T/cf_trace.txt); journal hits: $(journalctl -a --no-pager -o verbose | grep -a -c -F "$M"); dmesg: $(dmesg | grep -a -c -F "$M"); files: [$(grep -r -a -l -F "$M" /srv/cfwork /tmp /var/tmp /dev/shm /var/log /run 2>/dev/null | grep -v journal | tr '\n' ' ')]"
echo "cloudflared log lines at the request time (anything per-request?):"; grep -a -v -E "ICMP|metrics|Registered|curve|Version|GOOS|Settings|Generated|Initial|Requesting|Autoupdate|Cannot|Thank|https://|Your quick|\||^$|\+--|Cloudflare" $T/cf.log | cut -c1-200 | tail -8
echo "full cf.log size $(wc -c < $T/cf.log) bytes; lines $(wc -l < $T/cf.log)"

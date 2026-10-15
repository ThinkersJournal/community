#!/bin/bash
# PROVES: Task 2 (cont.), write-up sections 2e (MemorySwapMax control, rerun with --pipe), 2f (dmesg evidence that the kernel invokes the core pipe handler even with
#   LimitCORE=0) and 2g (400 MP highly compressed PNG; 50 MP under MemoryMax=200M, who got killed). Matches t2b.sh parts B, C, D; 'checklist item 6' is the PM's label,
#   not a write-up term.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh, and SPIKE_PASS2 (this pass2 directory, to find lib.sh); /srv/fix/*,
#   dmesg and the journal. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: writes /srv/work/alloc.py and overwrites /srv/fix/bomb400mp.png; starts transient units tjspike2-swap-* (380 MiB under MemoryMax=200M) and
#   tjspike2-corelim-0/-infinity (sleep 60) and sends kill -SEGV to them; start_case on the wrapper (loopback listener 127.0.0.1:8088), one deliberate cgroup OOM kill
#   of the wrapper; ends with stop of tj-wrapper units and rm -rf of the drop-in.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
echo "##### B. MemorySwapMax control (transient units tjspike2-swap-*), allocate 380 MiB of touched anon memory under MemoryMax=200M"
cat > /srv/work/alloc.py <<'PY'
import time
def swap():
    return [int(x.split()[1]) for x in open('/proc/self/status') if x.startswith('VmSwap')][0]
l = []
for i in range(380):
    l.append(bytearray(b'x' * (1 << 20)))
    if i % 40 == 0:
        print('  alloc', i, 'MiB, VmSwap kB', swap(), flush=True)
time.sleep(0.5)
print('  SURVIVED 380 MiB; final VmSwap kB', swap(), flush=True)
PY
for MODE in swapmax0 swapdefault; do
  U=tjspike2-swap-$MODE
  PROP="-p MemoryMax=200M"; [ $MODE = swapmax0 ] && PROP="$PROP -p MemorySwapMax=0"
  echo "-- $MODE: props: $PROP"
  systemd-run --unit=$U --collect --pipe --wait $PROP python3 -I /srv/work/alloc.py 2>&1 | grep -v '^Running as unit' | tail -8
  echo "   systemd-run rc=${PIPESTATUS[0]}"
done
journalctl -k --since "-2min" --no-pager 2>/dev/null | grep -i -E "tjspike2-swap|oom" | head -4 | cut -c1-200

echo "##### C. dmesg evidence for the earlier SEGV tests (kernel attempts the pipe handler even with RLIMIT_CORE=0)"
dmesg 2>/dev/null | grep -i coredump | tail -6 | cut -c1-200
echo "-- control: SEGV a sleep with LimitCORE=0 transient unit and one with infinity, compare kernel messages"
for L in 0 infinity; do
  U=tjspike2-corelim-$L
  systemd-run --unit=$U --collect -q -p LimitCORE=$L sleep 60
  sleep 1; CP=$(systemctl show $U -p MainPID --value); echo "LimitCORE=$L pid=$CP : $(grep 'Max core' /proc/$CP/limits | tr -s ' ')"
  kill -SEGV $CP; sleep 2
  dmesg 2>/dev/null | grep -i "coredump" | grep "($(echo sleep))" | tail -1 | cut -c1-160
  echo "   dmesg line for pid $CP: $(dmesg 2>/dev/null | grep "coredump: $CP(" | tail -1 | cut -c1-160)"
done
echo "coredumpctl: $(coredumpctl list --no-pager 2>&1 | tail -1); /var/lib/systemd/coredump: $(ls /var/lib/systemd/coredump | wc -l) files"

echo "##### D1b. 20000x20000 (400 MP) PNG header bomb, base unit"
python3 -I - <<'PY'
import zlib, struct
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
W = H = 20000
z = zlib.compressobj(9); out = []
row = b'\x00' + b'\x80' * W
for i in range(H): out.append(z.compress(row))
out.append(z.flush())
data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 0, 0, 0, 0)) + chunk(b'IDAT', b''.join(out)) + chunk(b'IEND', b'')
open('/srv/fix/bomb400mp.png', 'wb').write(data); print('bomb400mp.png bytes', len(data))
PY
start_case ""
/usr/bin/time -f "  wall %es" python3 -I $W/client.py 8088 /srv/fix/bomb400mp.png 1 2>&1 | cut -c1-120
echo "memory.peak=$(cat /sys/fs/cgroup/system.slice/tj-wrapper.service/memory.peak) state=$(systemctl show tj-wrapper.service -p ActiveState --value)"

echo "##### D2b. 50 MP PNG under MemoryMax=200M, who got killed"
start_case $'[Service]\nMemoryMax=200M'
CG=/sys/fs/cgroup/system.slice/tj-wrapper.service
OLD=$PID
python3 -I $W/client.py 8088 /srv/fix/s_50mp.png 1 2>&1 | tail -1 | cut -c1-120
sleep 1
echo "memory.events: $(cat $CG/memory.events | tr '\n' ' ')  swap.peak=$(cat $CG/memory.swap.peak)"
echo "MainPID before=$OLD now=$(systemctl show tj-wrapper.service -p MainPID --value) state=$(systemctl show tj-wrapper.service -p ActiveState,Result | tr '\n' ' ')"
journalctl -u tj-wrapper.service --since "-1min" --no-pager -o cat | grep -i -E "oom|killed|req fail" | cut -c1-160 | tail -4
echo "next request after OOM: $(python3 -I $W/client.py 8088 /srv/fix/p24.jpg 1 | cut -c1-70)"
systemctl stop tj-wrapper.socket tj-wrapper.service; rm -rf $DROP; systemctl daemon-reload

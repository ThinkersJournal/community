#!/bin/bash
# PROVES: Task 2 (cont.), write-up sections 2e (VmSwap and MemorySwapMax, parts A and B), 2f (SEGV and core, part C) and 2g (oversize decode, part D). These are the
#   write-up checks matching this script; 'checklist item 6' is the PM's label and is not a term used in the write-up.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh, and SPIKE_PASS2 (this pass2 directory, to find lib.sh); /srv/fix/*.
#   Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: creates /srv/fix/bomb144mp.png and bomb400mp.png (magick); samples /proc; starts transient units tjspike2-swap-* (allocate 380 MiB under MemoryMax=200M; the
#   write-up reports that the swapdefault control swapped about 193 MiB of the WSL VM's swap and that the swapmax0 one was oom-killed) and tjspike2-core-ctl (sleep 60);
#   sends kill -SEGV to the wrapper MainPID, to the first pgrep -f magick match and to the control unit; deliberately OOM-kills the wrapper (MemoryMax=200M); runs
#   'systemctl reset-failed' with no unit argument (all failed units in the distro); find / -xdev scans. Ends with stop of tj-wrapper units and rm -rf of the drop-in.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: it sends SEGV and OOM-kills only inside the distro (see EFFECTS).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 2 (cont.): VmSwap, MemorySwapMax control, SEGV/core, oversize decode fail-closed
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
cd /srv/fix
[ -f bomb144mp.png ] || magick -size 12000x12000 xc:gray50 -depth 8 PNG:bomb144mp.png
[ -f bomb400mp.png ] || magick -size 20000x20000 xc:gray50 -depth 8 PNG:bomb400mp.png
ls -la bomb*.png | awk '{print $5, $9}'

echo "##### A. VmSwap / cgroup swap during a 50 MP decode (base unit)"
start_case ""
CG=/sys/fs/cgroup/system.slice/tj-wrapper.service
echo "memory.max=$(cat $CG/memory.max) memory.swap.max=$(cat $CG/memory.swap.max)"
grep -E 'Limit core|Limit file size' /proc/$PID/limits
( for i in 1 2 3; do python3 -I $W/client.py 8088 /srv/fix/s_50mp.png 1 >/dev/null; done ) &
CL=$!
MAXSWAP=0; SAMPLES=0; PEAKRSS=0; SAWIM=0
while kill -0 $CL 2>/dev/null; do
  for p in $(cat $CG/cgroup.procs); do
    S=$(grep -E '^(VmSwap|VmRSS):' /proc/$p/status 2>/dev/null | tr -s ' ' | tr '\n' ' ')
    SW=$(awk '/VmSwap/{print $2}' /proc/$p/status 2>/dev/null); RS=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null)
    C=$(cat /proc/$p/comm 2>/dev/null); [ "$C" = magick ] && SAWIM=$((SAWIM+1))
    SAMPLES=$((SAMPLES+1)); [ "${SW:-0}" -gt "$MAXSWAP" ] && MAXSWAP=$SW; [ "${RS:-0}" -gt "$PEAKRSS" ] && PEAKRSS=$RS
  done
  sleep 0.05
done
wait $CL
echo "samples=$SAMPLES (magick-process samples=$SAWIM) max VmSwap(kB)=$MAXSWAP peak sampled VmRSS(kB)=$PEAKRSS"
echo "cgroup memory.peak=$(cat $CG/memory.peak) memory.swap.peak=$(cat $CG/memory.swap.peak 2>/dev/null) memory.swap.current=$(cat $CG/memory.swap.current)"

echo "##### B. MemorySwapMax control (transient units, own names)"
for MODE in swapmax0 swapdefault; do
  U=tjspike2-swap-$MODE
  PROP="-p MemoryMax=200M"; [ $MODE = swapmax0 ] && PROP="$PROP -p MemorySwapMax=0"
  systemd-run --unit=$U --collect --wait -q $PROP -p Type=exec python3 -I -c "
import mmap,time,os
b=bytearray(1<<20)
l=[]
try:
    for i in range(380):
        l.append(bytearray(b'x'*(1<<20)))
        if i%20==0:
            sw=[int(x.split()[1]) for x in open('/proc/self/status') if x.startswith('VmSwap')][0]
            cg=open('/proc/self/cgroup').read().strip().split('::')[1]
            print('alloc',i,'MiB VmSwap kB',sw,flush=True)
    time.sleep(1)
    print('survived; VmSwap kB',[int(x.split()[1]) for x in open('/proc/self/status') if x.startswith('VmSwap')][0])
except MemoryError: print('MemoryError')
" 2>&1 | tail -4
  echo "  -> result: $(systemctl show $U -p Result,ExecMainStatus,ExecMainCode 2>/dev/null | tr '\n' ' ') (unit collected; rc of systemd-run above)"
done

echo "##### C. SEGV with LimitCORE=0 (service) vs LimitCORE=infinity (control)"
echo "core_pattern=$(cat /proc/sys/kernel/core_pattern)  coredumpctl before: $(coredumpctl list --no-pager 2>&1 | tail -1)"
date +%s > /srv/work/stamp
start_case ""
echo "service LimitCORE=$(systemctl show tj-wrapper.service -p LimitCORE --value) /proc limit: $(grep 'Max core' /proc/$PID/limits)"
kill -SEGV $PID; sleep 2
echo "service state after SEGV: $(systemctl show tj-wrapper.service -p ActiveState,Result,ExecMainStatus | tr '\n' ' ')"
echo "journal (coredump mentions):"; journalctl --since "-1min" --no-pager -o cat | grep -i -E "dumped core|coredump|core dump|Failed with result 'signal'|SEGV" | head -5
echo "coredumpctl after: $(coredumpctl list --no-pager 2>&1 | tail -2 | tr '\n' '|')"
echo "find core files: $(find / -xdev \( -path /proc -o -path /sys -o -path /mnt \) -prune -o -type f \( -name 'core' -o -name 'core.*' -o -name '*.coredump*' \) -newermt @$(cat /srv/work/stamp) -print 2>/dev/null | tr '\n' ' ')"
ls -la /var/lib/systemd/coredump 2>&1 | tail -3
echo "-- also SEGV to an in-flight magick child during a 50MP decode:"
systemctl reset-failed 'tj-wrapper*'; start_case ""
( python3 -I $W/client.py 8088 /srv/fix/s_50mp.png 1 > /srv/work/segv_child.txt 2>&1 ) &
CL=$!
for i in $(seq 1 100); do M=$(pgrep -f 'magick' | head -1); [ -n "$M" ] && break; sleep 0.05; done
echo "magick child pid=$M limits: $(grep 'Max core' /proc/$M/limits 2>/dev/null) | $(grep 'Max file size' /proc/$M/limits 2>/dev/null)"
kill -SEGV $M 2>/dev/null; wait $CL
echo "client saw: $(cut -c1-80 /srv/work/segv_child.txt); service still: $(systemctl show tj-wrapper.service -p ActiveState --value)"
sleep 1
echo "coredumpctl after child SEGV: $(coredumpctl list --no-pager 2>&1 | tail -1)"
echo "find core files: $(find / -xdev \( -path /proc -o -path /sys -o -path /mnt \) -prune -o -type f \( -name 'core' -o -name 'core.*' -o -name '*.coredump*' \) -newermt @$(cat /srv/work/stamp) -print 2>/dev/null | tr '\n' ' ')"
echo "-- CONTROL: transient unit LimitCORE=infinity killed by SEGV"
systemd-run --unit=tjspike2-core-ctl --collect -q -p LimitCORE=infinity sleep 60
sleep 1; CP=$(systemctl show tjspike2-core-ctl -p MainPID --value); echo "control limit: $(grep 'Max core' /proc/$CP/limits)"
kill -SEGV $CP; sleep 3
echo "coredumpctl after control: $(coredumpctl list --no-pager 2>&1 | tail -2 | tr '\n' '|')"
echo "find core files: $(find / -xdev \( -path /proc -o -path /sys -o -path /mnt \) -prune -o -type f \( -name 'core' -o -name 'core.*' -o -name '*.coredump*' -o -name 'core.*.zst' \) -newermt @$(cat /srv/work/stamp) -print 2>/dev/null | tr '\n' ' ')"
ls /var/lib/systemd/coredump 2>&1 | head -3
systemctl stop tjspike2-core-ctl 2>/dev/null; systemctl reset-failed 2>/dev/null

echo "##### D. Oversize decode fail-closed"
echo "-- D1 area/dimension bombs, base unit (policy area 128MP, width/height 16KP, MemoryMax=2G)"
systemctl reset-failed 'tj-wrapper*'; start_case ""
for f in bomb144mp.png bomb400mp.png; do
  /usr/bin/time -f "  wall %es" python3 -I $W/client.py 8088 /srv/fix/$f 1 2>&1 | cut -c1-120
done
echo "service state: $(systemctl show tj-wrapper.service -p ActiveState --value); memory.peak=$(cat /sys/fs/cgroup/system.slice/tj-wrapper.service/memory.peak)"
journalctl -u tj-wrapper.service --since "-1min" --no-pager -o cat | grep 'req fail' | tail -3
echo "-- D2 50 MP PNG under MemoryMax=200M + MemorySwapMax=0 (cgroup kills the decoder; must fail closed, no output, no swap)"
start_case $'[Service]\nMemoryMax=200M'
CG=/sys/fs/cgroup/system.slice/tj-wrapper.service
echo "memory.max=$(cat $CG/memory.max) swap.max=$(cat $CG/memory.swap.max)"
python3 -I $W/client.py 8088 /srv/fix/s_50mp.png 1 2>&1 | cut -c1-160
echo "events: $(cat $CG/memory.events | tr '\n' ' ') swap.peak=$(cat $CG/memory.swap.peak)"
journalctl -u tj-wrapper.service --since "-1min" --no-pager -o cat | grep -E 'req fail|oom|Killed' | tail -3
echo "service still serves a small image: $(python3 -I $W/client.py 8088 /srv/fix/p24.jpg 1 | cut -c1-80)"
echo "-- D3 policy-level: MAGICK_MEMORY_LIMIT=64MiB + disk 0 (clean IM error instead of OOM-kill)"
start_case $'[Service]\nEnvironment=MAGICK_MEMORY_LIMIT=64MiB'
python3 -I $W/client.py 8088 /srv/fix/s_50mp.png 1 2>&1 | cut -c1-160
journalctl -u tj-wrapper.service --since "-1min" --no-pager -o cat | grep -E 'req fail' | tail -1
echo "memory.events: $(cat /sys/fs/cgroup/system.slice/tj-wrapper.service/memory.events | tr '\n' ' ')"
systemctl stop tj-wrapper.socket tj-wrapper.service; rm -rf $DROP; systemctl daemon-reload

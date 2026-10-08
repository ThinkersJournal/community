#!/bin/bash
# PROVES: Task 2 (write-up section 2, table of cases): no-disk proof against the unit. Usage: t2.sh CASE, CASE one of base, ro, neg_pipe, neg_spill, neg_probe,
#   belt_spill (the last four are negative controls that are supposed to be flagged).
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh, and SPIKE_PASS2 (this pass2 directory, to find lib.sh); argument
#   CASE; /srv/fix/*, /srv/work/{client,stracecheck}.py. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: start_case (stops/restarts tj-wrapper units, writes the 10-case.conf drop-in, loopback listener 127.0.0.1:8088); rm -rf of /srv/work/t2_CASE then recreates
#   it; as root touches and removes .tjprobe in / /tmp /var /var/tmp /dev /dev/shm /run /opt/tj /etc /home /root /srv /usr inside the unit's mount namespace (and
#   touches /tmp/ctrl, not removed); starts background inotifywait and strace -p MainPID and later kills those two; copies results to out2/t2_CASE_*.txt. Leaves the
#   unit and drop-in in place.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 2: no-disk proof against the unit. usage: t2.sh CASE
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
CASE=$1
case $CASE in
  base)      DI="" ;;
  ro)        DI=$'[Service]\nPrivateTmp=no\nTemporaryFileSystem=\nTemporaryFileSystem=/tmp:ro /var:ro /var/tmp:ro /run:ro
InaccessiblePaths=/dev/shm' ;;
  neg_pipe)  DI=$'[Service]\nEnvironment=WRAP_MODE=pipe IMTMP=/tmp CHILD_FSIZE0=0' ;;
  neg_spill) DI=$'[Service]\nEnvironment=POLDIR=/opt/tj/magick-spill IMTMP=/tmp CHILD_FSIZE0=0' ;;
  neg_probe) DI=$'[Service]\nEnvironment=WRAP_PROBE=1 CHILD_FSIZE0=0' ;;
  belt_spill) DI=$'[Service]\nEnvironment=POLDIR=/opt/tj/magick-spill IMTMP=/tmp CHILD_FSIZE0=1' ;;
  *) echo bad case; exit 2 ;;
esac
echo "=== CASE $CASE"
start_case "$DI"
T=$W/t2_$CASE; rm -rf $T; mkdir -p $T
echo "-- writable mounts inside the unit's mount namespace (findmnt, rw only, excluding proc/cgroup/devpts/mqueue lines shown separately):"
nsenter -m -t $PID findmnt -rn -o TARGET,FSTYPE,OPTIONS | awk '$3 ~ /(^|,)rw(,|$)/' | tee $T/rwmounts.txt
echo "-- touch probes as root inside the ns (only ro mounts can stop root):"
nsenter -m -t $PID sh -c 'for d in / /tmp /var /var/tmp /dev /dev/shm /run /opt/tj /etc /home /root /srv /usr; do if touch $d/.tjprobe 2>/dev/null; then echo "WRITABLE $d"; rm -f $d/.tjprobe; else echo "ro/denied $d"; fi; done' | tr '\n' ';'; echo
# watchers
PRIV=$(ls -d /tmp/systemd-private-*tj-wrapper.service-* 2>/dev/null | head -1)
nsenter -m -t $PID inotifywait -m -r -q -e create,modify,moved_to,attrib,delete /tmp /var/tmp /dev/shm /run /var /opt/tj > $T/ino_ns.txt 2>$T/ino_ns.err &
INO1=$!
if [ -n "$PRIV" ]; then inotifywait -m -r -q -e create,modify,moved_to,attrib,delete "$PRIV" > $T/ino_host.txt 2>$T/ino_host.err & INO2=$!; fi
sleep 1
strace -f -y -s 256 -o $T/trace.txt -e $SC -p $PID 2>$T/strace.err &
STR=$!
sleep 2
drive_all | tee $T/drive.txt
sleep 1
NEV=$(wc -l < $T/ino_ns.txt)
echo "-- inotify events from the six requests: $NEV"
nsenter -m -t $PID sh -c 'touch /tmp/ctrl 2>/dev/null && echo "positive control: touched /tmp/ctrl" || echo "positive control: /tmp read-only, cannot touch (expected in ro case)"'
sleep 1
echo "-- inotify events after positive control touch: $(wc -l < $T/ino_ns.txt) (control adds >=1 only if /tmp is writable)"
kill $STR 2>/dev/null; wait $STR 2>/dev/null
kill $INO1 $INO2 2>/dev/null; wait $INO1 $INO2 2>/dev/null
echo "-- strace: lines=$(wc -l < $T/trace.txt) attach_err=$(wc -c < $T/strace.err)B"
ALLOW_MEMFD=1 python3 -I $W/stracecheck.py $T/trace.txt | tee $T/check.txt
echo "-- inotify: ns events=$(wc -l < $T/ino_ns.txt) (err: $(cat $T/ino_ns.err | head -2 | tr '\n' ' '))  host-private-tmp events=$( [ -n "$PRIV" ] && wc -l < $T/ino_host.txt || echo n/a) ($PRIV)"
head -4 $T/ino_ns.txt
journalctl -u tj-wrapper.service --since "-1min" --no-pager -o cat | grep -E 'req (ok|fail)' | sed 's/ms=[0-9]*//' | sort | uniq -c
echo "-- leftover files in unit private tmp/ns after run:"
nsenter -m -t $PID sh -c 'ls -la /tmp /var/tmp /dev/shm 2>&1 | grep -v "^total" | head -12'
cp $T/check.txt $OUT/t2_${CASE}_check.txt; cp $T/drive.txt $OUT/t2_${CASE}_drive.txt

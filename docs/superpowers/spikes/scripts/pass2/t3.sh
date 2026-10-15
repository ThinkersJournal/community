#!/bin/bash
# PROVES: Task 3 (write-up section 3): a unique marker in EXIF/COM/PNG text/bad-file bytes never reaches the journal, dmesg or any file; runs A (approved unit), B
#   (positive control WRAP_LOG_MARKER=1) and C (logger plus /var/tmp file control for the greps).
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh, and SPIKE_PASS2 (this pass2 directory, to find lib.sh);
#   /srv/fix/p24.jpg, /srv/work/mkmarker.py. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: rm -rf /srv/markers and recreate it with marker files; start_case (loopback listener 127.0.0.1:8088); writes /srv/work/m_*.out and m_resp.webp; deliberately
#   writes the marker into the distro journal (run B and a logger line in run C) and to /var/tmp/tjspike2-ctl.txt (removed after); read-only greps over journal, dmesg,
#   /var/log /tmp /etc /opt and the unit's mount namespace; ends with stop of tj-wrapper units and rm -rf of the drop-in.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 3: EXIF/comment marker logging proof
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
M=TJ-MARKER-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
echo "marker=$M"
D=/srv/markers; rm -rf $D; mkdir -p $D
python3 -I /srv/work/mkmarker.py /srv/fix/p24.jpg $D/marker.jpg "$M"
cp $D/marker.jpg $D/marker_trunc.jpg; truncate -s 60000 $D/marker_trunc.jpg
magick /srv/fix/p24.jpg -set comment "$M" -set Description "$M" PNG:$D/marker.png
printf 'plain text with %s inside, not an image\n' "$M" > $D/marker.txt
printf 'GIF89a%s garbage' "$M" > $D/marker_badgif.gif
for f in marker.jpg marker_trunc.jpg marker.png marker.txt marker_badgif.gif; do echo "  $f: $(wc -c < $D/$f) bytes, marker occurrences in file: $(grep -a -c -F "$M" $D/$f)"; done
export M

search() {  # $1 = label
  echo "-- SEARCH ($1) for $M"
  H1=$(journalctl -a --no-pager -o verbose 2>/dev/null | grep -a -c -F "$M")
  H1b=$(journalctl -a -k --no-pager 2>/dev/null | grep -a -c -F "$M")
  H2=$(journalctl -a -u tj-wrapper.service -u tj-wrapper.socket --no-pager -o verbose 2>/dev/null | grep -a -c -F "$M")
  H3=$(dmesg 2>/dev/null | grep -a -c -F "$M")
  H4=$(grep -r -a -l -F "$M" /var/log /var/tmp /tmp /dev/shm /run /var/lib/systemd /var/cache /etc /opt 2>/dev/null | grep -v -E '^/tmp/(w\.sh)' | tr '\n' ' ')
  PRIV=$(ls -d /tmp/systemd-private-*tj-wrapper.service-* 2>/dev/null | head -1)
  H5=$( [ -n "$PRIV" ] && grep -r -a -l -F "$M" "$PRIV" /var/tmp/systemd-private-*tj-wrapper.service-* 2>/dev/null | tr '\n' ' ')
  # unit's own mount namespace, writable paths, if the unit is running
  PID=$(systemctl show -p MainPID --value tj-wrapper.service)
  H6=$( [ "$PID" != 0 ] && nsenter -m -t $PID sh -c "grep -r -a -l -F '$M' /tmp /var/tmp /dev/shm 2>/dev/null" | tr '\n' ' ')
  echo "   journald all units+kernel (journalctl -a -o verbose): $H1 hits; kernel ring in journal: $H1b; tj-wrapper unit journal: $H2; dmesg: $H3"
  echo "   files containing marker under /var/log /var/tmp /tmp /dev/shm /run /var/lib/systemd /var/cache /etc /opt: [${H4}]"
  echo "   unit private tmp dir on host (${PRIV:-none}): [${H5}]  inside unit mount ns /tmp /var/tmp /dev/shm: [${H6}]"
  echo "   TOTAL_HITS=$((H1 + H1b + H2 + H3)) file_hits=$(echo $H4 $H5 $H6 | wc -w)"
}

echo "##### A. approved unit, 5 marker inputs"
start_case ""
for f in marker.jpg marker_trunc.jpg marker.png marker.txt marker_badgif.gif; do
  python3 -I $W/client.py 8088 $D/$f 1 > $W/m_$f.out 2>&1; echo "   $f -> $(cut -c1-90 $W/m_$f.out)"
done
# does the marker survive into the stored WebP / response? (-strip should remove it)
python3 -I $W/client.py 8088 $D/marker.jpg 1 $W/m_resp.webp >/dev/null; echo "   marker in returned WebP bytes: $(grep -a -c -F "$M" $W/m_resp.webp)  (stored image metadata stripped?)"
journalctl -u tj-wrapper.service --since "-1min" --no-pager -o cat | grep -E 'req' | sed 's/ms=[0-9]*//' | sort | uniq -c
search "approved unit"

echo "##### B. POSITIVE CONTROL: same unit with WRAP_LOG_MARKER=1 (deliberately logs the marker)"
start_case $'[Service]\nEnvironment=WRAP_LOG_MARKER=1'
python3 -I $W/client.py 8088 $D/marker.jpg 1 | cut -c1-60
search "positive control (wrapper deliberately logs)"
echo "   journal lines: $(journalctl -a -u tj-wrapper.service --since '-1min' --no-pager -o cat | grep -a -F "$M" | cut -c1-120)"

echo "##### C. second positive control for the greps themselves: logger + file in /var/tmp"
logger -t tjspike2-ctl "ctl line $M"; echo "$M" > /var/tmp/tjspike2-ctl.txt; sleep 1
search "logger + file control"
rm -f /var/tmp/tjspike2-ctl.txt
systemctl stop tj-wrapper.socket tj-wrapper.service; rm -rf $DROP; systemctl daemon-reload

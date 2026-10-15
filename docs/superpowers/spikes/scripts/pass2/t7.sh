# PROVES: Task 7 (write-up section 7): local latency, 20 sequential runs per input over loopback (p50/p95/max) for photo4mp.jpg, p05.jpg, d_alpha.png, d_anim.gif,
#   d_lossy.webp, s_50mp.png, s_50mp.jpg.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh and SPIKE_PASS2 (this pass2 directory, to find lib.sh); /srv/fix/*
#   incl. photo4mp.jpg (made by setup.sh). Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: sync_files and start_case (loopback listener 127.0.0.1:8088); 7 x 20 POSTs; prints CPU model and CPUQuota; ends with stop of tj-wrapper units and rm -rf of
#   the drop-in.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
start_case "" >/dev/null
echo "box: nproc=$(nproc) $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2) ; unit CPUQuota=$(systemctl show tj-wrapper.service -p CPUQuotaPerSecUSec --value)"
for f in photo4mp.jpg p05.jpg d_alpha.png d_anim.gif d_lossy.webp s_50mp.png s_50mp.jpg; do python3 -I $W/client.py 8088 /srv/fix/$f 20 | python3 -I -c "
import sys,json; d=json.loads(sys.stdin.read()); print('%-14s %-5s %-11s in->scan %-9s runs=%d p50=%8.1f ms p95=%8.1f ms max=%8.1f ms' % (d['file'], d['fmt'], 'x'.join(map(str,d['dims'])), 'x'.join(map(str,d['scan'])), d['runs'], d['p50_ms'], d['p95_ms'], d['max_ms']))"; done
ls -la /srv/fix/photo4mp.jpg | awk '{print "photo4mp.jpg bytes", $5}'
systemctl stop tj-wrapper.socket tj-wrapper.service; rm -rf $DROP; systemctl daemon-reload

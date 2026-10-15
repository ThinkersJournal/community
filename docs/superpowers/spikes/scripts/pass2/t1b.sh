# PROVES: unclear from the write-up; see section 1 (directive findings). It reinstalls the unit file and wrapper.py, restarts the socket and sends p05.jpg once, so it
#   is a re-test step.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/); reads pass2/units/tj-wrapper.service, pass2/wrapper.py, /srv/work/client.py and
#   /srv/fix/p05.jpg. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: cp to /etc/systemd/system/tj-wrapper.service and /opt/tj/wrapper.py; daemon-reload; systemctl stop tj-wrapper.service, reset-failed 'tj-wrapper*'; restart
#   tj-wrapper.socket (loopback listener 127.0.0.1:8088); one POST; reads the journal. Does not stop the unit afterwards.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
SP="${SPIKE_DIR:?set SPIKE_DIR to the work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/}"
cp $SP/pass2/units/tj-wrapper.service /etc/systemd/system/; systemctl daemon-reload; cp $SP/pass2/wrapper.py /opt/tj/wrapper.py
systemctl stop tj-wrapper.service 2>/dev/null; systemctl reset-failed 'tj-wrapper*'; systemctl restart tj-wrapper.socket
python3 -I /srv/work/client.py 8088 /srv/fix/p05.jpg 1
journalctl -u tj-wrapper.service --since "-30s" --no-pager -o cat | tail -5

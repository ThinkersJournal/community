# PROVES: Task 6 teardown (write-up sections 6 'Teardown' and 10): stops the tunnel and reads back that no cloudflared, strace or inotifywait processes and no listeners
#   remain in the distro.
# INPUTS: SPIKE_PASS2 (this pass2 directory, to find lib.sh) and SPIKE_DIR (via lib.sh); state from t6a.sh: /srv/work/t6/cf.pid, ino.pid, cf_strace.pid, cf.log. Runs
#   inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: kill of the cloudflared PID in cf.pid (closing the public quick tunnel) and of the inotifywait PID in ino.pid; systemctl stop tj-wrapper.socket/.service; rm
#   -rf of the drop-in; daemon-reload; read-only listener and process listing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: the kills are by PID file, inside the distro; if a PID file is stale, the PID could
#   belong to another process.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
T=/srv/work/t6
CF=$(cat $T/cf.pid); echo "killing cloudflared pid $CF (comm=$(cat /proc/$CF/comm))"
kill $CF; sleep 3
echo "cloudflared alive: $(pgrep -x cloudflared | wc -l); strace alive: $(kill -0 $(cat $T/cf_strace.pid) 2>/dev/null && echo yes || echo no)"
tail -3 $T/cf.log | cut -c1-200
kill $(cat $T/ino.pid) 2>/dev/null
echo "inotifywait alive: $(pgrep -c inotifywait)"
systemctl stop tj-wrapper.socket tj-wrapper.service; rm -rf $DROP; systemctl daemon-reload
echo "listeners in distro now:"; ss -ltnup | tail -n +2 | awk '{print $1,$5,$7}'
echo "remaining processes named cloudflared/strace/inotifywait/python3 wrapper: $(pgrep -a -f 'cloudflared|strace|inotifywait|wrapper.py' | wc -l)"

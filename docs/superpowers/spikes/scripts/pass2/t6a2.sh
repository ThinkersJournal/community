# PROVES: unclear from the write-up; see section 6 (disk checks). It re-attaches strace to the wrapper MainPID after t6a.sh and checks that the earlier inotifywait and
#   cloudflared are alive.
# INPUTS: SPIKE_PASS2 (this pass2 directory, to find lib.sh) and SPIKE_DIR (via lib.sh); needs the state from t6a.sh in /srv/work/t6 (ino.pid, cf.pid). Runs inside the
#   throwaway distro (tjspike2-systemd) as root.
# EFFECTS: starts a background nohup strace -f -p on the wrapper writing /srv/work/t6/wrapper_trace.txt (overwrites it) and wstrace.pid; kill -0 liveness checks only;
#   does not touch the tunnel.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
T=/srv/work/t6
WPID=$(systemctl show -p MainPID --value tj-wrapper.service)
echo "wrapper pid=$WPID"
nohup strace -f -y -s 256 -o $T/wrapper_trace.txt -e $SC -p $WPID > /dev/null 2>$T/wrapper_strace.err &
echo $! > $T/wstrace.pid
sleep 2
cat $T/wrapper_strace.err | head -2; echo "inotify pid $(cat $T/ino.pid) alive: $(kill -0 $(cat $T/ino.pid) && echo yes)"; echo "cf alive: $(kill -0 $(cat $T/cf.pid) && echo yes)"

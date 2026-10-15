# PROVES: unclear from the write-up; see section 6 (disk checks). Same job as t6a2.sh (re-attach strace to the wrapper) but started with setsid and without the liveness
#   checks.
# INPUTS: SPIKE_PASS2 (this pass2 directory, to find lib.sh) and SPIKE_DIR (via lib.sh); needs /srv/work/t6 from t6a.sh. Runs inside the throwaway distro
#   (tjspike2-systemd) as root.
# EFFECTS: starts a background nohup setsid strace -f -p on the wrapper MainPID writing /srv/work/t6/wrapper_trace.txt (overwrites it) and wstrace.pid; kill -0 check
#   only.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
T=/srv/work/t6
WPID=$(systemctl show -p MainPID --value tj-wrapper.service)
nohup setsid strace -f -y -s 256 -o $T/wrapper_trace.txt -e $SC -p $WPID > /dev/null 2>$T/wrapper_strace.err < /dev/null &
echo $! > $T/wstrace.pid
sleep 2
echo "wrapper pid=$WPID; wrapper strace alive: $(kill -0 $(cat $T/wstrace.pid) && echo yes); $(head -1 $T/wrapper_strace.err)"

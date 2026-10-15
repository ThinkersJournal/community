# PROVES: unclear from the write-up; see section 6 (disk checks). It restarts the inotifywait watcher over /srv/cfwork /tmp /var/tmp /dev/shm and runs a touch control.
# INPUTS: none from env; needs the state from t6a.sh in /srv/work/t6 (ino.pid, wstrace.pid, cf.pid). Does not source lib.sh. Runs inside the throwaway distro
#   (tjspike2-systemd) as root.
# EFFECTS: starts a background nohup setsid inotifywait writing /srv/work/t6/ino_cf.txt (overwrites it) and ino.pid; touches then removes /tmp/tjspike2-ino-ctl; kill -0
#   checks only. Does not stop the earlier watcher.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
T=/srv/work/t6
cat $T/ino_cf.err | head -3
nohup setsid inotifywait -m -r -q -e create,modify,moved_to,attrib,delete /srv/cfwork /tmp /var/tmp /dev/shm > $T/ino_cf.txt 2>$T/ino_cf.err < /dev/null &
echo $! > $T/ino.pid
sleep 1
echo "inotify alive: $(kill -0 $(cat $T/ino.pid) && echo yes); wrapper strace alive: $(kill -0 $(cat $T/wstrace.pid) && echo yes); cf alive: $(kill -0 $(cat $T/cf.pid) && echo yes)"
echo "touch control:"; touch /tmp/tjspike2-ino-ctl; sleep 1; wc -l < $T/ino_cf.txt; rm -f /tmp/tjspike2-ino-ctl; sleep 1; wc -l < $T/ino_cf.txt

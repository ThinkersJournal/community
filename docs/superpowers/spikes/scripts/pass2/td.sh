# PROVES: the distro-side teardown readings of write-up sections 6 and 10 (no tj-*/tjspike2-* units, no TCP listeners, no cloudflared/inotifywait/strace/wrapper/magick
#   processes). The write-up does not say that this exact script produced its numbers.
# INPUTS: none (no env vars or arguments); run inside the throwaway distro.
# EFFECTS: read-only (systemctl list-units, /proc/net/*, pgrep); prints counts and listening-socket addresses; writes nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
echo "systemd units tj-*/tjspike2-*: $(systemctl list-units --all --no-legend 'tj-*' 'tjspike2-*' | wc -l)"
echo "LISTEN tcp sockets (/proc/net/tcp state 0A): $(awk 'NR>1 && $4=="0A"' /proc/net/tcp /proc/net/tcp6 | wc -l)"
awk 'NR>1 && $4=="0A"{print $2}' /proc/net/tcp /proc/net/tcp6
echo "udp sockets bound: $(awk 'NR>1' /proc/net/udp /proc/net/udp6 | wc -l)"
echo "processes cloudflared/inotifywait/strace/wrapper/magick: $(pgrep -a -f 'cloudflared|inotifywait|strace|wrapper.py|magick' | wc -l)"
echo "transient units left: $(systemctl list-units --all --no-legend | grep -c tjspike2)"

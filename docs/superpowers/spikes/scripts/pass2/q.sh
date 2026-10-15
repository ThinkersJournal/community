# PROVES: unclear from the write-up; see section 1 (it only prints the last 10 minutes of the tj-wrapper.service journal, cut to 120 characters per line).
# INPUTS: none (no env vars or arguments); run inside the throwaway distro as root.
# EFFECTS: read-only (journalctl); writes nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
journalctl -u tj-wrapper.service --since "-10min" --no-pager -o cat | cut -c1-120

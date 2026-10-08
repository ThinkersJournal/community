# PROVES: Task 1 (write-up section 1; summary item 1): systemd-analyze security exposure of tj-wrapper.service, the unit properties, and the six inputs (p05.jpg,
#   d_alpha.png, d_anim.gif, d_lossy.webp, s_50mp.png, s_50mp.jpg) returning results through the hardened unit.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) (used for out2/ only); needs the unit already started (e.g. by start_case) and
#   /srv/work/client.py and /srv/fix/* staged by setup.sh. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: writes out2/t1_analyze_security.txt and out2/t1_six.txt; sends six POSTs to the loopback listener 127.0.0.1:8088; reads the journal. Stops/starts nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 1
OUT="${SPIKE_DIR:?set SPIKE_DIR}/out2"
systemd-analyze security tj-wrapper.service --no-pager > $OUT/t1_analyze_security.txt 2>&1
tail -1 $OUT/t1_analyze_security.txt; grep -c '✓' $OUT/t1_analyze_security.txt; grep '✗' $OUT/t1_analyze_security.txt
systemctl show tj-wrapper.service -p DynamicUser,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,PrivateDevices,PrivateNetwork,MemoryMax,MemorySwapMax,LimitCORE,LimitFSIZE,TasksMax,RestrictAddressFamilies,MemoryDenyWriteExecute,SystemCallFilter | tr '\n' ';' ; echo
for f in p05.jpg d_alpha.png d_anim.gif d_lossy.webp s_50mp.png s_50mp.jpg; do python3 -I /srv/work/client.py 8088 /srv/fix/$f 1; done | tee $OUT/t1_six.txt
journalctl -u tj-wrapper.service --since "-2min" --no-pager -o cat | tail -8
systemctl show tj-wrapper.service -p MainPID,ActiveState

#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Read-back of the VPS image service's host settings (S18 a; CireSnave 2026-10-25).
#
# The design (docs/superpowers/specs/2026-10-08-vps-image-service-design.md, section 3.3)
# lists 13 things only the person with the server can check. This prints each one's
# CURRENT value, with what to expect, so the output can be pasted back and compared:
# a read-back, not an assumption. It changes NOTHING: no service is started or
# stopped, no sysctl is written, no file is created outside a temp file it removes, no
# process is signalled. test/verify-host-script.node.test.ts fails if a mutating
# command is ever added.
#
#   sudo bash scripts/verify-host.sh 2>&1 | tee verify-host.out
#
# Run it on the production host, as root, after the service and tunnel are installed.
# The service unit is assumed to be called tj-decoder (override: UNIT=name).
#
# NOT run by this script, because they act on the system or need a second machine: the
# SEGV-leaves-no-core test (item 2), nmap from another machine (item 4), the marker
# tests (items 5 and 8), the concurrent 50 MP load test (item 7) and the 15 MB POST
# through the tunnel (item 13). The design lists them; run them by hand.
#
# Lines starting "CHECK" are a mechanical comparison against the expected value;
# "NOTE" lines ask a person to read the output above them. Nothing here is a verdict:
# a CHECK that says OK only means that one command printed the expected thing.
set -u

UNIT="${UNIT:-tj-decoder}"
ok=0
bad=0

section() { printf '\n==== %s ====\n' "$1"; }
show() { printf '$ %s\n' "$*"; "$@" 2>&1 || true; }
# show_sh runs a shell pipeline; the text is printed first so the paste is self-describing.
show_sh() { printf '$ %s\n' "$1"; bash -c "$1" 2>&1 || true; }
check() { # check "label" <test command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then printf 'CHECK OK    %s\n' "$label"; ok=$((ok + 1)); else printf 'CHECK FAIL  %s\n' "$label"; bad=$((bad + 1)); fi
}
note() { printf 'NOTE        %s\n' "$1"; }

printf 'verify-host.sh  %s  host=%s  unit=%s\n' "$(date -u +%FT%TZ)" "$(hostname)" "$UNIT"
if [ "$(id -u)" != "0" ]; then
  echo "WARNING: not root. Several commands below will show less than the real value."
fi

section "1. Host swap absent or encrypted"
show_sh "swapon --show --noheadings | wc -l"
show cat /proc/swaps
show_sh "grep -i swap /etc/fstab"
show_sh "zramctl"
show_sh "systemctl list-units --type=swap --no-legend"
show_sh "systemctl is-enabled hibernate.target"
show_sh "cat /sys/power/state"
show systemctl show "$UNIT" -p MemorySwapMax
show_sh "cat /sys/fs/cgroup/system.slice/$UNIT.service/memory.swap.max"
show stat -fc %T /sys/fs/cgroup
check "no active swap" test "$(swapon --show --noheadings 2>/dev/null | wc -l)" = "0"
check "unit MemorySwapMax=0" bash -c "systemctl show $UNIT -p MemorySwapMax | grep -qx 'MemorySwapMax=0'"
note "If any swap exists: lsblk must show it under a crypt device with an /etc/crypttab entry using /dev/urandom and swap."

section "2. Core dumps and kdump"
show sysctl kernel.core_pattern fs.suid_dumpable
show_sh "systemctl is-enabled kdump kdump-tools apport systemd-coredump.socket"
show_sh "grep -o 'crashkernel=[^ ]*' /proc/cmdline"
show_sh "coredumpctl list --no-pager"
show_sh "ls /var/crash /var/lib/systemd/coredump /var/lib/apport/coredump"
show_sh "cat /etc/systemd/coredump.conf.d/* 2>/dev/null"
check "core_pattern is |/bin/false" bash -c "sysctl -n kernel.core_pattern | grep -qx '|/bin/false'"
check "fs.suid_dumpable is 0" bash -c "test \"\$(sysctl -n fs.suid_dumpable)\" = 0"
check "no crashkernel= on the command line" bash -c "! grep -q 'crashkernel=' /proc/cmdline"
note "The SEGV test (kill -SEGV the unit's main PID, then look for a core) is NOT run here. Do it by hand, after first producing a dump with LimitCORE=infinity and a temporary file core_pattern (design 3.3 item 2)."

section "3. Provider snapshots and backups (cannot be read from inside the VM)"
show_sh "crontab -l"
show_sh "ls /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly"
show_sh "systemctl list-timers --all --no-legend | grep -i -E 'backup|snap|restic|borg|rsync'"
note "In writing from the provider: (a) are snapshots on, do they include RAM; (b) are backups on and what they cover; (c) can staff take a memory snapshot. With the hcloud CLI: hcloud server describe <name> -o json; hcloud image list -t snapshot."

section "4. Firewall: default-deny inbound"
show_sh "ufw status verbose"
show_sh "nft list ruleset"
show_sh "iptables -S"
show_sh "ss -ltnup"
note "Expect: default deny incoming, only SSH allowed; the decoder and cloudflared metrics only on 127.0.0.1. nmap -Pn -p- <public-ip> from ANOTHER machine, and the provider's firewall rules in its dashboard, are NOT checked here."

section "5. Tunnel and proxy logging and spooling"
show_sh "systemctl cat cloudflared"
show_sh "ps -o args= -C cloudflared"
show_sh "cat /etc/cloudflared/config.yml"
show_sh "ls -la /var/log/cloudflared*"
show_sh "journalctl -u cloudflared --since '-1h' -o cat | grep -c -i -E 'GET|POST|request'"
show_sh "nginx -T 2>/dev/null | grep -E 'access_log|client_body_temp_path|proxy_request_buffering|client_body_buffer_size'"
show_sh "ls -la /var/lib/nginx/body"
note "Expect: --loglevel warn or error, no --logfile, --no-autoupdate, an unprivileged user, no logDirectory, no log files, the request count 0. Cloudflare-side logging (Zero Trust Logs, Logpush, Access policy) is a dashboard check. The marker test is NOT run here."

section "6. Kernel and hypervisor"
show uname -r
show_sh "systemd --version | head -1"
show systemd-detect-virt
show stat -fc %T /sys/fs/cgroup
show cat /sys/fs/cgroup/cgroup.controllers
show_sh "grep Seccomp /proc/\$(systemctl show -p MainPID --value $UNIT)/status"
show_sh "systemd-analyze security $UNIT --no-pager | tail -3"
show_sh "findmnt -no FSTYPE /tmp /var/tmp /dev/shm"
check "cgroup v2" bash -c "test \"\$(stat -fc %T /sys/fs/cgroup)\" = cgroup2fs"
check "memory controller present" bash -c "grep -qw memory /sys/fs/cgroup/cgroup.controllers"
check "service runs under seccomp (Seccomp: 2)" bash -c "grep -qE '^Seccomp:[[:space:]]+2' /proc/\$(systemctl show -p MainPID --value $UNIT)/status"
note "Expect a 5.x or later kernel and an overall exposure of 1.0 or lower. Re-run the pass-2 proof suite (unit, strace, inotify, read-only and marker tests) on this host: NOT run here."

section "7. Real CPU and RAM"
show nproc
show_sh "lscpu | grep -E 'Model name|Flags' | grep -o -E 'Model name.*|avx2|sse4_2'"
show free -m
show_sh "cat /sys/fs/cgroup/system.slice/$UNIT.service/memory.max"
note "The load test (3 to 4 simultaneous 50 MP uploads, reading memory.peak and memory.events; expect oom_kill 0) and the WebP SHA-256 comparison against pass 2 are NOT run here."

section "8. Persistent journal and log forwarding"
show journalctl --disk-usage
show_sh "ls -d /var/log/journal"
show_sh "systemd-analyze cat-config systemd/journald.conf | grep -E '^(Storage|MaxLevelStore|ForwardTo|Compress|Seal)'"
show systemctl show "$UNIT" -p LogLevelMax
show_sh "systemctl list-units --no-legend | grep -i -E 'rsyslog|syslog-ng|promtail|vector|fluent|filebeat|journalbeat|datadog|otel|newrelic|vmagent'"
check "unit LogLevelMax=notice" bash -c "systemctl show $UNIT -p LogLevelMax | grep -qx 'LogLevelMax=notice'"
note "Expect Storage=volatile (or a persistent journal accepted knowingly), no forwarding agent that ships this unit's logs."

section "9. File-level capture of writable paths"
show findmnt -no TARGET,FSTYPE,OPTIONS /tmp /var/tmp /dev/shm /run
show_sh "nsenter -m -t \$(systemctl show -p MainPID --value $UNIT) findmnt -rn -o TARGET,OPTIONS | awk '\$2 ~ /(^|,)rw(,|\$)/'"
note "Expect only /dev/pts, /dev/mqueue, /dev/hugepages, /proc and /sys/... and none of /tmp /var /var/tmp /dev/shm /run. A disk-backed /var/tmp would be in provider disk snapshots."

section "10. Patching of the decoder libraries"
show systemctl is-enabled unattended-upgrades
show_sh "apt-config dump | grep -E 'Unattended-Upgrade::(Allowed-Origins|Automatic-Reboot)'"
show_sh "apt list --upgradable 2>/dev/null | grep -E 'imagemagick|libmagick|libjpeg|libwebp|libpng|libheif|libtiff'"
show_sh "magick -version | head -1"
show_sh "dpkg -l libwebp7 libjpeg62-turbo | awk '/^ii/{print \$2,\$3}'"
note "Expect unattended upgrades enabled with the security origin allowed, nothing upgradable, and versions equal to the allow-listed build_id."

section "11. Who can read the decoder's memory"
show getent group sudo adm
show last -n 20
show_sh "ss -tnp | grep :22"
note "Expect only the owner. Root can read /proc/<pid>/mem of the decoder: an operational control, to be documented."

section "12. HMAC secret and tunnel credentials"
show_sh "stat -c '%U %a %n' /etc/tj-decoder/* /etc/cloudflared/* ~/.cloudflared/*"
show systemctl show "$UNIT" -p LoadCredential -p EnvironmentFiles
note "Expect mode 600 or 640, owner root or the service user, none world-readable; the secret passed by systemd credentials rather than Environment=. File CONTENTS are never printed."
bad_modes=$(stat -c '%a %n' /etc/tj-decoder/* /etc/cloudflared/* ~/.cloudflared/* 2>/dev/null | awk '{ if (substr($1, length($1)) != "0") print }' | wc -l)
if [ "$bad_modes" = "0" ]; then printf 'CHECK OK    no listed file is world-accessible\n'; ok=$((ok + 1)); else printf 'CHECK FAIL  %s listed file(s) are world-accessible\n' "$bad_modes"; bad=$((bad + 1)); fi

section "13. Network path from Cloudflare to the VPS"
note "NOT measurable from the host. From a Worker, or curl through the production tunnel hostname, POST 15 MB and read %{time_total}."

printf '\n==== summary ====\nCHECK OK: %s   CHECK FAIL: %s\n' "$ok" "$bad"
printf 'The NOTE lines and the items marked NOT run still need a person.\n'
exit 0

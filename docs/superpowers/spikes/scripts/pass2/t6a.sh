#!/bin/bash
# PROVES: Task 6 (write-up section 6, quick tunnel), setup half: stages cloudflared and starts the wrapper and an strace'd quick tunnel for the disk checks. LEAVES
#   EVERYTHING RUNNING; t6b.sh analyses and t6c.sh tears down.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh (reads vendor2/cloudflared-dl/cloudflared-linux-amd64) and
#   SPIKE_PASS2 (this pass2 directory, to find lib.sh); needs /srv/markers (made by t3.sh), /srv/work/mkmarker.py. It only prints the published sha256 next to the
#   computed one; it does not compare them. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: OPENS A PUBLIC CLOUDFLARE QUICK TUNNEL: cloudflared makes outbound connections and exposes the test wrapper on 127.0.0.1:8088 through a random
#   trycloudflare.com name to anyone who has the name; also starts the wrapper (start_case), background strace on the wrapper and on cloudflared, and inotifywait;
#   creates /opt/cf, /srv/cfwork, /srv/fix/noise16.jpg and /srv/work/t6/*; whole-filesystem find snapshot.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units. Separately, it creates the public tunnel described in EFFECTS.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 6a: stage cloudflared inside the throwaway distro, start wrapper + strace'd quick tunnel; leave running
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
mkdir -p /opt/cf /srv/cfwork/home /srv/cfwork/cwd
cp $SP/vendor2/cloudflared-dl/cloudflared-linux-amd64 /opt/cf/cloudflared; chmod 755 /opt/cf/cloudflared
echo "sha256 in distro: $(sha256sum /opt/cf/cloudflared | cut -d' ' -f1)"
echo "published        : d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db (release 2026.10.0 notes)"
/opt/cf/cloudflared --version
cd /srv/fix
if [ ! -f noise16.jpg ]; then magick -size 3300x3300 xc: +noise Random -colorspace sRGB -quality 95 JPEG:noise16.jpg; fi
ls -la noise16.jpg | awk '{print "noise16.jpg bytes:", $5, "=", $5/1048576, "MiB"}'
python3 -I /srv/work/mkmarker.py /srv/fix/noise16.jpg /srv/markers/tunnel_marker.jpg "TJ-MARKER-TUNNEL-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
grep -a -o 'TJ-MARKER-TUNNEL-[0-9a-f]*' /srv/markers/tunnel_marker.jpg | head -1 > /srv/work/tunnel_marker.txt; cat /srv/work/tunnel_marker.txt
start_case "" | tail -2
WPID=$PID
echo "wrapper MainPID=$WPID"
T=/srv/work/t6; rm -rf $T; mkdir -p $T
date +%s > $T/stamp
ls -la /tmp /var/tmp /dev/shm /srv/cfwork/home /srv/cfwork/cwd > $T/ls_before.txt 2>&1
find / -xdev \( -path /proc -o -path /sys -o -path /mnt -o -path /var/log/journal -o -path /srv/work -o -path /srv/det -o -path /srv/markers -o -path /run/log/journal \) -prune -o -type f -print 2>/dev/null | sort > $T/files_before.txt
wc -l < $T/files_before.txt
# watchers: inotify on cloudflared cwd/home, tmp locations; strace on wrapper (follow children)
inotifywait -m -r -q -e create,modify,moved_to,attrib,delete /srv/cfwork /tmp /var/tmp /dev/shm > $T/ino_cf.txt 2>$T/ino_cf.err &
echo $! > $T/ino.pid
strace -f -y -s 256 -o $T/wrapper_trace.txt -e $SC -p $WPID 2>$T/wrapper_strace.err &
echo $! > $T/wstrace.pid
sleep 1
cd /srv/cfwork/cwd
SCC="trace=openat,open,creat,mkdir,mkdirat,rename,renameat,renameat2,link,symlink,truncate,ftruncate,fallocate,memfd_create,write,pwrite64,writev,pwritev,sendfile,copy_file_range,unlink,unlinkat"
HOME=/srv/cfwork/home TMPDIR=/tmp nohup strace -f -y -s 64 -o $T/cf_trace.txt -e $SCC /opt/cf/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8088 > $T/cf.log 2>&1 &
echo $! > $T/cf_strace.pid
for i in $(seq 1 60); do U=$(grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' $T/cf.log | head -1); [ -n "$U" ] && break; sleep 1; done
echo "tunnel url: $U"
echo "$U" > $T/url.txt
sleep 6
CFPID=$(pgrep -x cloudflared | head -1); echo "cloudflared pid=$CFPID strace_pid=$(cat $T/cf_strace.pid)"; echo $CFPID > $T/cf.pid
echo "listeners (cloudflared): $(ss -tnp 2>/dev/null | grep -c cloudflared) established conns"
tail -c 600 $T/cf.log

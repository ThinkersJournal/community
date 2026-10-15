# PROVES: Stage B2, section 5: 'Proof step 1' syscall trace (file, memfd and pipe stdin), negative controls (spill policy, write probe), 'Proof step 3' inotify, memory-limit error with disk 0, 'Proof step 5' RLIMIT_FSIZE=0, and 'Proof step 6' VmSwap/core.
# INPUTS: no arguments; env ALLOW_MEMFD is set by the script for one run. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Needs strace, inotifywait, python3 and SYS_PTRACE (the script's own line 1 says so; the write-up does not state the container capabilities used). Reads /s/pol/prod2.xml, /s/runim.py, /s/stracecheck.py, /fix/set and /fix/big.
# EFFECTS: strace -f of decodes; runs inotifywait watchers on /tmp, /var/tmp, /dev/shm, /run, /var/lib, /var/cache, /root and / and kills only those backgrounded watchers (kill $IP); writes /tmp/tr, /tmp/ino.log, /tmp/pol; the pipe and spill runs deliberately create magick-* files in / and /tmp, then rm -f /magick-* /tmp/magick-*; uses ulimit -f 0 subshells.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers). The kill and rm commands act only inside the container on the script's own background jobs and files.
# ARCHIVED: preserved verbatim from the spike session.
# Stage B2: no-disk proof steps 1,3 + negative controls. Runs in container (needs SYS_PTRACE for strace).
mkdir -p /tmp/pol/prod2 /tmp/pol/spill
cp /s/pol/prod2.xml /tmp/pol/prod2/policy.xml
sed 's|name="memory" value="512MiB"|name="memory" value="64MiB"|;s|name="map"    value="0"|name="map" value="64MiB"|;s|name="disk"   value="0"|name="disk" value="1GiB"|' /s/pol/prod2.xml > /tmp/pol/spill/policy.xml
grep -E 'name="(disk|memory|map)"' /tmp/pol/spill/policy.xml
SC="trace=openat,open,creat,mkdir,mkdirat,rename,renameat,renameat2,link,linkat,symlink,symlinkat,truncate,ftruncate,fallocate,memfd_create,mmap,write,pwrite64,writev,sendfile,copy_file_range,unlink,unlinkat"
mkdir -p /tmp/tr
INPUTS="/fix/set/p05.jpg:jpeg /fix/set/d_alpha.png:png /fix/set/d_anim.gif:gif /fix/set/d_lossy.webp:webp /fix/big/s_50mp.png:png /fix/big/s_50mp.jpg:jpeg"
runall() { # label mode poldir tmpdir
  lab=$1; mode=$2; pol=$3; tmpd=$4
  rm -f /tmp/tr/*
  i=0
  for ic in $INPUTS; do
    f=${ic%%:*}; c=${ic##*:}; i=$((i+1))
    strace -f -y -o /tmp/tr/t$i.txt -e $SC python3 -I -B /s/runim.py $mode $f $c $pol $tmpd | sed "s/^/  $lab /"
  done
  python3 -I /s/stracecheck.py /tmp/tr/t*.txt
  echo "  checker_exit=$?"
}
echo "== B2.1a strace proof: production policy, stdin = regular file (seekable), tmpdir=/nonexistent"
runall prod2/file file /tmp/pol/prod2 /nonexistent
echo "== B2.1b strace proof: production policy, stdin = memfd (RAM-only seekable fd), tmpdir=/nonexistent (memfd allowed, counted)"
ALLOW_MEMFD=1 runall prod2/memfd memfd /tmp/pol/prod2 /nonexistent
echo "== B2.1c same memfd run WITHOUT the allowance: checker must flag memfd_create (control)"
python3 -I /s/stracecheck.py /tmp/tr/t1.txt | head -3
echo "== B2.1d HAZARD: stdin = anonymous pipe (what a service would naturally do), production policy"
runall prod2/pipe pipe /tmp/pol/prod2 /nonexistent
rm -f /magick-*
echo "== NEGATIVE CONTROL (a): spill policy (disk 1GiB, memory/map 64MiB), stdin=file, tmpdir=/tmp: IM must write magick-* temp file; checker must FLAG"
runall spill/file file /tmp/pol/spill /tmp
rm -f /tmp/magick-*
echo "== NEGATIVE CONTROL (b): wrapper writes /tmp/probe; checker must FLAG"
strace -f -y -o /tmp/tr/w.txt -e $SC sh -c "echo x > /tmp/probe"
python3 -I /s/stracecheck.py /tmp/tr/w.txt
echo "  checker_exit=$?"
rm -f /tmp/probe
echo "== B2.3 inotify event proof (file mode)"
WATCH="/tmp /var/tmp /dev/shm /run /var/lib /var/cache /root /"
runino() { # poldir tmpdir mode label
  rm -f /tmp/ino.log
  inotifywait -m -q -e create,modify,moved_to,attrib,close_write --exclude '(/tmp/(ino\.log|tr|tm\.txt|pol)|^/(proc|sys|dev)/)' /tmp /var/tmp /dev/shm /run /var/lib /var/cache /root / > /tmp/ino.log 2>&1 &
  IP=$!
  sleep 1
  for ic in $INPUTS; do
    f=${ic%%:*}; c=${ic##*:}
    python3 -I -B /s/runim.py $3 $f $c $1 $2 > /dev/null
  done
  sleep 1
  kill $IP 2>/dev/null
  wait $IP 2>/dev/null
  echo "  $4: inotify events=$(grep -c . /tmp/ino.log) $(head -3 /tmp/ino.log | tr '\n' ';')"
}
rm -f /tmp/ino.log
inotifywait -m -q -e create /tmp / > /tmp/ino.log 2>&1 &
IP=$!
sleep 1
touch /tmp/ctl_probe
sleep 1
kill $IP
wait $IP 2>/dev/null
echo "  inotify positive control (touch /tmp/ctl_probe): events=$(grep -c ctl_probe /tmp/ino.log)"
rm -f /tmp/ctl_probe
runino /tmp/pol/prod2 /nonexistent file "prod2/file"
runino /tmp/pol/prod2 /nonexistent memfd "prod2/memfd"
runino /tmp/pol/prod2 /nonexistent pipe "prod2/pipe (HAZARD)"
rm -f /magick-*
runino /tmp/pol/spill /tmp file "NEGATIVE CONTROL spill policy"
rm -f /tmp/magick-*
echo "== B2.4 resource-limit direction: 50MP png with MAGICK_MEMORY_LIMIT=64MiB on the prod2 policy (disk 0), stdin=file -> error, no temp file"
MAGICK_MEMORY_LIMIT=64MiB python3 -I -B /s/runim.py file /fix/big/s_50mp.png png /tmp/pol/prod2 /tmp
echo "magick-* files left in /tmp: $(ls /tmp/magick-* 2>/dev/null | wc -l)"
echo "default policy resource: $(magick -list resource 2>/dev/null | grep -E 'Disk|Memory|Map' | tr '\n' ' ')"
echo "prod2 policy resource: $(MAGICK_CONFIGURE_PATH=/tmp/pol/prod2 magick -list resource | grep -E 'Disk|Memory|Map' | tr '\n' ' ')"
echo "== B2.5 RLIMIT_FSIZE=0 belt (stdin=file): decode must still succeed; control with a write must fail"
sh -c 'ulimit -f 0; python3 -I -B /s/runim.py file /fix/set/p05.jpg jpeg /tmp/pol/prod2 /nonexistent'
sh -c 'ulimit -f 0; python3 -I -B /s/runim.py file /fix/big/s_50mp.png png /tmp/pol/prod2 /nonexistent'
sh -c 'ulimit -f 0; echo x > /tmp/fsz_probe' 2>&1
echo "  (control) write under ulimit -f 0: file size=$(stat -c %s /tmp/fsz_probe 2>/dev/null)"
rm -f /tmp/fsz_probe
echo "-- RLIMIT_FSIZE=0 + stdin=pipe (hazard mode): spool attempt must be killed"
sh -c 'ulimit -f 0; python3 -I -B /s/runim.py pipe /fix/set/p05.jpg jpeg /tmp/pol/prod2 /nonexistent'
echo "-- RLIMIT_FSIZE=0 + spill policy: decode of 50MP png must fail loudly"
sh -c 'ulimit -f 0; python3 -I -B /s/runim.py file /fix/big/s_50mp.png png /tmp/pol/spill /tmp'
rm -f /tmp/magick-* /magick-*
echo "== B2.6 VmSwap/VmHWM of a running 50MP decode, and core limit"
python3 -I -B /s/runim.py file /fix/big/s_50mp.png png /tmp/pol/prod2 /nonexistent > /dev/null &
sleep 1.2
for p in $(pgrep -x magick); do grep -E "VmSwap|VmHWM|VmRSS" /proc/$p/status | tr '\n' ' '; echo; done
wait
echo "ulimit -c in this shell: $(ulimit -c)"

# PROVES: Stage B2, section 5: with RO=1, 'Proof step 2, read-only root' (12 of 12 decodes in file and memfd modes, plus a negative control with the spill policy); without RO, per-input success under strace in file and memfd modes.
# INPUTS: env RO (RO=1 selects read-only-root mode, which the script's comment says runs under docker --read-only with :ro fixture mounts). Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/prod2.xml, /s/pol/prod2dir, /s/pol/spilldir, /s/runim.py, /fix/set, /fix/big. Non-RO mode needs strace and SYS_PTRACE (the write-up does not state the container capabilities used).
# EFFECTS: top lines create /tmp/pol/prod2 and /tmp/pol/spill (run in both modes; on a read-only root they just fail, there is no set -e); RO mode runs touch /tmp/rotest (expected to fail) and a spill-policy control expected to fail; non-RO mode writes the strace log to /tmp/t.txt (overwritten per run).
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
# Stage B3: per-input success under strace (file + memfd), run inside container with SYS_PTRACE; and read-only-root mode when RO=1
mkdir -p /tmp/pol/prod2 /tmp/pol/spill
cp /s/pol/prod2.xml /tmp/pol/prod2/policy.xml
sed 's|name="memory" value="512MiB"|name="memory" value="64MiB"|;s|name="map"    value="0"|name="map" value="64MiB"|;s|name="disk"   value="0"|name="disk" value="1GiB"|' /s/pol/prod2.xml > /tmp/pol/spill/policy.xml
INPUTS="/fix/set/p05.jpg:jpeg /fix/set/d_alpha.png:png /fix/set/d_anim.gif:gif /fix/set/d_lossy.webp:webp /fix/big/s_50mp.png:png /fix/big/s_50mp.jpg:jpeg"
if [ "$RO" = "1" ]; then
  echo "== B2.2 read-only root filesystem (docker --read-only, no tmpfs/volumes besides :ro fixture mounts)"
  touch /tmp/rotest 2>&1 | head -1
  for mode in file memfd; do
    for ic in $INPUTS; do
      f=${ic%%:*}; c=${ic##*:}
      python3 -I -B /s/runim.py $mode $f $c /s/pol/prod2dir /nonexistent
    done
  done
  echo "-- NEGATIVE CONTROL: spill policy with TMPDIR=/tmp on read-only root: 50MP decode must fail"
  python3 -I -B /s/runim.py file /fix/big/s_50mp.png png /s/pol/spilldir /tmp
  exit 0
fi
SC="trace=openat,open,creat,mkdir,mkdirat,rename,renameat,renameat2,link,linkat,symlink,symlinkat,truncate,ftruncate,fallocate,memfd_create,mmap,write,pwrite64,writev,sendfile,copy_file_range,unlink,unlinkat"
for mode in file memfd; do
  for ic in $INPUTS; do
    f=${ic%%:*}; c=${ic##*:}
    strace -f -y -o /tmp/t.txt -e $SC python3 -I -B /s/runim.py $mode $f $c /tmp/pol/prod2 /nonexistent
  done
done

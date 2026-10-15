# PROVES: Stage B, section 5 row 'Exit status on time-limit or damaged input': -regard-warnings does not change the exit code on a time-limited decode or a truncated JPEG, and benign photos give empty stderr. By its content; the write-up does not name this script.
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/prod2.xml, /fix/big/s_50mp.png and s_50mp.jpg, /fix/set/p01-p06.jpg; exports MAGICK_CONFIGURE_PATH=/tmp/pol/prod2.
# EFFECTS: writes /tmp/pol/prod2, /tmp/o.raw, /tmp/e and /tmp/trunc.jpg (the first 2,000,000 bytes of p05.jpg); prints exit codes and byte counts. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
mkdir -p /tmp/pol/prod2; cp /s/pol/prod2.xml /tmp/pol/prod2/policy.xml
export MAGICK_CONFIGURE_PATH=/tmp/pol/prod2
MAGICK_TIME_LIMIT=1 magick -regard-warnings png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png > /tmp/o.raw 2>/tmp/e; echo "png TIME=1 -regard-warnings exit=$? outbytes=$(stat -c %s /tmp/o.raw)"
MAGICK_TIME_LIMIT=1 magick -regard-warnings jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.jpg > /tmp/o.raw 2>/tmp/e; echo "jpeg TIME=1 -regard-warnings exit=$? outbytes=$(stat -c %s /tmp/o.raw)"
magick -regard-warnings jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.jpg > /tmp/o.raw 2>/tmp/e; echo "jpeg no limit -regard-warnings exit=$? outbytes=$(stat -c %s /tmp/o.raw)"
# warnings on benign inputs? p01 has odd ICC
for f in p01 p02 p03 p04 p05 p06; do magick -regard-warnings jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/set/$f.jpg > /tmp/o.raw 2>/tmp/e; echo "$f regard-warnings exit=$? err=$(head -c 80 /tmp/e)"; done
# truncated / corrupt jpeg without regard-warnings
head -c 2000000 /fix/set/p05.jpg > /tmp/trunc.jpg
magick jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /tmp/trunc.jpg > /tmp/o.raw 2>/tmp/e; echo "truncated jpeg plain exit=$? outbytes=$(stat -c %s /tmp/o.raw) err=$(head -c 100 /tmp/e)"
magick -regard-warnings jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /tmp/trunc.jpg > /tmp/o.raw 2>/tmp/e; echo "truncated jpeg -regard-warnings exit=$? outbytes=$(stat -c %s /tmp/o.raw) err=$(head -c 100 /tmp/e)"

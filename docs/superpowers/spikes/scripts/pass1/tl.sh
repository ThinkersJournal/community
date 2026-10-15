# PROVES: Stage B, section 5 rows 'time policy key enforces: FAIL' and 'Exit status on time-limit: FAIL (important)': a 50 MP decode with MAGICK_TIME_LIMIT=1/2 and -limit time 1 exits 0 with garbage output. By its content; the write-up does not name this script.
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/prod2.xml, /fix/big/s_50mp.png and s_50mp.jpg; exports MAGICK_CONFIGURE_PATH=/tmp/pol/prod2.
# EFFECTS: writes /tmp/pol/prod2, /tmp/o.raw (a 786,432-byte or larger raw output, overwritten) and /tmp/e; prints exit codes and byte counts. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
mkdir -p /tmp/pol/prod2; cp /s/pol/prod2.xml /tmp/pol/prod2/policy.xml
export MAGICK_CONFIGURE_PATH=/tmp/pol/prod2
for T in 1 2; do
MAGICK_TIME_LIMIT=$T magick png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png > /tmp/o.raw 2>/tmp/e; echo "MAGICK_TIME_LIMIT=$T exit=$? outbytes=$(stat -c %s /tmp/o.raw) nonzero-bytes=$(tr -d '\000' < /tmp/o.raw | wc -c) stderr-lines=$(wc -l < /tmp/e)"
done
magick -limit time 1 png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png > /tmp/o.raw 2>/tmp/e; echo "-limit time 1 exit=$? outbytes=$(stat -c %s /tmp/o.raw) nonzero-bytes=$(tr -d '\000' < /tmp/o.raw | wc -c)"; head -c 300 /tmp/e
# jpeg
MAGICK_TIME_LIMIT=1 magick jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.jpg > /tmp/o.raw 2>/tmp/e; echo "jpeg 50MP TIME=1 exit=$? outbytes=$(stat -c %s /tmp/o.raw)"; head -c 200 /tmp/e
# policy time honored when set as "time" under resource? try alt via -limit in policy? Check with -list resource when env set
MAGICK_TIME_LIMIT=7 magick -list resource | grep Time

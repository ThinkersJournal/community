#!/bin/sh
# PROVES: Stage B part 1, section 5 (labels B0-B5 in the script): the design policy as written (FAIL), the working policy under stdin/fd pipelines, disk 0 / map 0 / memory limits on a 50 MP decode, -list resource, the ignored policy 'time' key, forced resource-error shapes, gif/webp frame [0] from stdin, and the single-pass clone with rgb:fd:3.
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/{prod,prod2,open}.xml and fixtures under /fix/set; needs /usr/bin/time.
# EFFECTS: installs policy variants under /tmp/pol/<name>; generates /fix/big/s_50mp.png and s_50mp.jpg (7071x7071, under the 'open' policy with 8GiB limits) if absent; writes /tmp/out.raw, err.txt, tm.txt, fd3.raw, o.raw, o.webp, wide.png. The disk-0 tests expect no temp files. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
# Stage B part 1: policy checks. Runs in container. Args: none. Writes to stdout.
# Policies are installed into /tmp/pol/<name>/policy.xml and selected with MAGICK_CONFIGURE_PATH.
for n in prod prod2 open; do mkdir -p /tmp/pol/$n; cp /s/pol/$n.xml /tmp/pol/$n/policy.xml; done
# variants of prod
mk() { # name sed-expression
  mkdir -p /tmp/pol/$1; sed "$2" /s/pol/prod2.xml > /tmp/pol/$1/policy.xml
}
mk map512 's|name="map"    value="0"|name="map" value="512MiB"|'
mk mem1g 's|name="memory" value="512MiB"|name="memory" value="1GiB"|'
mk mem64 's|name="memory" value="512MiB"|name="memory" value="64MiB"|'
mk mem64map64 's|name="memory" value="512MiB"|name="memory" value="64MiB"|;s|name="map"    value="0"|name="map" value="64MiB"|'
mk spill 's|name="memory" value="512MiB"|name="memory" value="64MiB"|;s|name="map"    value="0"|name="map" value="64MiB"|;s|name="disk"   value="0"|name="disk" value="1GiB"|'
mk area10 's|name="area"   value="128MP"|name="area" value="10MP"|'
mk time1 's|name="time"   value="10"|name="time" value="1"|'
mk pathopen '/domain="path"/d'
echo "== generate 50MP fixture (open policy)"
export MAGICK_CONFIGURE_PATH=/tmp/pol/open
mkdir -p /fix/big
if [ ! -f /fix/big/s_50mp.png ]; then
magick -size 7071x7071 gradient:'rgb(10,20,200)-rgb(250,240,30)' \( -size 7071x7071 xc:black +noise Impulse -evaluate Multiply 0.2 \) -compose plus -composite -depth 8 -strip /fix/big/s_50mp.png
fi
ls -l /fix/big/s_50mp.png
magick identify -format "%wx%h depth=%z\n" /fix/big/s_50mp.png
# JPEG 50MP too (decode path differs)
if [ ! -f /fix/big/s_50mp.jpg ]; then magick /fix/big/s_50mp.png -quality 85 /fix/big/s_50mp.jpg; fi
ls -l /fix/big/s_50mp.jpg
unset MAGICK_CONFIGURE_PATH

PIPE='-colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 rgb:fd:1'
run() { # label policy fixture coder
  lab=$1; pol=$2; f=$3; c=$4
  /usr/bin/time -f "%e s  maxrss=%M KB  exit=%x" -o /tmp/tm.txt env MAGICK_CONFIGURE_PATH=/tmp/pol/$pol MAGICK_TEMPORARY_PATH=/nonexistent TMPDIR=/nonexistent HOME=/nonexistent \
     sh -c "magick $c:fd:0 $PIPE < $f > /tmp/out.raw 2> /tmp/err.txt"
  echo "$lab | policy=$pol fixture=$(basename $f) | outbytes=$(stat -c %s /tmp/out.raw) | $(cat /tmp/tm.txt | tail -1) | stderr: $(head -c 300 /tmp/err.txt | tr '\n' ' ')"
}
echo "== B1 policy loaded + resource listing"
MAGICK_CONFIGURE_PATH=/tmp/pol/prod magick -list policy 2>&1 | grep -c Policy
MAGICK_CONFIGURE_PATH=/tmp/pol/prod magick -list resource 2>&1
echo "-- same without env override (Debian default), for reference"
magick -list resource 2>&1 | grep -E "Disk|Memory|Map|Area"
echo "== B0 design policy AS WRITTEN (prod)"
run "12MP jpeg design-as-written" prod /fix/set/p05.jpg jpeg
echo "== B2 stdin->stdout pipeline under production policy (path rule '*' none), small + large"
run "12MP jpeg" prod2 /fix/set/p05.jpg jpeg
run "12MP progressive" prod2 /fix/set/d_progressive12mp.jpg jpeg
run "24MP jpeg p06" prod2 /fix/set/p06.jpg jpeg
run "png alpha" prod2 /fix/set/d_alpha.png png
run "gif" prod2 /fix/set/d_anim.gif gif
run "webp" prod2 /fix/set/d_lossy.webp webp
echo "-- gif/webp frame selector from stdin"
for f in d_anim.gif:gif d_anim.webp:webp; do n=${f%%:*}; c=${f##*:}; MAGICK_CONFIGURE_PATH=/tmp/pol/prod2 magick $c:fd:0[0] $PIPE < /fix/set/$n 2>&1 >/tmp/o.raw | head -c 300; echo "$n frame[0] bytes=$(stat -c %s /tmp/o.raw)"; done
echo "== B3 path-rule variants: is path * none needed/harmful? (pathopen = without the '*' rule)"
run "12MP jpeg" pathopen /fix/set/p05.jpg jpeg
echo "-- fd: output form (rgb:fd:3) under prod policy"
MAGICK_CONFIGURE_PATH=/tmp/pol/prod2 sh -c "magick jpeg:fd:0 -colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 rgb:fd:3 3>/tmp/fd3.raw" < /fix/set/p05.jpg 2>&1 | head -c 300; echo "rgb:fd:3 bytes=$(stat -c %s /tmp/fd3.raw)"
echo "-- fd:0 input form"
MAGICK_CONFIGURE_PATH=/tmp/pol/prod2 sh -c "magick jpeg:fd:0 $PIPE" < /fix/set/p05.jpg 2>&1 >/tmp/o.raw | head -c 300; echo "jpeg:fd:0 bytes=$(stat -c %s /tmp/o.raw)"
echo "-- single pass: stored webp + raw frame in one process (clone) via rgb:fd:3 + webp:-"
MAGICK_CONFIGURE_PATH=/tmp/pol/prod2 sh -c "magick jpeg:fd:0 -auto-orient \( +clone -colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 rgb:fd:3 +delete \) -resize 2048x2048\> -strip -quality 82 -define webp:method=4 webp:fd:1 3>/tmp/fd3.raw >/tmp/o.webp" < /fix/set/p05.jpg 2>&1 | head -c 400; echo "single-pass rgb bytes=$(stat -c %s /tmp/fd3.raw) webp bytes=$(stat -c %s /tmp/o.webp)"
echo "== B4 50MP decode under production policy (disk 0, map 0, memory 512MiB)"
run "50MP png" prod2 /fix/big/s_50mp.png png
run "50MP jpeg" prod2 /fix/big/s_50mp.jpg jpeg
echo "-- tuning"
run "50MP png map512" map512 /fix/big/s_50mp.png png
run "50MP png mem1g (map 0)" mem1g /fix/big/s_50mp.png png
run "50MP jpeg mem1g" mem1g /fix/big/s_50mp.jpg jpeg
echo "== B5 forced resource errors (verbatim)"
run "50MP png mem64 disk0 map0" mem64 /fix/big/s_50mp.png png
run "50MP png mem64 map64 disk0" mem64map64 /fix/big/s_50mp.png png
run "50MP jpeg mem64 map64 disk0" mem64map64 /fix/big/s_50mp.jpg jpeg
run "50MP png area10MP" area10 /fix/big/s_50mp.png png
run "24MP jpeg time1s" time1 /fix/set/p06.jpg jpeg
run "50MP png time1s" time1 /fix/big/s_50mp.png png
echo "-- 20000x5 over width policy (16KP)"
magick -size 20000x5 xc:red -depth 8 /tmp/wide.png 2>/dev/null || MAGICK_CONFIGURE_PATH=/tmp/pol/open magick -size 20000x5 xc:red -depth 8 /tmp/wide.png
run "20000x5 png width16KP" prod2 /tmp/wide.png png
echo "-- no-disk-policy sanity: does the spill policy variant WRITE a temp file? (observed in stageb2)"

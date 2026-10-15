# PROVES: Stage B part 1 follow-ups, section 5: single pass with -write rgb:fd:3 inside parentheses (frame byte-identical to the separate-process frame), the policy 'time' key versus MAGICK_TIME_LIMIT and -limit time, blocked reads (path, @file, jpeg:path), and coder confusion (SVG payload to jpeg:fd:0, jpeg bytes under png:).
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/prod2.xml, /fix/set/p05.jpg, /fix/big/s_50mp.png; exports MAGICK_CONFIGURE_PATH, MAGICK_TEMPORARY_PATH=/nonexistent, TMPDIR=/nonexistent, HOME=/nonexistent.
# EFFECTS: writes /tmp/pol/prod2, /tmp/pol/t1, /tmp/fd3.raw, /tmp/o.webp, /tmp/two.raw, /tmp/lst.txt, /tmp/x.svg; runs a 50 MP decode several times and a 4000x4000 plasma blur. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
mkdir -p /tmp/pol/prod2; cp /s/pol/prod2.xml /tmp/pol/prod2/policy.xml
export MAGICK_CONFIGURE_PATH=/tmp/pol/prod2 MAGICK_TEMPORARY_PATH=/nonexistent TMPDIR=/nonexistent HOME=/nonexistent
echo "== single pass with -write rgb:fd:3 inside parentheses (prod2 policy)"
sh -c 'magick jpeg:fd:0 -auto-orient \( +clone -colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 -write rgb:fd:3 +delete \) -resize "2048x2048>" -strip -quality 82 -define webp:method=4 webp:fd:1 3>/tmp/fd3.raw >/tmp/o.webp' < /fix/set/p05.jpg 2>&1 | head -c 400
echo "single-pass rgb bytes=$(stat -c %s /tmp/fd3.raw) webp bytes=$(stat -c %s /tmp/o.webp)"
magick jpeg:fd:0 -colorspace sRGB -define sample:offset=0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/set/p05.jpg > /tmp/two.raw
cmp /tmp/two.raw /tmp/fd3.raw && echo "single-pass rgb frame == separate-process frame (byte-identical)"
magick webp:fd:0 -format "%wx%h" info: < /tmp/o.webp; echo
echo "== time limit enforcement on 50MP png decode (takes ~2.8s unlimited)"
for v in "policy time=1 (prod2 has time=10; make 1)"; do :; done
mkdir -p /tmp/pol/t1; sed 's|name="time"   value="10"|name="time" value="1"|' /s/pol/prod2.xml > /tmp/pol/t1/policy.xml
MAGICK_CONFIGURE_PATH=/tmp/pol/t1 magick -list resource | grep -i time
echo "-- policy time=1:"; MAGICK_CONFIGURE_PATH=/tmp/pol/t1 magick png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png 2>&1 >/dev/null | head -c 300; echo "exit=$?"
echo "-- env MAGICK_TIME_LIMIT=1:"; MAGICK_TIME_LIMIT=1 magick png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png 2>&1 >/dev/null | head -c 300
echo "-- CLI -limit time 1:"; magick -limit time 1 png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png 2>&1 >/dev/null | head -c 300
magick -limit time 1 png:fd:0 -sample 512x512! -depth 8 rgb:fd:1 < /fix/big/s_50mp.png >/dev/null 2>&1; echo "exit=$?"
echo "-- policy time=1 on a deliberately slow op (large blur) to check the key is honored at all"
MAGICK_CONFIGURE_PATH=/tmp/pol/t1 magick -size 4000x4000 plasma:red-blue -blur 0x30 null: 2>&1 | head -c 300; echo "(plasma maybe blocked by coder policy)"
echo "-- design allows 'filter none *' and 'delegate none *': -list policy count of coder none:"
magick -list policy | grep -c "Policy: Coder"
echo "== reading arbitrary path blocked? (expect error) and @file"
echo "/etc/passwd" > /tmp/lst.txt
magick /etc/passwd info: 2>&1 | head -c 200; echo
magick @/tmp/lst.txt info: 2>&1 | head -c 200; echo
magick jpeg:/fix/set/p05.jpg info: 2>&1 | head -c 200; echo
echo "== coder confusion: SVG payload fed to jpeg:fd:0 / unprefixed"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' > /tmp/x.svg
magick jpeg:fd:0 info: < /tmp/x.svg 2>&1 | head -c 200; echo
magick fd:0 info: < /tmp/x.svg 2>&1 | head -c 200; echo
magick fd:0 info: < /fix/set/p05.jpg 2>&1 | head -c 200; echo
echo "== jpeg bytes under png: prefix"
magick png:fd:0 info: < /fix/set/p05.jpg 2>&1 | head -c 200; echo

# PROVES: Stage B, section 5 first row, causes (1) and (2): path-rule variants A-F (order of 'path none *' versus allow for '-' / fd:*) and module-allow variants G-H (lower-case versus UPPER-CASE coder names), each tested with stdin to stdout, fd:0 to fd:3, a file-write attempt and a read-by-path. By its content; the write-up does not name this script.
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/prod.xml and /fix/set/p05.jpg; runs magick with MAGICK_CONFIGURE_PATH=/tmp/p/<label>.
# EFFECTS: writes /tmp/base.xml, /tmp/p/<label>/policy.xml, /tmp/e, /tmp/e2, /tmp/o3; the 'file-write attempt' tries to write /tmp/leak.png and then rm -f /tmp/leak.png. Prints one line per variant. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
grep -v -E 'domain="(path|module)"|</policymap>' /s/pol/prod.xml > /tmp/base.xml
t() { # label, extra lines
  mkdir -p /tmp/p/$1; { cat /tmp/base.xml; printf '%s\n' "$2"; echo '</policymap>'; } > /tmp/p/$1/policy.xml
  r=$(MAGICK_CONFIGURE_PATH=/tmp/p/$1 magick jpeg:- -sample 512x512! -depth 8 rgb:- < /fix/set/p05.jpg 2>/tmp/e | wc -c)
  r2=$(MAGICK_CONFIGURE_PATH=/tmp/p/$1 sh -c 'magick jpeg:fd:0 -sample 512x512! -depth 8 rgb:fd:3 3>/tmp/o3 2>/tmp/e2' < /fix/set/p05.jpg; wc -c < /tmp/o3)
  r3=$(MAGICK_CONFIGURE_PATH=/tmp/p/$1 magick -size 4x4 xc:red -write /tmp/leak.png null: 2>&1 | head -c 100; ls /tmp/leak.png 2>&1 | head -c 60; rm -f /tmp/leak.png)
  r4=$(MAGICK_CONFIGURE_PATH=/tmp/p/$1 magick /fix/set/p05.jpg -resize 10x10 rgb:- 2>&1 | wc -c)
  echo "$1: stdin->stdout=$r ($(head -c 120 /tmp/e | tr '\n' ' ')) | fd0->fd3=$r2 ($(head -c 100 /tmp/e2|tr '\n' ' ')) | file-write-attempt: $r3 | file-read-by-path bytes=$r4"
}
t A-pathstar-none-then-allow-dash '<policy domain="path" rights="none" pattern="*"/>
<policy domain="path" rights="read|write" pattern="-"/>'
t B-allow-dash-then-none '<policy domain="path" rights="read|write" pattern="-"/>
<policy domain="path" rights="none" pattern="*"/>'
t C-only-at '<policy domain="path" rights="none" pattern="@*"/>'
t D-allow-dash-fd '<policy domain="path" rights="none" pattern="*"/>
<policy domain="path" rights="read|write" pattern="-"/>
<policy domain="path" rights="read|write" pattern="fd:*"/>'
t E-fd-only '<policy domain="path" rights="none" pattern="*"/>
<policy domain="path" rights="read|write" pattern="fd:*"/>'
t F-dash-fd-and-bare '<policy domain="path" rights="none" pattern="*"/>
<policy domain="path" rights="read|write" pattern="-"/>
<policy domain="path" rights="read|write" pattern="fd:*"/>
<policy domain="path" rights="read|write" pattern="jpeg:*"/>'
t G-module-per-coder '<policy domain="module" rights="none" pattern="*"/>
<policy domain="module" rights="read|write" pattern="{jpeg,png,gif,webp,rgb}"/>'
t H-module-per-coder-upper '<policy domain="module" rights="none" pattern="*"/>
<policy domain="module" rights="read|write" pattern="{JPEG,PNG,GIF,WEBP,RGB}"/>'

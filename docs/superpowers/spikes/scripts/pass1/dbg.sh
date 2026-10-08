# PROVES: Stage B, section 5 first row ('Design policy.xml as first written: FAIL'): removes one policy domain at a time from pol/prod.xml to find which rules break a stdin decode. By its content; the write-up does not name this script.
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /s/pol/prod.xml and /fix/set/p05.jpg; runs magick with MAGICK_CONFIGURE_PATH=/tmp/p/<label>.
# EFFECTS: writes /tmp/p/<label>/policy.xml, /tmp/*.xml variants and /tmp/e (stderr capture); prints one line per variant. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
t() { # label, policy file
  mkdir -p /tmp/p/$1; cp $2 /tmp/p/$1/policy.xml
  r=$(MAGICK_CONFIGURE_PATH=/tmp/p/$1 magick jpeg:- -sample 512x512! -depth 8 rgb:- < /fix/set/p05.jpg 2>/tmp/e | wc -c)
  echo "$1: out=$r err=$(head -c 160 /tmp/e | tr '\n' ' ')"
}
t full /s/pol/prod.xml
grep -v 'domain="path"     rights="none" pattern="\*"' /s/pol/prod.xml > /tmp/nopathstar.xml; t nopathstar /tmp/nopathstar.xml
grep -v 'domain="path"' /s/pol/prod.xml > /tmp/nopath.xml; t nopath /tmp/nopath.xml
grep -v 'domain="coder"' /s/pol/prod.xml > /tmp/nocoder.xml; t nocoder /tmp/nocoder.xml
grep -v 'domain="module"' /s/pol/prod.xml > /tmp/nomodule.xml; t nomodule /tmp/nomodule.xml
grep -v 'domain="delegate"' /s/pol/prod.xml > /tmp/nodeleg.xml; t nodelegate /tmp/nodeleg.xml
grep -v -E 'domain="(path|module|delegate|filter)"' /s/pol/prod.xml > /tmp/c1.xml; t coder-only-plus-resource /tmp/c1.xml
grep -v -E 'domain="(path|module)"' /s/pol/prod.xml > /tmp/c2.xml; t nopath-nomodule /tmp/c2.xml

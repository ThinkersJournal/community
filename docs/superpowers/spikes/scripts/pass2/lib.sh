# PROVES: nothing by itself; shared helpers (sync_files, start_case, drive_all) sourced by t2, t2b, t2c, t3, t4, t6a, t6a2, t6a4, t6b, t6c and t7.
# INPUTS: sourced inside the throwaway distro as root; needs SPIKE_DIR (the shell aborts if unset: spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/).
#   Sets SP, OUT, W=/srv/work, SIX, SC, DROP.
# EFFECTS: sync_files copies pass2 files into /opt/tj, /etc/systemd/system and /srv/work and runs chmod -R a+rX /opt/tj. start_case stops tj-wrapper.socket/.service, rm
#   -rf of the tj-wrapper.service.d drop-in, writes a new drop-in from its argument, daemon-reload, starts tj-wrapper.socket (a loopback TCP listener on 127.0.0.1:8088)
#   and sends one GET to it.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# common helpers (sourced inside the distro, as root)
SP="${SPIKE_DIR:?set SPIKE_DIR to the work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/}"
OUT=$SP/out2
W=/srv/work
SIX="p05.jpg d_alpha.png d_anim.gif d_lossy.webp s_50mp.png s_50mp.jpg"
SC="trace=openat,open,creat,mkdir,mkdirat,rename,renameat,renameat2,link,linkat,symlink,symlinkat,truncate,ftruncate,fallocate,memfd_create,mmap,write,pwrite64,writev,sendfile,copy_file_range,unlink,unlinkat"
DROP=/etc/systemd/system/tj-wrapper.service.d

sync_files() {
  cp $SP/pass2/wrapper.py /opt/tj/wrapper.py
  cp $SP/pass2/units/tj-wrapper.service $SP/pass2/units/tj-wrapper.socket /etc/systemd/system/
  mkdir -p /opt/tj/magick-spill; cp $SP/pass2/pol-spill/policy.xml /opt/tj/magick-spill/policy.xml
  cp $SP/pass2/client.py $SP/pass2/stracecheck.py $SP/pass2/mkmarker.py /srv/work/ 2>/dev/null
  chmod -R a+rX /opt/tj
}

# start_case "<dropin text or empty>"  -> sets PID
start_case() {
  systemctl stop tj-wrapper.socket tj-wrapper.service 2>/dev/null
  rm -rf $DROP; systemctl reset-failed 'tj-wrapper*' 2>/dev/null
  if [ -n "$1" ]; then mkdir -p $DROP; printf '%s\n' "$1" > $DROP/10-case.conf; fi
  systemctl daemon-reload
  systemctl start tj-wrapper.socket
  python3 -I -c "
import http.client
c=http.client.HTTPConnection('127.0.0.1',8088,timeout=20); c.request('GET','/'); print('health',c.getresponse().status)"
  PID=$(systemctl show -p MainPID --value tj-wrapper.service)
  echo "case unit MainPID=$PID"
}

# drive_all: six inputs, prints one line each
drive_all() {
  for f in $SIX; do python3 -I $W/client.py 8088 /srv/fix/$f 1 | python3 -I -c "
import sys,json
l=sys.stdin.read().strip()
try:
    d=json.loads(l); print('  ',d['file'],'status',d['status'],'scan',d.get('scan'),'webp',d.get('webp_len'))
except Exception as e: print('  RAW',l[:100])"; done
}

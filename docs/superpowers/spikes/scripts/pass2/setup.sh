#!/bin/bash
# PROVES: nothing on its own; stages the inputs for Tasks 1-7 (write-up section 1: wrapper at /opt/tj, policy at /opt/tj/magick/policy.xml, unit files) and prints
#   sha256 of wrapper.py and the policy, cgroup controllers, swap, core_pattern and suid_dumpable for the record.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/); reads pass2/{wrapper,client,mkmarker}.py, pass2/units/*, pass1/pol/prod2.xml,
#   fixtures/set/* (named files) and fixtures/big/s_50mp.{png,jpg}. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: mkdir and cp into /opt/tj, /srv/fix, /srv/work and /etc/systemd/system; may create /srv/fix/photo4mp.jpg with magick (resize of p01.jpg); chmod -R a+rX /srv
#   /opt/tj and chown -R root:root /opt/tj; systemctl daemon-reload. Starts nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# runs as root inside tjspike2-systemd
set -e
SP="${SPIKE_DIR:?set SPIKE_DIR to the work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/}"
mkdir -p /opt/tj/magick /srv/fix /srv/work
cp $SP/pass2/wrapper.py /opt/tj/wrapper.py
cp $SP/pass2/client.py $SP/pass2/mkmarker.py /srv/work/
cp $SP/pass1/pol/prod2.xml /opt/tj/magick/policy.xml
cp $SP/pass2/units/tj-wrapper.service $SP/pass2/units/tj-wrapper.socket /etc/systemd/system/
for f in p05.jpg d_alpha.png d_anim.gif d_lossy.webp d_anim.webp p24.jpg p01.jpg p02.jpg d_small64.jpg e_o6_400x300.jpg e_o6_3000x2000.jpg d_alpha_lossy.webp s_text.png s_flat.png s_checker.png; do cp $SP/fixtures/set/$f /srv/fix/; done
cp $SP/fixtures/big/s_50mp.png $SP/fixtures/big/s_50mp.jpg /srv/fix/
cd /srv/fix
# 4MP photo derived from p01 (CC0)
[ -f photo4mp.jpg ] || magick p01.jpg -resize 2400x1667! -quality 90 photo4mp.jpg
chmod -R a+rX /srv /opt/tj
chown -R root:root /opt/tj
systemctl daemon-reload
ls -la /srv/fix | head -40
sha256sum /opt/tj/wrapper.py /opt/tj/magick/policy.xml
cat /sys/fs/cgroup/cgroup.controllers; stat -fc %T /sys/fs/cgroup
free -m; swapon --show; cat /proc/sys/kernel/core_pattern; cat /proc/sys/fs/suid_dumpable

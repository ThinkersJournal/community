#!/bin/bash
# PROVES: Task 4 (write-up section 4, C7 WebP determinism), distro half only: run1 vs run2 (fresh socket-activated instance), MAGICK_THREAD_LIMIT=1, and 8 with
#   OMP_NUM_THREADS=8 over the fixture set. The container comparisons are done by cmp7.py from files this script does not make.
# INPUTS: SPIKE_DIR (spike work dir holding fixtures/, vendor2/, out2/, pass1/, pass2/) via lib.sh (fixtures/set, fixtures/big) and SPIKE_PASS2 (this pass2 directory,
#   to find lib.sh); pass2/sweep.py. Runs inside the throwaway distro (tjspike2-systemd) as root.
# EFFECTS: rm -rf /srv/det then copies all fixtures into it; creates /srv/work/c7/; four start_case runs (loopback listener 127.0.0.1:8088, drop-ins written and
#   removed); prints package versions; copies run1/run2 results to out2/c7_distro_run1.txt and c7_distro_run2.txt; ends with stop of tj-wrapper units and rm -rf of the
#   drop-in.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: inside the distro it uses kill and systemctl stop, but only on processes it started
#   or on tj-wrapper*/tjspike2-* units.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Task 4: C7 WebP determinism inside the systemd distro
. "${SPIKE_PASS2:?set SPIKE_PASS2 to the directory holding lib.sh (this pass2 directory)}/lib.sh"
sync_files
cp $SP/pass2/sweep.py /srv/work/
rm -rf /srv/det; mkdir -p /srv/det /srv/work/c7; cp $SP/fixtures/set/* /srv/det/; cp $SP/fixtures/big/* /srv/det/; chmod -R a+rX /srv/det
echo "inputs: $(ls /srv/det | wc -l) files"
dpkg -l imagemagick libwebp7 libjpeg62-turbo libpng16-16t64 2>/dev/null | awk '/^ii/{print $2, $3}'
magick -version | head -1
run() {  # name dropin
  start_case "$2" >/dev/null
  python3 -I /srv/work/sweep.py 8088 /srv/det /srv/work/c7/$1.txt
}
run run1 ""
run run2 ""                                            # fresh socket-activated process (second instance of the unit)
run run3_threads1 $'[Service]\nEnvironment=MAGICK_THREAD_LIMIT=1'
run run4_threads8 $'[Service]\nEnvironment=MAGICK_THREAD_LIMIT=8 OMP_NUM_THREADS=8'
cd /srv/work/c7
echo "== compare (sha of stored WebP and of the scan frame, per file)"
for r in run2 run3_threads1 run4_threads8; do
  echo "run1 vs $r: webp differing files: $(join <(awk '{print $1,$4}' run1.txt|sort) <(awk '{print $1,$4}' $r.txt|sort) | awk '$2!=$3' | wc -l); rgb differing: $(join <(awk '{print $1,$3}' run1.txt|sort) <(awk '{print $1,$3}' $r.txt|sort) | awk '$2!=$3' | wc -l); both-200 files: $(awk '$2==200' run1.txt | wc -l)"
done
echo "non-200 in run1: $(awk '$2!=200{print $1"="$2}' run1.txt | tr '\n' ' ')"
cp run1.txt $OUT/c7_distro_run1.txt; cp run2.txt $OUT/c7_distro_run2.txt
systemctl stop tj-wrapper.socket tj-wrapper.service; rm -rf $DROP; systemctl daemon-reload

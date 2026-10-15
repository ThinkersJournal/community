# PROVES: Task 4 (write-up section 4, C7 table rows 'two simultaneous containers' and 'container vs distro unit'): compares sweep outputs. KNOWN ISSUE, not fixed: the
#   'webp differ' comparisons index field 3 of the status-stripped record, which is webp_len, not the WebP hash (field 2).
# INPUTS: no arguments or env vars; reads, relative to the current directory, c7/ctr1.set.txt, c7/ctr1.big.txt, c7/ctr2.set.txt, c7/ctr2.big.txt and c7_distro_run1.txt.
#   The container files are not made by any script in pass2/. Pure text processing.
# EFFECTS: read-only; prints counts of differing files.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
import sys
def load(*fs):
    d = {}
    for f in fs:
        for l in open(f):
            p = l.split()
            if len(p) >= 5: d[p[0]] = p[1:]
    return d
a = load('c7/ctr1.set.txt', 'c7/ctr1.big.txt'); b = load('c7/ctr2.set.txt', 'c7/ctr2.big.txt'); c = load('c7_distro_run1.txt')
ok = [k for k in a if a[k][0] == '200']
print('container1 ok files', len(ok), 'container2 ok', sum(1 for k in b if b[k][0] == '200'), 'distro ok', sum(1 for k in c if c[k][0] == '200'))
def diff(x, y, i): return [k for k in ok if x[k][i] != y[k][i]]
print('container1 vs container2: webp differ', len(diff(a, b, 3)), ' rgb differ', len(diff(a, b, 1)))
print('container1 vs distro unit (different process/host layer): webp differ', len(diff(a, c, 3)), ' rgb differ', len(diff(a, c, 1)))
print('non-200:', {k: a[k][0] for k in a if a[k][0] != '200'})

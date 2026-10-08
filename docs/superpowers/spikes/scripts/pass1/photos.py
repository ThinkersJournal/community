# PROVES: Stage A, section 4a (real photos p01-p27 only, alpha off): per-config table, worst file per config, reference quality of the p files, and the Sample0 pixel-equality list behind the frame check. Inferred from the code; the write-up does not name this script.
# INPUTS: argv[1] = results JSONL produced by sweep.py; needs numpy. No container-specific paths; the write-up does not say where it ran.
# EFFECTS: reads one file and prints to stdout; writes nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers). (Pure analysis: it only reads a results file and prints.)
# ARCHIVED: preserved verbatim from the spike session.
import json,sys,numpy as np
rows=[json.loads(l) for l in open(sys.argv[1])]
print('REAL PHOTOS only (p01-p27), alpha=off (== white for opaque): config | n | min | med | p95 | max | n>10 | n>8 | n q<80')
cf=sorted({r['cfg'] for r in rows if r['cfg'].endswith('|off') and r['cfg'].split('|')[1]=='noorient'})
for c in cf:
    rs=[r for r in rows if r['cfg']==c and r['file'].startswith('p')]
    d=[r['d0'] for r in rs]
    print(c,len(d),min(d),np.median(d),np.percentile(d,95),max(d),sum(x>10 for x in d),sum(x>8 for x in d),sum(r['ref_q']<80 for r in rs))
print('\nphoto-only worst per config (file:d):')
for c in cf:
    rs=sorted([(r['d0'],r['file']) for r in rows if r['cfg']==c and r['file'].startswith('p')])[-3:]
    print(c,rs)
print('\nref quality of p files:',sorted({r['ref_q'] for r in rows if r['file'].startswith('p')}))
print('\nSample0|noorient|off whole main (non-e_o, 512-resize) sorted worst:', sorted([(r['d0'],r['file'],r['ref_q']) for r in rows if r['cfg']=='Sample0|noorient|off' and not r['file'].startswith('e_')])[-8:])
print('\nSample0 vs autoorient on photos with orientation tag 1/Undefined: identical?', all(
 [r['d0'] for r in rows if r['cfg']=='Sample0|noorient|off' and r['file'].startswith('p')]==[r['d0'] for r in rows if r['cfg']=='Sample0|autoorient|off' and r['file'].startswith('p')]))
print('p-file idents with non-trivial orientation:',[(r['file'],r['ident']) for r in rows if r['cfg']=='Sample0|noorient|off' and r['file'].startswith('p') and not any(k in r['ident'] for k in ('Undefined','TopLeft'))])
print('\nSample0 pixel equality p files:',[(r['file'],r.get('px_equal'),r.get('px_mad')) for r in rows if r['cfg']=='Sample0|noorient|off' and r['file'].startswith('p')][:30])

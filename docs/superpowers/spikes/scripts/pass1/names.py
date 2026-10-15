# PROVES: Stage A, section 4b (files larger than 512 px, non-EXIF): names the fixtures over the d>10 (quality >= 80) and d>16 bars per config, lists quality <= 49 files ('never sent'), and prints min/median/p95/max for quality >= 50. Inferred from the code; the write-up does not name this script.
# INPUTS: no arguments; reads /o/results.jsonl (the output mount of the pass 1 container, written by sweep.py).
# EFFECTS: reads one file and prints to stdout; writes nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers). (Pure analysis: it only reads a results file and prints.)
# ARCHIVED: preserved verbatim from the spike session.
import json
rows=[json.loads(l) for l in open('/o/results.jsonl')]
big=lambda r: r['ref_hw']==262144 and not r['file'].startswith('e_o')
for c in ['Sample0|noorient|off','Lanczos|noorient|off','Triangle|noorient|off','Point|noorient|off','Box|noorient|off','Sample0|noorient|white']:
    rs=[r for r in rows if r['cfg']==c and big(r)]
    print(c,'n=',len(rs))
    print('  q>=80 & d>10:',sorted((r['file'],r['d0']) for r in rs if r['ref_q']>=80 and r['d0']>10))
    print('  d>16:',sorted((r['file'],r['d0'],r['ref_q']) for r in rs if r['d0']>16))
    qs=[r for r in rs if r['ref_q']<=49]
    print('  q<=49 (never sent):',sorted((r['file'],r['ref_q']) for r in qs))
    # with q>=50 only
    d=sorted(r['d0'] for r in rs if r['ref_q']>=50)
    import statistics
    print('  q>=50 n=',len(d),'min',d[0],'med',statistics.median(d),'p95',d[int(0.95*(len(d)-1))],'max',d[-1])

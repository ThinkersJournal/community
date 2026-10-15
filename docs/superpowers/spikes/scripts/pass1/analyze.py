# PROVES: Stage A, write-up section 4 (2026-10-08-imagemagick-pdq-spike.md): by reading the code, it condenses sweep.py results into the Hamming-distance tables of 4a-4c (per-config min/median/p95/max, counts over the d>10 and d>16 bars, small-image, EXIF and alpha cases). The write-up does not name this script.
# INPUTS: argv[1] = results JSONL produced by sweep.py; needs numpy. No container-specific paths; the write-up does not say where it ran.
# EFFECTS: reads one file and prints tables to stdout; writes nothing.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers). (Pure analysis: it only reads a results file and prints.)
# ARCHIVED: preserved verbatim from the spike session.
import json, sys, collections
import numpy as np
rows = [json.loads(l) for l in open(sys.argv[1])]
errs = [r for r in rows if 'im_err' in r or 'ref_err' in r]
ok = [r for r in rows if 'd0' in r]
print('rows', len(rows), 'ok', len(ok), 'errors', len(errs))
for e in errs[:20]: print('ERR', e['file'], e.get('cfg'), e.get('im_err') or e.get('ref_err'))

def group(f):
    if f.startswith('e_o'):
        return 'exif'
    return 'main'

files = sorted({r['file'] for r in ok})
info = {}
for r in ok:
    info[r['file']] = (r['ref_q'], r['ref_hw'], r['ident'])
print('\nFIXTURES (ref quality, ref hashed pixels, ident w h orient cs channels frames)')
for f in files: print(f, info[f])

cfgs = sorted({r['cfg'] for r in ok})
def pct(a, p): return float(np.percentile(a, p))
def table(sel, label, key='d0'):
    print(f'\n== {label}: Hamming ({key}) per config; n files = {len({r["file"] for r in sel})}')
    print('config | min | med | p95 | max | n>10 (q>=80) | n>16 (all) | q<80 files')
    out = []
    for c in cfgs:
        rs = [r for r in sel if r['cfg'] == c]
        if not rs: continue
        d = [r[key] for r in rs]
        o10 = [r['file'] for r in rs if r['ref_q'] >= 80 and r[key] > 10]
        o16 = [r['file'] for r in rs if r[key] > 16]
        out.append((max(d), pct(d, 95), c, min(d), pct(d, 50), len(o10), len(o16), len([r for r in rs if r['ref_q'] < 80]), o10, o16))
    out.sort()
    for mx, p95, c, mn, med, n10, n16, nlow, o10, o16 in out:
        print(f'{c} | {mn} | {med:.0f} | {p95:.0f} | {mx} | {n10} | {n16} | {nlow}')
    return out

main = [r for r in ok if group(r['file']) == 'main']
# small images: reference does not downscale when both dims <=512
small = {f for f in files if info[f][1] != 512 * 512}
print('\nfiles where reference hashes native size (no 512 resize):', sorted(small))
mainbig = [r for r in main if r['file'] not in small]
res = table(mainbig, 'MAIN SET (non-EXIF, reference resizes to 512x512)')
print('\nover-bar file names per config (top 6 configs by max):')
for mx, p95, c, mn, med, n10, n16, nlow, o10, o16 in res[:6]:
    print(c, '>10&q>=80:', o10, '>16:', o16)
print('\nover-bar names, selected configs:')
for c in ['Point|noorient|white', 'Lanczos|noorient|white', 'Triangle|noorient|white', 'Box|noorient|white']:
    rs = [r for r in mainbig if r['cfg'] == c]
    print(c, 'q>=80 & >10:', sorted((r['file'], r['d0']) for r in rs if r['ref_q'] >= 80 and r['d0'] > 10),
          '| >16:', sorted((r['file'], r['d0']) for r in rs if r['d0'] > 16))

# pixel equality to the reference's own 512 frame
print('\nPIXEL MATCH vs reference loader frame (main set, files with 512 frame): config | mean frac equal | mean MAD | min frac equal')
for c in cfgs:
    rs = [r for r in mainbig if r['cfg'] == c and 'px_equal' in r]
    if rs and c.split('|')[2] == 'white':
        print(c, round(np.mean([r['px_equal'] for r in rs]), 4), round(np.mean([r['px_mad'] for r in rs]), 3), min(r['px_equal'] for r in rs))

# small images
if small:
    print('\nSMALL (reference hashes native size; ours forced 512x512 upsample): per config d0 by file')
    for f in sorted(small):
        print(f, info[f], {r['cfg']: r['d0'] for r in ok if r['file'] == f and r['cfg'].endswith('white') and r['cfg'].split('|')[1] == 'noorient'})

# exif
ex = [r for r in ok if group(r['file']) == 'exif']
for orient in ['noorient', 'autoorient']:
    print(f'\nEXIF files, {orient}: d0 / dmin8(idx) for configs Sample0, Point, Lanczos (alpha=white)')
    for f in sorted({r['file'] for r in ex}):
        s = []
        for rn in ['Sample0', 'Point', 'Lanczos']:
            r = [r for r in ex if r['file'] == f and r['cfg'] == f'{rn}|{orient}|white'][0]
            s.append(f'{rn}:{r["d0"]}/{r["dmin8"]}({r["dmin8_idx"]})')
        print(f, 'q', info[f][0], ' '.join(s))
print('\nEXIF summary: max d0 / max dmin8 per config')
for c in cfgs:
    if c.endswith('white'):
        rs = [r for r in ex if r['cfg'] == c]
        print(c, max(r['d0'] for r in rs), max(r['dmin8'] for r in rs))
print('\nper-config time (s) mean, main set:', {c: round(np.mean([r['secs'] for r in mainbig if r['cfg'] == c]), 3) for c in cfgs if c.endswith('white')})
print('\nALPHA fixtures (d_alpha*, d_anim*) d0 per config:')
for f in ['d_alpha.png', 'd_alpha_lossy.webp', 'd_anim.gif', 'd_anim.webp', 'd_cmyk.jpg', 'd_gray.jpg', 'd_gray.png', 'd_rgb16.png', 'd_palette.png', 'd_lossy.webp']:
    rs = [r for r in ok if r['file'] == f and r['cfg'].split('|')[1] == 'noorient']
    if rs: print(f, info[f][0], {r['cfg'].replace('|noorient', ''): r['d0'] for r in rs if r['cfg'].split('|')[0] in ('Sample0', 'Point', 'Lanczos')})

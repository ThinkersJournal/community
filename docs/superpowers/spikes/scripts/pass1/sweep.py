# PROVES: Stage A, section 4 (hash fidelity, C6): the 28-configuration sweep (7 resizes x 2 orientation modes x 2 alpha modes) comparing reference PDQ on the original with reference PDQ core on the ImageMagick frame, producing one JSONL row per file and config (the 28 x 64 = 1792 runs).
# INPUTS: argv[1] = fixtures dir, argv[2] = results JSONL path; env REFDIR (optional dir of alternative reference-input files, default /nonexistent so the fixture itself is used) and JOBS (threads, default 8); needs magick, pdqtool and numpy on PATH. No hard-coded container paths except /tmp; the write-up does not say where it ran.
# EFFECTS: spawns many magick and pdqtool processes (8 threads by default); creates /tmp/sweep and writes then deletes raw frame files there; writes the results JSONL. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
import os, sys, json, subprocess, itertools, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np

FIX = sys.argv[1]      # dir with fixtures
OUT = sys.argv[2]      # results jsonl
TMP = '/tmp/sweep'
os.makedirs(TMP, exist_ok=True)


def sniff(b):
    if b[:3] == b'\xff\xd8\xff': return 'jpeg'
    if b[:8] == b'\x89PNG\r\n\x1a\n': return 'png'
    if b[:6] in (b'GIF87a', b'GIF89a'): return 'gif'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP': return 'webp'
    return None


def ham(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count('1')


RESIZE = {
    'Point': ['-filter', 'Point', '-resize', '512x512!'],
    'Box': ['-filter', 'Box', '-resize', '512x512!'],
    'Triangle': ['-filter', 'Triangle', '-resize', '512x512!'],
    'Mitchell': ['-filter', 'Mitchell', '-resize', '512x512!'],
    'Lanczos': ['-filter', 'Lanczos', '-resize', '512x512!'],
    'Sample0': ['-define', 'sample:offset=0', '-sample', '512x512!'],
    'Sample50': ['-sample', '512x512!'],
}
ALPHA = {'white': ['-background', 'white', '-alpha', 'remove', '-alpha', 'off'], 'off': ['-alpha', 'off']}
ORIENT = {'noorient': [], 'autoorient': ['-auto-orient']}


def run(cmd, inp=None):
    p = subprocess.run(cmd, input=inp, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout, p.stderr


def work(fn):
    path = os.path.join(FIX, fn)
    data = open(path, 'rb').read()
    fmt = sniff(data)
    rec = {'file': fn, 'bytes': len(data), 'fmt': fmt}
    refpath = os.path.join(os.environ.get('REFDIR', '/nonexistent'), fn)
    if not os.path.exists(refpath): refpath = path
    rec['ref_from'] = refpath
    rc, so, se = run(['pdqtool', 'file', refpath])
    if rc != 0:
        rec['ref_err'] = so.decode() + se.decode()[:200]
        return [rec]
    h, q, hw = so.decode().split()
    rec.update(ref_hash=h, ref_q=int(q), ref_hw=int(hw))
    ref_raw = f'{TMP}/{fn}.ref.raw'
    rc, so, se = run(['pdqtool', 'frame', refpath, ref_raw])
    ref_frame = None
    rec['ref_frame_info'] = so.decode().strip()
    if rc == 0 and so.decode().split()[:2] == ['512', '512']:
        ref_frame = np.fromfile(ref_raw, dtype=np.uint8)
    # dims
    rc, so, se = run(['magick', 'identify', '-format', '%w %h %[orientation] %[colorspace] %[channels] %n', f'{fmt}:-[0]'], data)
    rec['ident'] = so.decode().strip()
    out = []
    sel = '[0]' if fmt in ('gif', 'webp') else ''
    for (rn, ra), (on, oa), (an, aa) in itertools.product(RESIZE.items(), ORIENT.items(), ALPHA.items()):
        cfg = f'{rn}|{on}|{an}'
        cmd = ['magick', f'{fmt}:-{sel}'] + oa + aa + ['-colorspace', 'sRGB'] + ra + ['-depth', '8', 'rgb:-']
        t0 = time.time()
        rc, so, se = run(cmd, data)
        r = dict(rec); r['cfg'] = cfg; r['secs'] = round(time.time() - t0, 3)
        if rc != 0 or len(so) != 786432:
            r['im_err'] = f'rc={rc} len={len(so)} {se.decode()[:200]}'
            out.append(r); continue
        fr = f'{TMP}/{fn}.{cfg.replace("|", "_")}.raw'
        open(fr, 'wb').write(so)
        rc, o2, e2 = run(['pdqtool', 'rawdih', fr, '512', '512'])
        os.remove(fr)
        if rc != 0:
            r['im_err'] = 'pdq ' + o2.decode()[:100]
            out.append(r); continue
        parts = o2.decode().split()
        dih = parts[:8]; r['im_q'] = int(parts[8]); r['im_hash'] = dih[0]
        r['d0'] = ham(h, dih[0])
        r['dmin8'] = min(ham(h, x) for x in dih)
        r['dmin8_idx'] = int(np.argmin([ham(h, x) for x in dih]))
        if ref_frame is not None:
            imf = np.frombuffer(so, dtype=np.uint8)
            diff = np.abs(imf.astype(np.int16) - ref_frame.astype(np.int16))
            r['px_equal'] = round(float((diff == 0).mean()), 4)
            r['px_mad'] = round(float(diff.mean()), 3)
        out.append(r)
    if os.path.exists(ref_raw): os.remove(ref_raw)
    return out


files = sorted(f for f in os.listdir(FIX) if sniff(open(os.path.join(FIX, f), 'rb').read(16)))
print('files', len(files), flush=True)
with open(OUT, 'w') as fo, ThreadPoolExecutor(int(os.environ.get('JOBS', '8'))) as ex:
    for res in ex.map(work, files):
        for r in res: fo.write(json.dumps(r) + '\n')
        fo.flush()
        print(res[0]['file'], flush=True)

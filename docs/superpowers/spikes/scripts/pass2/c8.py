# PROVES: Task 5 (write-up section 5, C8: share of PDQ quality <= 49): part 1 measures every fixture through the approved scan-frame pipeline, part 2 generates and
#   measures the 120-image seeded non-photographic corpus (not a screenshot corpus, not a launch estimate).
# INPUTS: arguments FIXROOT (with set/ and big/ subdirectories) and OUTDIR; no env vars. Runs inside the Docker container tjspike2-pdq (needs magick, pdqtool and the
#   DejaVuSans font path used in the file).
# EFFECTS: creates OUTDIR, OUTDIR/gen/*.png (120 generated images), c8_fixtures.tsv and c8_generated.tsv; writes the scratch file /tmp/q.raw (fixed name) in the
#   container; runs magick and pdqtool subprocesses; no network.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# C8 inside container tjspike2-pdq. usage: c8.py FIXROOT OUTDIR
# Part 1: PDQ quality of every fixture under the approved scan-frame pipeline.
# Part 2: a generated non-photographic corpus (120 images; synthetic, seeded) -> same measurement.
import os, sys, subprocess, random, json, struct

FIX, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def sniff(b):
    if b[:3] == b'\xff\xd8\xff': return 'jpeg'
    if b[:8] == b'\x89PNG\r\n\x1a\n': return 'png'
    if b[:6] in (b'GIF87a', b'GIF89a'): return 'gif'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP': return 'webp'


def dims(path, fmt):
    sel = '[0]' if fmt in ('gif', 'webp') else ''
    r = subprocess.run(['magick', 'identify', '-format', '%w %h', f'{fmt}:{path}{sel}'], capture_output=True)
    w, h = r.stdout.split()[:2]
    return int(w), int(h)


def quality(path):
    data = open(path, 'rb').read()
    fmt = sniff(data)
    w, h = dims(path, fmt)
    small = w <= 512 and h <= 512
    sel = '[0]' if fmt in ('gif', 'webp') else ''
    cmd = ['magick', f'{fmt}:fd:0{sel}', '-alpha', 'off', '-colorspace', 'sRGB']
    if not small: cmd += ['-define', 'sample:offset=0', '-sample', '512x512!']
    cmd += ['-depth', '8', 'rgb:fd:1']
    with open(path, 'rb') as fh:
        p = subprocess.run(cmd, stdin=fh, capture_output=True)
    if p.returncode != 0 or p.stderr: return None, f'IMERR {p.stderr[:60]!r}'
    ow, oh = (w, h) if small else (512, 512)
    open('/tmp/q.raw', 'wb').write(p.stdout)
    r = subprocess.run(['pdqtool', 'raw', '/tmp/q.raw', str(ow), str(oh)], capture_output=True, text=True)
    t = r.stdout.split()
    if len(t) != 2: return None, 'PDQERR ' + r.stdout[:40]
    return int(t[1]), 'ok'


rows = []
for sub in ('set', 'big'):
    d = os.path.join(FIX, sub)
    for f in sorted(os.listdir(d)):
        q, st = quality(os.path.join(d, f))
        if f.startswith('p') and f[1:3].isdigit(): grp = 'real_photo'
        elif f.startswith('s_'): grp = 'synthetic'
        elif f.startswith(('d_', 'e_')): grp = 'photo_derived_variant'
        else: grp = 'other'
        rows.append((grp, f, q, st))
with open(os.path.join(OUT, 'c8_fixtures.tsv'), 'w') as fh:
    for r in rows: fh.write('\t'.join(map(str, r)) + '\n')


def share(rs):
    n = len(rs); k = sum(1 for r in rs if r[2] is not None and r[2] <= 49); e = sum(1 for r in rs if r[2] is None)
    return n, k, e


print('== fixtures (approved pipeline, PDQ reference core)')
for g in ('real_photo', 'photo_derived_variant', 'synthetic'):
    rs = [r for r in rows if r[0] == g]
    n, k, e = share(rs)
    print(f'  {g}: n={n} quality<=49: {k} ({100.0 * k / max(n, 1):.1f}%) errors={e}')
n, k, e = share(rows)
print(f'  ALL: n={n} quality<=49: {k} ({100.0 * k / n:.1f}%) errors={e}')
print('  quality<=49 files:', [(r[1], r[2]) for r in rows if r[2] is not None and r[2] <= 49])
print('  synthetic detail:', [(r[1], r[2]) for r in rows if r[0] == 'synthetic'])

# ---- generated non-photographic corpus
random.seed(20261008)
G = os.path.join(OUT, 'gen'); os.makedirs(G, exist_ok=True)
PAL = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#333333', '#f2f2f2']


def im(*a):
    r = subprocess.run(["magick", *a], capture_output=True)
    if r.returncode: raise SystemExit("magick failed: " + r.stderr.decode()[:300])


def text_shot(i, dark):
    w, h = random.choice([(1280, 720), (1920, 1080), (1024, 768)])
    bg, fg = ('#1e1e1e', '#d4d4d4') if dark else ('#ffffff', '#222222')
    d = ['-size', f'{w}x{h}', f'xc:{bg}', '-font', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '-fill', fg, '-pointsize', str(random.choice([14, 16, 18, 20]))]
    y = 30
    words = 'the quick brown fox jumps over lazy dog value total index config return error status user'.split()
    while y < h - 20:
        line = ' '.join(random.choice(words) for _ in range(random.randint(4, 14)))
        d += ['-draw', f"text {random.choice([20, 40, 60])},{y} '{line}'"]
        y += random.choice([22, 24, 26])
    p = f'{G}/text_{"dark" if dark else "light"}_{i:03d}.png'; im(*d, p); return p


def bar_chart(i):
    w, h = 1000, 600
    d = ['-size', f'{w}x{h}', 'xc:white', '-stroke', '#cccccc']
    for g in range(0, 6): d += ['-draw', f'line 60,{100 + g * 80} 960,{100 + g * 80}']
    d += ['-stroke', 'none']
    n = random.randint(4, 12); bw = 800 // n
    for k in range(n):
        hh = random.randint(40, 400)
        d += ['-fill', random.choice(PAL), '-draw', f'rectangle {80 + k * bw},{500 - hh} {80 + k * bw + bw - 12},500']
    p = f'{G}/bar_{i:03d}.png'; im(*d, p); return p


def line_chart(i):
    w, h = 1000, 600
    d = ['-size', f'{w}x{h}', 'xc:white', '-stroke', '#e5e5e5']
    for g in range(0, 10): d += ['-draw', f'line {60 + g * 100},60 {60 + g * 100},540']
    for g in range(0, 7): d += ['-draw', f'line 60,{60 + g * 80} 960,{60 + g * 80}']
    for s in range(random.randint(1, 4)):
        pts = ' '.join(f'{60 + k * 45},{random.randint(80, 520)}' for k in range(21))
        d += ['-stroke', random.choice(PAL), '-strokewidth', '3', '-fill', 'none', '-draw', f'polyline {pts}']
    p = f'{G}/line_{i:03d}.png'; im(*d, p); return p


def flat_logo(i):
    w = h = random.choice([256, 512, 800])
    d = ['-size', f'{w}x{h}', f'xc:{random.choice(PAL)}', '-fill', random.choice(PAL)]
    for s in range(random.randint(1, 4)):
        if random.random() < .5: d += ['-draw', f'circle {random.randint(100, w - 100)},{random.randint(100, h - 100)} {random.randint(50, 200)},{random.randint(50, 300)}']
        else: d += ['-draw', f'rectangle {random.randint(0, w // 2)},{random.randint(0, h // 2)} {random.randint(w // 2, w)},{random.randint(h // 2, h)}']
    p = f'{G}/logo_{i:03d}.png'; im(*d, p); return p


def diagram(i):
    w, h = 1200, 700
    d = ['-size', f'{w}x{h}', 'xc:white', '-stroke', '#333333', '-strokewidth', '2', '-fill', 'none']
    boxes = []
    for k in range(random.randint(3, 8)):
        x, y = random.randint(20, w - 220), random.randint(20, h - 120)
        d += ['-draw', f'roundrectangle {x},{y} {x + 180},{y + 80} 10,10']; boxes.append((x + 90, y + 40))
    for a, b in zip(boxes, boxes[1:]): d += ['-draw', f'line {a[0]},{a[1]} {b[0]},{b[1]}']
    p = f'{G}/diagram_{i:03d}.png'; im(*d, p); return p


def ui_mock(i):
    w, h = 1440, 900
    d = ['-size', f'{w}x{h}', 'xc:#f5f5f7', '-fill', '#ffffff', '-stroke', '#d0d0d0']
    d += ['-draw', f'rectangle 0,0 {w},56', '-draw', 'rectangle 0,56 240,900']
    for k in range(random.randint(3, 9)):
        x, y = 280 + (k % 3) * 380, 100 + (k // 3) * 260
        d += ['-fill', 'white', '-draw', f'roundrectangle {x},{y} {x + 340},{y + 220} 8,8', '-fill', random.choice(PAL), '-stroke', 'none', '-draw', f'rectangle {x + 16},{y + 16} {x + 120},{y + 40}', '-stroke', '#d0d0d0']
    p = f'{G}/ui_{i:03d}.png'; im(*d, p); return p


def banner(i):
    w, h = 1200, 300
    p = f'{G}/gradient_{i:03d}.png'
    im('-size', f'{w}x{h}', f'gradient:{random.choice(PAL)}-{random.choice(PAL)}', p); return p


gens = []
for i in range(20): gens.append(('screenshot_text_light', text_shot(i, False)))
for i in range(15): gens.append(('screenshot_text_dark', text_shot(i, True)))
for i in range(15): gens.append(('chart_bar', bar_chart(i)))
for i in range(15): gens.append(('chart_line', line_chart(i)))
for i in range(15): gens.append(('flat_logo', flat_logo(i)))
for i in range(15): gens.append(('diagram', diagram(i)))
for i in range(15): gens.append(('ui_mock', ui_mock(i)))
for i in range(10): gens.append(('gradient_banner', banner(i)))
res = {}
rows2 = []
for kind, p in gens:
    q, st = quality(p)
    rows2.append((kind, os.path.basename(p), q, st))
with open(os.path.join(OUT, 'c8_generated.tsv'), 'w') as fh:
    for r in rows2: fh.write('\t'.join(map(str, r)) + '\n')
print(f'== generated non-photographic corpus (seeded, synthetic; indicative only), n={len(rows2)}')
kinds = sorted(set(r[0] for r in rows2))
for k in kinds:
    rs = [r for r in rows2 if r[0] == k]
    n, kk, e = share(rs)
    print(f'  {k}: n={n} quality<=49: {kk} ({100.0 * kk / n:.0f}%) errors={e}  q range {min(r[2] for r in rs if r[2] is not None)}-{max(r[2] for r in rs if r[2] is not None)}')
n, kk, e = share(rows2)
print(f'  ALL generated: n={n} quality<=49: {kk} ({100.0 * kk / n:.1f}%) errors={e}')

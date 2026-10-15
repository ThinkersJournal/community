# PROVES: Stage A, section 4c 'Animated GIF/WebP frame 0': Hamming distance of frame 0 and frame 1 of d_anim.gif / d_anim.webp against stills built from p01 and p02 (the write-up reports 2 and 6 for frame 0 vs its still, 130 for frame 0 vs the other still).
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /fix/orig/p01.jpg, /fix/orig/p02.jpg, /fix/set/d_anim.gif, /fix/set/d_anim.webp; needs magick and pdqtool on PATH.
# EFFECTS: writes /tmp/a.raw (overwritten per call) and prints one result line per animated file. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
import subprocess, os
def ham(a, b): return bin(int(a, 16) ^ int(b, 16)).count('1')
def h(cmd, data=None):
    raw = subprocess.run(cmd + ['-colorspace', 'sRGB', '-define', 'sample:offset=0', '-sample', '512x512!', '-depth', '8', 'rgb:-'], input=data, capture_output=True).stdout
    assert len(raw) == 786432, len(raw)
    open('/tmp/a.raw', 'wb').write(raw)
    return subprocess.run(['pdqtool', 'raw', '/tmp/a.raw', '512', '512'], capture_output=True, text=True).stdout.split()[0]
S = '/fix/orig/'
still0 = h(['magick', S + 'p01.jpg', '-resize', '400x300!', '-alpha', 'off'])
still1 = h(['magick', S + 'p02.jpg', '-resize', '400x300!', '-alpha', 'off'])
for fn, fmt in (('d_anim.gif', 'gif'), ('d_anim.webp', 'webp')):
    d = open('/fix/set/' + fn, 'rb').read()
    f0 = h(['magick', f'{fmt}:-[0]', '-alpha', 'off'], d)
    f1 = h(['magick', f'{fmt}:-[1]', '-alpha', 'off'], d)
    print(fn, 'frame0 vs still0 =', ham(f0, still0), '| frame0 vs still1 =', ham(f0, still1), '| frame1 vs still1 =', ham(f1, still1), '| frame1 vs still0 =', ham(f1, still0))

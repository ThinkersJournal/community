# PROVES: C8 real-corpus measurement (2026-10-08-c8-real-corpus-measurement.md, Method and Result): runs each corpus file through the scan-frame pipeline (alpha off, sRGB, sample:offset=0 sample to 512x512 only when a side exceeds 512, 8-bit rgb) and reports reference PDQ quality; output columns file fmt w h native_le512 quality status.
# INPUTS: argv[1] = corpus directory (the write-up says it was mounted read-only into a throwaway container with --network none). Needs magick and pdqtool on PATH; the script sets no MAGICK_CONFIGURE_PATH, so the container's default policy applies.
# EFFECTS: writes /tmp/q.raw (overwritten per file) and prints TSV rows to stdout. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
# in container: measure.py DIR  -> TSV to stdout: file fmt w h native_le512 quality status
import os, sys, subprocess
D = sys.argv[1]
def sniff(b):
    if b[:3] == b'\xff\xd8\xff': return 'jpeg'
    if b[:8] == b'\x89PNG\r\n\x1a\n': return 'png'
    if b[:6] in (b'GIF87a', b'GIF89a'): return 'gif'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP': return 'webp'
for f in sorted(os.listdir(D)):
    p = os.path.join(D, f); fmt = sniff(open(p,'rb').read(16))
    if not fmt: print(f, '?', 0, 0, '', '', 'NOFMT', sep='\t'); continue
    sel = '[0]' if fmt in ('gif','webp') else ''
    r = subprocess.run(['magick','identify','-format','%w %h',f'{fmt}:{p}{sel}'],capture_output=True)
    w,h = map(int,r.stdout.split()[:2]); small = w<=512 and h<=512
    cmd = ['magick',f'{fmt}:fd:0{sel}','-alpha','off','-colorspace','sRGB']
    if not small: cmd += ['-define','sample:offset=0','-sample','512x512!']
    cmd += ['-depth','8','rgb:fd:1']
    with open(p,'rb') as fh: pr = subprocess.run(cmd,stdin=fh,capture_output=True)
    if pr.returncode or pr.stderr: print(f,fmt,w,h,int(small),'',f'IMERR {pr.stderr[:80]!r}',sep='\t'); continue
    ow,oh = (w,h) if small else (512,512)
    open('/tmp/q.raw','wb').write(pr.stdout)
    t = subprocess.run(['pdqtool','raw','/tmp/q.raw',str(ow),str(oh)],capture_output=True,text=True).stdout.split()
    print(f,fmt,w,h,int(small),t[1] if len(t)==2 else '', 'ok' if len(t)==2 else 'PDQERR',sep='\t')

# PROVES: Stage B, section 5 (no-disk / stdin handling): runs one ImageMagick decode with stdin given as a seekable regular file, an anonymous pipe, or a memfd, to show that pipe stdin spools to disk and file or memfd stdin does not. It is the helper driven by stageb2.sh and stageb3.sh.
# INPUTS: argv: MODE (file|pipe|memfd) INPUT CODER POLDIR TMPDIR [extra magick args]. Sets MAGICK_CONFIGURE_PATH=POLDIR, MAGICK_TEMPORARY_PATH and TMPDIR=TMPDIR, HOME=/nonexistent. Ran inside the container (policy dirs under /tmp/pol or /s/pol).
# EFFECTS: runs one magick (<coder>:fd:0 to rgb:fd:1, 512x512 sample) with captured output and prints one summary line. memfd mode creates an in-RAM memfd. Pipe mode deliberately reproduces the hazard: ImageMagick spools the input to a magick-* file in TMPDIR (or the cwd if TMPDIR does not exist) before the policy blocks the re-open.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
import os, subprocess, sys
# usage: runim.py MODE INPUT CODER POLDIR TMPDIR [extra magick args...]
# MODE: file (stdin = regular file opened O_RDONLY, seekable), pipe (stdin = anonymous pipe), memfd (stdin = sealed-in-RAM memfd, seekable)
mode, inp, coder, pol, tmpd = sys.argv[1:6]
extra = sys.argv[6:]
data = open(inp, 'rb').read()
env = dict(os.environ, MAGICK_CONFIGURE_PATH=pol, MAGICK_TEMPORARY_PATH=tmpd, TMPDIR=tmpd, HOME='/nonexistent')
cmd = ['magick', f'{coder}:fd:0', '-colorspace', 'sRGB', '-define', 'sample:offset=0', '-sample', '512x512!', '-depth', '8'] + extra + ['rgb:fd:1']
if mode == 'file':
    fd = os.open(inp, os.O_RDONLY)
    p = subprocess.run(cmd, stdin=fd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
elif mode == 'pipe':
    p = subprocess.run(cmd, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
elif mode == 'memfd':
    fd = os.memfd_create('tjin', 0)
    os.write(fd, data)
    os.lseek(fd, 0, os.SEEK_SET)
    p = subprocess.run(cmd, stdin=fd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
else:
    sys.exit(2)
print(f'mode={mode} input={os.path.basename(inp)} rc={p.returncode} outbytes={len(p.stdout)} stderr={p.stderr[:160].decode(errors="replace")!r}')

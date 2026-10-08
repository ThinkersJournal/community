# PROVES: nothing itself; it is the test wrapper (harness only, not the product) that Tasks 1-4, 6 and 7 exercise (write-up section 1): body -> memfd -> one magick run
#   -> framed result; any stderr or non-zero exit is a 422.
# INPUTS: runs inside the distro as the tj-wrapper.service process (fd 3 from the socket when LISTEN_FDS=1, else binds 127.0.0.1:$PORT, default 8088). Env: MAX_BODY,
#   WRAP_MODE (memfd|pipe), WRAP_LOG_MARKER, WRAP_DEADLINE, WRAP_PROBE, POLDIR, IMTMP, CHILD_FSIZE0, MAGICK_MEMORY_LIMIT. Reads /usr/bin/magick and the policy under
#   POLDIR (default /opt/tj/magick).
# EFFECTS: serves HTTP on loopback; spawns /usr/bin/magick children in their own session and kills that child's process group on deadline; log lines to stderr only.
#   Writes no file by default, but the negative controls do: WRAP_PROBE=1 writes /tmp/probe, WRAP_MODE=pipe or IMTMP=/tmp lets magick use temporary files, and
#   WRAP_LOG_MARKER=1 deliberately logs the marker.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name). Qualification: its only kill is of the magick child it spawned.
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# Test harness only (not the product). Stateless HTTP wrapper: body -> memfd -> approved ImageMagick pipeline -> framed result.
import resource, os, sys, socket, json, subprocess, threading, struct, hashlib, time
import socketserver
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = int(os.environ.get('MAX_BODY', 24 * 1024 * 1024))
MODE = os.environ.get('WRAP_MODE', 'memfd')       # memfd (approved) | pipe (NEGATIVE CONTROL: anonymous-pipe stdin)
LOG_MARKER = os.environ.get('WRAP_LOG_MARKER') == '1'   # CONTROL: deliberately logs the EXIF marker
DEADLINE = float(os.environ.get('WRAP_DEADLINE', '20'))
IM = '/usr/bin/magick'


def log(msg):  # fixed-format lines only
    sys.stderr.write('<5>' + msg + '\n')  # sd-daemon NOTICE prefix so LogLevelMax=notice keeps it
    sys.stderr.flush()


def sniff(b):
    if b[:3] == b'\xff\xd8\xff': return 'jpeg'
    if b[:8] == b'\x89PNG\r\n\x1a\n': return 'png'
    if b[:6] in (b'GIF87a', b'GIF89a'): return 'gif'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP': return 'webp'
    return None


def dims(fmt, b):
    if fmt == 'png': return struct.unpack('>II', b[16:24])
    if fmt == 'gif': return struct.unpack('<HH', b[6:10])
    if fmt == 'webp':
        k = b[12:16]
        if k == b'VP8 ':
            w, h = struct.unpack('<HH', b[26:30])
            return w & 0x3fff, h & 0x3fff
        if k == b'VP8L':
            v = struct.unpack('<I', b[21:25])[0]
            return (v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1
        if k == b'VP8X':
            return int.from_bytes(b[24:27], 'little') + 1, int.from_bytes(b[27:30], 'little') + 1
    if fmt == 'jpeg':
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xFF:
                i += 1
                continue
            m = b[i + 1]
            if m == 0xFF:
                i += 1
                continue
            if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                i += 2
                continue
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack('>HH', b[i + 5:i + 9])
                return w, h
            i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    raise ValueError('no dims')


def process(body):
    if os.environ.get('WRAP_PROBE') == '1':  # NEGATIVE CONTROL: a deliberate disk write
        open('/tmp/probe', 'w').write('x')
    fmt = sniff(body)
    if not fmt: raise ValueError('unsupported')
    w, h = dims(fmt, body)
    small = w <= 512 and h <= 512
    if MODE == 'memfd':
        fd = os.memfd_create('tjbody', 0)
        mv = memoryview(body)
        off = 0
        while off < len(body): off += os.write(fd, mv[off:off + (1 << 20)])
        os.lseek(fd, 0, os.SEEK_SET)
        stdin = fd
    else:
        stdin = subprocess.PIPE
    src = f'{fmt}:fd:0' + ('[0]' if fmt in ('gif', 'webp') else '')
    scan = ['-alpha', 'off', '-colorspace', 'sRGB']
    if not small: scan += ['-define', 'sample:offset=0', '-sample', '512x512!']
    scan += ['-depth', '8', '-write', 'rgb:fd:3', '+delete']
    cmd = [IM, src, '(', '+clone'] + scan + [')', '-auto-orient', '-resize', '2048x2048>', '-strip',
           '-quality', '82', '-define', 'webp:method=4', '-define', 'webp:thread-level=0', 'webp:fd:1']
    rr, rw = os.pipe()

    def pre():
        os.dup2(rw, 3)
        if os.environ.get('CHILD_FSIZE0', '1') == '1':
            resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))  # kernel-level: the IM child can write no file
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    env = {'MAGICK_CONFIGURE_PATH': os.environ.get('POLDIR', '/opt/tj/magick'),
           'MAGICK_TEMPORARY_PATH': os.environ.get('IMTMP', '/nonexistent'),
           'TMPDIR': os.environ.get('IMTMP', '/nonexistent'), 'HOME': '/nonexistent',
           'MAGICK_TIME_LIMIT': '10', 'PATH': '/usr/bin'}
    if os.environ.get('MAGICK_MEMORY_LIMIT'): env['MAGICK_MEMORY_LIMIT'] = os.environ['MAGICK_MEMORY_LIMIT']
    p = subprocess.Popen(cmd, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(3,),
                         preexec_fn=pre, start_new_session=True, env=env)
    os.close(rw)
    if stdin != subprocess.PIPE: os.close(stdin)
    rgb = bytearray()

    def rd():
        with os.fdopen(rr, 'rb', 0) as f:
            while True:
                c = f.read(1 << 16)
                if not c: break
                rgb.extend(c)

    t = threading.Thread(target=rd)
    t.start()
    try:
        out, err = p.communicate(input=body if stdin == subprocess.PIPE else None, timeout=DEADLINE)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, 9)
        p.communicate()
        t.join()
        raise RuntimeError('deadline')
    t.join()
    if p.returncode != 0 or err:  # any stderr = failure
        raise RuntimeError('decode_failed')
    sw, sh = (w, h) if small else (512, 512)
    if len(rgb) != sw * sh * 3 or not out:
        raise RuntimeError('bad_output')
    hdr = json.dumps({'v': 1, 'info': {'format': fmt, 'width': w, 'height': h}, 'scan': {'width': sw, 'height': sh},
                      'rgb_len': len(rgb), 'webp_len': len(out)}).encode()
    return struct.pack('>I', len(hdr)) + hdr + bytes(rgb) + out


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a): pass

    def _send(self, code, body, ct='application/octet-stream'):
        self.send_response(code)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self): self._send(200, b'ok', 'text/plain')

    def do_POST(self):
        t0 = time.time()
        try:
            n = int(self.headers.get('Content-Length', '-1'))
            if n < 0 or n > MAX_BODY:
                self._send(413, b'too_large', 'text/plain')
                self.close_connection = True
                return
            buf = bytearray()
            while len(buf) < n:
                c = self.rfile.read(min(1 << 20, n - len(buf)))
                if not c: break
                buf.extend(c)
            body = bytes(buf)
            if LOG_MARKER:
                i = body.find(b'TJ-MARKER-')
                if i >= 0: log('POSITIVE-CONTROL leaked: ' + body[i:i + 40].decode('latin1'))
            res = process(body)
            self._send(200, res)
            log(f'req ok in={n} out={len(res)} ms={int((time.time() - t0) * 1000)}')
        except Exception as e:
            log(f'req fail class={type(e).__name__}:{e}')
            try:
                self._send(422, b'fail', 'text/plain')
            except Exception:
                pass


class S(ThreadingHTTPServer):
    def __init__(self, sock, handler):  # adopt an already-listening socket; never creates an AF_INET socket itself
        socketserver.BaseServer.__init__(self, sock.getsockname(), handler)
        self.socket = sock


if __name__ == '__main__':
    if os.environ.get('LISTEN_FDS') == '1':
        sock = socket.socket(fileno=3)
    else:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', int(os.environ.get('PORT', '8088'))))
        sock.listen(16)
    srv = S(sock, H)
    log('wrapper started')
    srv.serve_forever()

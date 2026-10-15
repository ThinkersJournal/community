# PROVES: Task 4 (write-up section 4, C7): the per-file sweep whose output t4.sh compares (status, shortened sha256 of scan frame and of stored WebP, WebP length).
#   Usage: sweep.py PORT DIR OUT.
# INPUTS: arguments PORT, DIR (every regular file in it is POSTed to 127.0.0.1:PORT) and OUT; no env vars. Runs inside the distro.
# EFFECTS: sends one POST per file; writes OUT (one line per file) and prints a count.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# usage: sweep.py PORT DIR OUT  -> one line per file: name status rgb_sha webp_sha webp_len
import sys, os, http.client, struct, json, hashlib
port, d, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = []
for f in sorted(os.listdir(d)):
    p = os.path.join(d, f)
    if not os.path.isfile(p): continue
    body = open(p, 'rb').read()
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=120)
    try:
        c.request('POST', '/d', body=body, headers={'Content-Length': str(len(body))})
        r = c.getresponse(); data = r.read()
    except Exception as e:
        lines.append(f'{f} EXC {type(e).__name__} - - 0'); continue
    finally:
        c.close()
    if r.status != 200:
        lines.append(f'{f} {r.status} - - 0'); continue
    hl = struct.unpack('>I', data[:4])[0]; h = json.loads(data[4:4 + hl])
    rgb = data[4 + hl:4 + hl + h['rgb_len']]; webp = data[4 + hl + h['rgb_len']:]
    lines.append(f"{f} 200 {hashlib.sha256(rgb).hexdigest()[:16]} {hashlib.sha256(webp).hexdigest()[:16]} {len(webp)}")
open(out, 'w', newline='\n').write('\n'.join(lines) + '\n')
print(out, len(lines), 'files', sum(1 for l in lines if ' 200 ' in l), 'ok')

# PROVES: nothing itself; test client used by t1, t2*, t3, t6b, t7 and lib.sh drive_all against the wrapper. Usage: client.py PORT FILE [runs] [outprefix].
# INPUTS: arguments PORT and FILE (an image path), optional runs and an output file path (the 4th argument); connects to 127.0.0.1:PORT only. Runs inside the distro. No
#   env vars.
# EFFECTS: POSTs FILE to /decode runs times and prints one JSON line (status, format, dims, scan size, shortened sha256 of scan frame and WebP, timings); exits 1 on
#   non-200; writes the returned WebP to the 4th argument if given.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
# usage: client.py PORT FILE [runs] [outprefix]
import sys, http.client, struct, hashlib, time, json
port, f = int(sys.argv[1]), sys.argv[2]
runs = int(sys.argv[3]) if len(sys.argv) > 3 else 1
body = open(f, 'rb').read()
ms = []
last = None
for _ in range(runs):
    t = time.perf_counter()
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=60)
    c.request('POST', '/decode', body=body, headers={'Content-Length': str(len(body))})
    r = c.getresponse()
    d = r.read()
    c.close()
    ms.append((time.perf_counter() - t) * 1000)
    last = (r.status, d)
st, d = last
if st != 200:
    print(json.dumps({'file': f.split('/')[-1], 'status': st, 'body': d[:40].decode('latin1')}))
    sys.exit(1)
hl = struct.unpack('>I', d[:4])[0]
h = json.loads(d[4:4 + hl])
rgb = d[4 + hl:4 + hl + h['rgb_len']]
webp = d[4 + hl + h['rgb_len']:]
ms.sort()
q = lambda p: ms[min(len(ms) - 1, int(round(p * (len(ms) - 1))))]
print(json.dumps({'file': f.split('/')[-1], 'status': st, 'fmt': h['info']['format'], 'dims': [h['info']['width'], h['info']['height']],
                  'scan': [h['scan']['width'], h['scan']['height']], 'rgb_len': h['rgb_len'], 'rgb_sha': hashlib.sha256(rgb).hexdigest()[:16],
                  'webp_len': len(webp), 'webp_sha': hashlib.sha256(webp).hexdigest()[:16], 'runs': runs,
                  'p50_ms': round(q(.5), 1), 'p95_ms': round(q(.95), 1), 'max_ms': round(ms[-1], 1)}))
if len(sys.argv) > 4: open(sys.argv[4], 'wb').write(webp)

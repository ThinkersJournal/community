# PROVES: nothing itself; builds the Task 3 marker input (write-up section 3): a JPEG with the marker in EXIF ImageDescription and Artist plus a COM segment. Also used
#   by t6a.sh for the tunnel marker.
# INPUTS: arguments in.jpg out.jpg MARKER (no env vars); in.jpg must be a JPEG. Runs inside the distro.
# EFFECTS: reads in.jpg and writes out.jpg only.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
import sys, struct
# usage: mkmarker.py in.jpg out.jpg MARKER : inserts EXIF APP1 (ImageDescription + Artist containing MARKER) and a COM segment
src, dst, marker = sys.argv[1:4]
d = open(src, 'rb').read()
assert d[:2] == b'\xff\xd8'
m = marker.encode() + b'\x00'
# TIFF: 2 entries, ASCII strings stored after IFD
ifd_off = 8
n = 2
data_off = ifd_off + 2 + n * 12 + 4
e1 = struct.pack('<HHII', 0x010E, 2, len(m), data_off)
e2 = struct.pack('<HHII', 0x013B, 2, len(m), data_off + len(m))
tiff = b'II*\x00' + struct.pack('<I', ifd_off) + struct.pack('<H', n) + e1 + e2 + b'\x00\x00\x00\x00' + m + m
app1 = b'\xff\xe1' + struct.pack('>H', 2 + 6 + len(tiff)) + b'Exif\x00\x00' + tiff
com = b'\xff\xfe' + struct.pack('>H', 2 + len(m)) + m
pos = 2
if d[2:4] == b'\xff\xe0':
    pos = 4 + struct.unpack('>H', d[4:6])[0]
open(dst, 'wb').write(d[:pos] + app1 + com + d[pos:])

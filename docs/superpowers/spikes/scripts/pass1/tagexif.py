# PROVES: Section 4c 'EXIF orientation' fixtures (8 tags x 2 sizes): inserts a minimal EXIF APP1 with the Orientation tag into a JPEG. Called by mkfix.sh. Inferred from the code; the write-up does not name this script.
# INPUTS: argv[1] = JPEG path, argv[2] = orientation value 1-8. Ran inside the container via mkfix.sh (/s/tagexif.py).
# EFFECTS: rewrites the given JPEG IN PLACE (adds the APP1 segment after the JFIF APP0 if present).
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
import sys, re, struct
# usage: tagexif.py file.jpg orientation   (inserts a minimal EXIF APP1 after the JFIF APP0)
p, o = sys.argv[1], int(sys.argv[2])
d = open(p, 'rb').read()
assert d[:2] == b'\xff\xd8'
tiff = b'II*\x00\x08\x00\x00\x00' + b'\x01\x00' + struct.pack('<HHIHH', 0x0112, 3, 1, o, 0) + b'\x00\x00\x00\x00'
app1 = b'\xff\xe1' + struct.pack('>H', 2 + 6 + len(tiff)) + b'Exif\x00\x00' + tiff
pos = 2
if d[2:4] == b'\xff\xe0':
    pos = 4 + struct.unpack('>H', d[4:6])[0]
open(p, 'wb').write(d[:pos] + app1 + d[pos:])

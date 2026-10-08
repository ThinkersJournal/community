// PROVES: Stage A, section 4 (hash fidelity, C6) and pass 3: the small tool around the reference PDQ core (write-up section 1: modes file, frame, raw, rawdih) that produced H_ref (file), the reference 512 frame (frame) and the hash/quality of an ImageMagick frame (raw, rawdih).
// INPUTS: argv: file <path> | frame <path> <outraw> | raw <rawfile> <w> <h> | rawdih <rawfile> <w> <h>. Compiled against the ThreatExchange pdq/cpp headers and CImg.h; the build command is not recorded here (write-up section 1: reference built with g++ -O3). Invoked as pdqtool from PATH by sweep.py, anim.py, native.py and measure.py.
// EFFECTS: prints hash and quality to stdout; frame mode writes the raw RGB file named by argv[3]; file and frame modes use the reference loader, which per write-up section 2 shells out to ImageMagick convert.
// BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers). (This is C++ source; it contains no docker or kill calls.)
// ARCHIVED: preserved verbatim from the spike session.
// Spike tool. Modes:
//  file <path>              -> "hex quality" using the reference pdqHash256FromFile (its own loader + CImg resize)
//  frame <path> <outraw>    -> loads with reference loader (CImg), applies reference resize if >512, writes raw interleaved RGB
//                              (grey replicated), prints "w h channels"
//  raw <path> <w> <h>       -> reference PDQ core on interleaved RGB raw
#include <pdq/cpp/io/pdqio.h>
#include <pdq/cpp/hashing/pdqhashing.h>
#include <pdq/cpp/downscaling/downscaling.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "CImg.h"
using namespace facebook::pdq::hashing;
int main(int argc, char** argv) {
  if (argc < 3) return 2;
  std::string m = argv[1];
  if (m == "file") {
    Hash256 h; int q = 0, hw = 0; float rs = 0, hs = 0;
    if (!pdqHash256FromFile(argv[2], h, q, hw, rs, hs)) { printf("FAIL\n"); return 1; }
    printf("%s %d %d\n", h.format().c_str(), q, hw);
    return 0;
  }
  if (m == "frame") {
    cimg_library::CImg<uint8_t> in;
    try { in.load(argv[2]); } catch (...) { printf("FAIL\n"); return 1; }
    int ow = in.width(), oh = in.height(), oc = in.spectrum();
    if (in.height() > 512 || in.width() > 512) in = in.resize(512, 512);
    FILE* f = fopen(argv[3], "wb");
    for (int y = 0; y < in.height(); y++) for (int x = 0; x < in.width(); x++) for (int c = 0; c < 3; c++) {
      uint8_t v = in(x, y, 0, in.spectrum() == 3 ? c : 0); fwrite(&v, 1, 1, f); }
    fclose(f);
    printf("%d %d %d  orig %d %d %d\n", in.width(), in.height(), in.spectrum(), ow, oh, oc);
    return 0;
  }
  if (m == "raw" || m == "rawdih") {
    int w = atoi(argv[3]), h = atoi(argv[4]);
    std::vector<uint8_t> b((size_t)w * h * 3);
    FILE* f = fopen(argv[2], "rb"); if (!f) return 1;
    size_t n = fread(b.data(), 1, b.size(), f);
    int extra = fgetc(f); fclose(f);
    if (n != b.size() || extra != EOF) { printf("BADLEN %zu\n", n); return 1; }
    std::vector<float> l1((size_t)w * h), l2((size_t)w * h);
    facebook::pdq::downscaling::fillFloatLumaFromRGB(b.data(), b.data() + 1, b.data() + 2, h, w, 3 * w, 3, l1.data());
    float b64[64][64]; float b1664[16][64]; float b16[16][16];
    Hash256 hash; int q = 0;
    if (m == "raw") {
      pdqHash256FromFloatLuma(l1.data(), l2.data(), h, w, b64, b1664, b16, hash, q);
      printf("%s %d\n", hash.format().c_str(), q);
      return 0;
    }
    float aux[16][16];
    Hash256 d[8];
    bool ok = pdqDihedralHash256esFromFloatLuma(l1.data(), l2.data(), h, w, b64, b1664, b16, aux,
      &d[0], &d[1], &d[2], &d[3], &d[4], &d[5], &d[6], &d[7], q);
    if (!ok) { printf("DIHFAIL\n"); return 1; }
    for (int i = 0; i < 8; i++) printf("%s ", d[i].format().c_str());
    printf("%d\n", q);
    return 0;
  }
  return 2;
}

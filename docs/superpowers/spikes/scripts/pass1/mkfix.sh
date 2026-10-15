#!/bin/sh
# PROVES: Section 3 'Fixtures': derives and generates the non-photo fixtures from the downloaded photos (format variants, animated GIF/WebP, EXIF orientation 1-8 JPEGs at 400x300 and 3000x2000, synthetic images, and the 8-bit reference copy /fix/ref/d_rgb16.png).
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Reads /fix/orig/p*.jpg (from download.py) and calls /s/tagexif.py; sets MAGICK_TEMPORARY_PATH=/tmp; uses the default ImageMagick policy (no MAGICK_CONFIGURE_PATH set); has set -eu.
# EFFECTS: creates /fix/set (copies of p*.jpg plus d_*, e_o*, s_* files) and /fix/ref/d_rgb16.png; writes and removes its own temporary _base_*.png and _p.png in /fix/set; prints the file count. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
# Derives synthetic/derived fixtures from the downloaded CC0 photos. Runs inside the container.
set -eu
SRC=/fix/orig
DST=/fix/set
mkdir -p $DST
export MAGICK_TEMPORARY_PATH=/tmp
cp $SRC/p*.jpg $DST/
# derived from CC0 photos (same licence as source)
magick $SRC/p02.jpg -resize 64x -strip $DST/d_small64.jpg
magick $SRC/p06.jpg -resize 300x -strip $DST/d_small300.png
magick $SRC/p05.jpg -interlace Plane -strip $DST/d_progressive12mp.jpg
magick $SRC/p03.jpg -resize 1600x -colorspace Gray -strip $DST/d_gray.jpg
magick $SRC/p03.jpg -resize 1600x -colorspace Gray -depth 8 $DST/d_gray.png
magick $SRC/p02.jpg -resize 1600x -colorspace CMYK -strip $DST/d_cmyk.jpg
magick $SRC/p01.jpg -resize 2000x -quality 70 -strip $DST/d_lossy.webp
magick $SRC/p04.jpg -resize 1500x -quality 60 \( -size 1500x1000 radial-gradient:white-black \) -alpha off -compose copy_opacity -composite $DST/d_alpha_lossy.webp
magick $SRC/p05.jpg -resize 1200x -alpha set \( -size 1200x675 radial-gradient:white-black \) -alpha off -compose copy_opacity -composite $DST/d_alpha.png
magick $SRC/p01.jpg -resize 1200x -depth 16 $DST/d_rgb16.png
magick $SRC/p02.jpg -resize 1200x -colors 64 -type Palette $DST/d_palette.png
# animated: frame 0 differs visibly from the rest
magick -delay 10 -loop 0 \( $SRC/p01.jpg -resize 400x300! \) \( $SRC/p02.jpg -resize 400x300! \) \( $SRC/p03.jpg -resize 400x300! \) \( $SRC/p04.jpg -resize 400x300! \) $DST/d_anim.gif
magick -delay 10 -loop 0 \( $SRC/p01.jpg -resize 400x300! \) \( $SRC/p02.jpg -resize 400x300! \) \( $SRC/p03.jpg -resize 400x300! \) \( $SRC/p04.jpg -resize 400x300! \) -quality 80 $DST/d_anim.webp
# EXIF orientation: pixels P_o chosen so that applying orientation o's transform to P_o gives the base image; tag with o.
# EXIF 1..8 -> IM names: 1 TopLeft, 2 TopRight, 3 BottomRight, 4 BottomLeft, 5 LeftTop, 6 RightTop, 7 RightBottom, 8 LeftBottom
# 6 and 8 are each other's inverse; the rest are involutions.
mk() {
  S=$1
  B=$DST/_base_$S.png
  magick $SRC/p04.jpg -resize ${S}^ -gravity center -extent $S +repage -strip $B
  for o in 1 2 3 4 5 6 7 8; do
    case $o in
      1) t=TopLeft; inv=TopLeft;;
      2) t=TopRight; inv=TopRight;;
      3) t=BottomRight; inv=BottomRight;;
      4) t=BottomLeft; inv=BottomLeft;;
      5) t=LeftTop; inv=LeftTop;;
      6) t=RightTop; inv=LeftBottom;;
      7) t=RightBottom; inv=RightBottom;;
      8) t=LeftBottom; inv=RightTop;;
    esac
    magick $B -orient $inv -auto-orient +repage -orient Undefined -strip $DST/_p.png
    magick $DST/_p.png -quality 92 $DST/e_o${o}_$S.jpg
    python3 -I /s/tagexif.py $DST/e_o${o}_$S.jpg $o
    rm $DST/_p.png
  done
}
mk 400x300
mk 3000x2000
# synthetic
magick -size 1024x768 gradient:red-blue -depth 8 -strip $DST/s_gradient.png
magick -size 800x600 pattern:checkerboard -depth 8 -strip $DST/s_checker.png
magick -size 1000x1000 xc:gray50 -seed 42 +noise Random -depth 8 -strip $DST/s_noise.png
magick -size 640x480 xc:'rgb(120,200,90)' -depth 8 -strip $DST/s_flat.png
magick -size 1x1 xc:'rgb(10,20,30)' -depth 8 $DST/s_1x1.png
magick -size 10000x5 gradient:white-black -depth 8 $DST/s_10000x5.png
magick -size 5x10000 gradient:white-black -depth 8 $DST/s_5x10000.png
magick -size 900x600 xc:white -fill blue -draw "rectangle 40,200 500,400" -fill red -draw "circle 700,400 760,400" -depth 8 -strip $DST/s_text.png
rm -f $DST/_base_*.png
mkdir -p /fix/ref
magick $DST/d_rgb16.png -depth 8 /fix/ref/d_rgb16.png
ls $DST | wc -l

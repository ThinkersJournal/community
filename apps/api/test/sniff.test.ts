import { describe, expect, it } from "vitest";

import { sniffImageFormat, SNIFF_HEADER_BYTES } from "../src/media/sniff";

const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
/** A header padded to the real slice length the route will pass. */
const header = (head: Uint8Array): Uint8Array => {
  const out = new Uint8Array(SNIFF_HEADER_BYTES);
  out.set(head.subarray(0, SNIFF_HEADER_BYTES));
  return out;
};

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF87A = ascii("GIF87a");
const GIF89A = ascii("GIF89a");
const webp = (): Uint8Array => {
  const out = new Uint8Array(12);
  out.set(ascii("RIFF"), 0);
  out.set(ascii("WEBP"), 8); // "WEBP" at offset 8, NOT 4 (4..8 is the size)
  return out;
};

describe("the allowlist accepts exactly four formats", () => {
  it.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["PNG", PNG, "image/png"],
    ["GIF87a", GIF87A, "image/gif"],
    ["GIF89a", GIF89A, "image/gif"],
    ["WebP", webp(), "image/webp"],
  ] as const)("%s", (_n, head, expected) => {
    expect(sniffImageFormat(header(head))).toBe(expected);
  });
});

describe("SVG fails BY CONSTRUCTION (this is the whole point)", () => {
  it.each([
    ["bare", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"],
    ["leading whitespace", "   \n\t<svg/>"],
    ["XML declaration", '<?xml version="1.0"?><svg/>'],
    ["leading comment", "<!-- hi --><svg/>"],
    ["BOM", "﻿<svg/>"],
    ["DOCTYPE", "<!DOCTYPE svg><svg/>"],
    ["uppercase", "<SVG xmlns='http://www.w3.org/2000/svg'/>"],
  ])("%s", (_name, svg) => {
    // ⚠️ SVG IS A SUPPORTED CLOUDFLARE IMAGES INPUT — the binding will NOT
    // reject any of these. This function is the only thing that does. And it
    // works because SVG has NO magic number: every variant above starts with
    // different bytes, which is exactly why DENYlisting a signature fails.
    expect(sniffImageFormat(header(ascii(svg)))).toBeNull();
  });

  it("SVG bytes are rejected even with a .png filename / image/png Content-Type lie — the sniff ignores both", () => {
    // The sniff signature only accepts a header(...) Uint8Array — there is no
    // filename or Content-Type parameter to pass, which IS the point: the
    // function cannot be fooled by metadata it never receives.
    const svgWithPngLie = header(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    expect(sniffImageFormat(svgWithPngLie)).toBeNull();
  });
});

describe("everything else is rejected", () => {
  it.each([
    ["empty", new Uint8Array(0)],
    ["one byte", bytes(0xff)],
    ["two bytes", bytes(0xff, 0xd8)],
    ["three bytes", bytes(0x89, 0x50, 0x4e)],
    ["a truncated PNG signature", bytes(0x89, 0x50, 0x4e)],
    ["a truncated JPEG signature", bytes(0xff, 0xd8)],
    ["HTML", ascii("<!DOCTYPE html><html>")],
    ["a PDF", ascii("%PDF-1.7")],
    ["a ZIP", bytes(0x50, 0x4b, 0x03, 0x04)],
    ["ELF", bytes(0x7f, 0x45, 0x4c, 0x46)],
    ["all zeroes", new Uint8Array(SNIFF_HEADER_BYTES)],
  ])("%s", (_name, head) => {
    expect(sniffImageFormat(head)).toBeNull();
  });

  it("RIFF that is NOT WebP (a WAV)", () => {
    const wav = new Uint8Array(12);
    wav.set(ascii("RIFF"), 0);
    wav.set(ascii("WAVE"), 8);
    // The RIFF container is shared. Checking only "RIFF" would accept audio.
    expect(sniffImageFormat(wav)).toBeNull();
  });

  it("RIFF that is NOT WebP (an AVI)", () => {
    const avi = new Uint8Array(12);
    avi.set(ascii("RIFF"), 0);
    avi.set(ascii("AVI "), 8);
    expect(sniffImageFormat(avi)).toBeNull();
  });

  it("RIFF truncated before offset 8 does not read past the end", () => {
    expect(sniffImageFormat(ascii("RIFF"))).toBeNull();
  });

  it("a 4-byte RIFF header with nothing at offset 8 is NOT accepted as WebP", () => {
    expect(sniffImageFormat(bytes(0x52, 0x49, 0x46, 0x46))).toBeNull();
  });

  it("a valid PNG signature with one byte flipped is rejected", () => {
    const flipped = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00);
    expect(sniffImageFormat(flipped)).toBeNull();
  });

  it("a buffer shorter than the longest signature (PNG, 8 bytes) does not throw", () => {
    expect(() => sniffImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).not.toThrow();
    expect(sniffImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBeNull();
  });
});

describe("polyglots", () => {
  it("a JPEG-prefixed polyglot sniffs as JPEG — the .info() cross-check is what catches it", () => {
    const poly = new Uint8Array(SNIFF_HEADER_BYTES);
    poly.set(JPEG, 0);
    poly.set(ascii("<svg"), 4);
    // Honest about the bound: a signature check answers "what does this claim
    // to be", never "what will a decoder do with it". The belt-and-braces is
    // Task 8's free IMAGES.info() format cross-check.
    expect(sniffImageFormat(poly)).toBe("image/jpeg");
  });
});

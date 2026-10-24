// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";

import { b64urlToBytes } from "../src/auth/encoding";

const bytes = (s: string): number[] | null => {
  const out = b64urlToBytes(s);
  return out === null ? null : Array.from(out);
};

// Characterization of the shared base64url DECODER (#39). It is an
// authentication boundary (Access JWT + unsubscribe token): every case below
// pins the behaviour of the two pre-existing copies, which were identical.
describe("b64urlToBytes (characterization)", () => {
  it("decodes all four length%4 cases", () => {
    expect(bytes("")).toEqual([]); // len 0
    expect(bytes("YQ")).toEqual([0x61]); // len%4==2
    expect(bytes("YWI")).toEqual([0x61, 0x62]); // len%4==3
    expect(bytes("YWJj")).toEqual([0x61, 0x62, 0x63]); // len%4==0
  });

  it("returns null for length%4==1 (impossible base64)", () => {
    expect(bytes("Y")).toBeNull();
    expect(bytes("YWJjZ")).toBeNull();
  });

  it("maps '-' to '+' and '_' to '/'", () => {
    // 0xfb 0xff 0xbf encodes to "+/+/" in standard base64 -> "-_-_" url-safe.
    expect(bytes("-_-_")).toEqual([0xfb, 0xff, 0xbf]);
    expect(bytes("-w")).toEqual([0xfb]);
    expect(bytes("_w")).toEqual([0xff]);
  });

  it("round-trips arbitrary bytes through base64urlEncode", async () => {
    const { base64urlEncode } = await import("../src/auth/encoding");
    for (let n = 0; n <= 9; n++) {
      const src = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 0xfb) & 0xff);
      expect(bytes(base64urlEncode(src))).toEqual(Array.from(src));
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const enc = base64urlEncode(all);
    expect(enc).toMatch(/[-_]/);
    expect(bytes(enc)).toEqual(Array.from(all));
  });

  it("returns null (never throws) for invalid characters", () => {
    expect(bytes("!!!!")).toBeNull();
    expect(bytes("YW Jj*")).toBeNull();
    expect(bytes("\u00e9\u00e9\u00e9\u00e9")).toBeNull();
  });

  it("pins current behaviour for standard-base64 '+' '/' input: accepted", () => {
    expect(bytes("+/+/")).toEqual([0xfb, 0xff, 0xbf]);
    expect(bytes("+w")).toEqual([0xfb]);
  });

  it("pins current behaviour for already-padded input: accepted", () => {
    expect(bytes("YQ==")).toEqual([0x61]);
    expect(bytes("YWI=")).toEqual([0x61, 0x62]);
    // length 3 with one '=': padding is topped up to a valid "YQ=="
    expect(bytes("YQ=")).toEqual([0x61]);
  });
});

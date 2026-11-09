// SPDX-License-Identifier: MIT OR Apache-2.0
// Adversarial-review regression tests for #286 (items 6 and 7).
import { describe, expect, it } from "vitest";

import { capSnapshot, SNAPSHOT_CAPS, type Snapshot } from "../src/references";

const bytes = (s: Snapshot) => new TextEncoder().encode(JSON.stringify(s)).byteLength;

describe("review 6: capSnapshot strips bidi and invisible controls from text", () => {
  // Mutation that must fail this: skip the cleaning pass.
  it("title, description, excerpt keep no bidi override characters", () => {
    const bad = [0x202a, 0x202e, 0x2066, 0x2069, 0x061c, 0x180e, 0x200e, 0x200f].map((c) => String.fromCharCode(c)).join("");
    const web = capSnapshot({ kind: "web", title: `a${bad}b`, description: `c${bad}d`, siteName: `s${bad}`, finalUrl: "https://e.com/" });
    if (web.kind !== "web") throw new Error("kind changed");
    expect(web.title).toBe("ab");
    expect(web.description).toBe("cd");
    expect(web.siteName).toBe("s");
    const repo = capSnapshot({ kind: "github", type: "file", title: "t", state: "open", capturedAt: "x", excerpt: `line1${bad}\nline2` });
    if (repo.kind === "web") throw new Error("kind changed");
    expect(repo.excerpt).toBe("line1\nline2");
  });
});

describe("review 7: the 16 KB invariant holds for ANY input", () => {
  // Mutation that must fail this: leave capturedAt uncapped.
  it("caps capturedAt at 40 characters", () => {
    const got = capSnapshot({ kind: "github", type: "issue", title: "t", state: "open", capturedAt: "9".repeat(30_000) });
    if (got.kind === "web") throw new Error("kind changed");
    expect(got.capturedAt.length).toBe(40);
    expect(bytes(got)).toBeLessThanOrEqual(SNAPSHOT_CAPS.totalJsonBytes);
  });

  it("caps a stored image key", () => {
    const got = capSnapshot({ kind: "web", title: "t", finalUrl: "https://e.com/", image: { storage: "stored", key: "k".repeat(30_000), width: 1, height: 1 } });
    expect(bytes(got)).toBeLessThanOrEqual(SNAPSHOT_CAPS.totalJsonBytes);
  });

  // Mutation that must fail this: remove the final hard fallback.
  it("property-style loop of nasty inputs never exceeds 16 KB and never throws", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pools = ["\u0001", "\u{1F600}", "\\", '"', "a", " ", "\u0000", "é"].map((s) => s);
    const nasty = (max: number) => {
      const unit = pools[Math.floor(rand() * pools.length)] ?? "a";
      return unit.repeat(Math.floor(rand() * max));
    };
    for (let i = 0; i < 300; i += 1) {
      const web: Snapshot = {
        kind: "web",
        title: nasty(9000),
        description: nasty(9000),
        siteName: nasty(9000),
        finalUrl: nasty(40_000),
        image: rand() < 0.5 ? { storage: "remote", url: nasty(40_000), alt: nasty(9000) } : { storage: "stored", key: nasty(40_000), width: 1, height: 1, alt: nasty(9000) },
      };
      const repo: Snapshot = {
        kind: "gitlab",
        type: "pr",
        title: nasty(9000),
        state: nasty(9000),
        author: nasty(9000),
        excerpt: nasty(60_000),
        path: nasty(9000),
        ref: nasty(9000),
        capturedAt: nasty(40_000),
        lines: [1, 2],
      };
      expect(bytes(capSnapshot(web))).toBeLessThanOrEqual(SNAPSHOT_CAPS.totalJsonBytes);
      expect(bytes(capSnapshot(repo))).toBeLessThanOrEqual(SNAPSHOT_CAPS.totalJsonBytes);
    }
  });
});

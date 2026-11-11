// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.2a: access-driven refresh taper (design decision 22) and the access/diff rule (spec section 3).
import type { LiveResult } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { mergeLive, nextCheckAt, retryAt, type LiveState } from "../src/references/refresh-schedule";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("nextCheckAt (taper with last_viewed_at)", () => {
  it("checks soon after a recent view", () => {
    expect(nextCheckAt(NOW, ago(10 * MIN))?.getTime()).toBe(NOW.getTime() + 5 * MIN);
  });
  it("slows as the last view ages", () => {
    expect(nextCheckAt(NOW, ago(3 * HOUR))?.getTime()).toBe(NOW.getTime() + HOUR);
    expect(nextCheckAt(NOW, ago(3 * DAY))?.getTime()).toBe(NOW.getTime() + 6 * HOUR);
    expect(nextCheckAt(NOW, ago(14 * DAY))?.getTime()).toBe(NOW.getTime() + DAY);
  });
  it("goes dormant (null) when never viewed or unviewed past 21 days", () => {
    expect(nextCheckAt(NOW, null)).toBeNull();
    expect(nextCheckAt(NOW, ago(22 * DAY))).toBeNull();
  });
});

describe("retryAt (never a hot loop)", () => {
  it("backs off exponentially from 15 minutes, capped at 24 hours", () => {
    expect(retryAt(NOW, 0).getTime()).toBe(NOW.getTime() + 15 * MIN);
    expect(retryAt(NOW, 1).getTime()).toBe(NOW.getTime() + 30 * MIN);
    expect(retryAt(NOW, 3).getTime()).toBe(NOW.getTime() + 2 * HOUR);
    expect(retryAt(NOW, 50).getTime()).toBe(NOW.getTime() + DAY);
  });
});

describe("mergeLive (access is not diff)", () => {
  const prev: LiveState = { access: "ok", diff: "changed", observedAt: "2026-11-10T00:00:00.000Z" };
  for (const access of ["rate_limited", "error", "forbidden"] as const) {
    it(`${access} leaves the stored live_state untouched`, () => {
      const res: LiveResult = { access, diff: "unknown" };
      expect(mergeLive(prev, res, NOW)).toBe(prev);
      expect(mergeLive(null, res, NOW)).toBeNull();
    });
  }
  it("not_modified/unchanged refreshes observedAt only", () => {
    const out = mergeLive(prev, { access: "not_modified", diff: "unchanged" }, NOW);
    expect(out).toEqual({ ...prev, observedAt: NOW.toISOString() });
  });
  it("a definitive gone is recorded as gone", () => {
    const out = mergeLive(prev, { access: "gone", diff: "gone" }, NOW);
    expect(out).toEqual({ access: "gone", diff: "gone", observedAt: NOW.toISOString() });
  });
  it("changed keeps the new snapshot", () => {
    const snapshot = { kind: "web", title: "T", finalUrl: "https://a.example.com/" } as const;
    const out = mergeLive(prev, { access: "ok", diff: "changed", snapshot }, NOW);
    expect(out).toEqual({ access: "ok", diff: "changed", observedAt: NOW.toISOString(), snapshot });
  });
});

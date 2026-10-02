import { describe, expect, it, vi } from "vitest";

import { withWindowRolloverRetry } from "./helpers/window-rollover-retry";

/**
 * Pure unit test of `withWindowRolloverRetry`'s retry/rethrow decision —
 * see that file's header for why this exists (CI run 36965048036 on #137:
 * the round-1 version never retried a THROWN failure, which is the one
 * failure mode a rollover actually causes). An injectable clock means this
 * covers all four branches deterministically, with no real wall-clock
 * timing and no workers pool.
 */
describe("withWindowRolloverRetry", () => {
  /** Returns each value in `values` in turn, then repeats the last one. */
  function clockSequence(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)]!;
  }

  it("rethrows a failure with NO rollover — a real bug inside one window must still fail", async () => {
    const now = clockSequence([0, 0]); // same epoch on both reads
    const err = new Error("real assertion failure");
    const attempt = vi.fn(async () => {
      throw err;
    });

    await expect(withWindowRolloverRetry(attempt, now)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries once and lets a SUCCESSFUL retry stand, when the window rolled over during a throw", async () => {
    const now = clockSequence([0, 60_000]); // epoch 0 -> epoch 1
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("spurious failure from the stale window");
    });

    await expect(withWindowRolloverRetry(attempt, now)).resolves.toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("retries once on rollover even when the FIRST attempt already succeeded", async () => {
    const now = clockSequence([0, 60_000]);
    const attempt = vi.fn(async () => {});

    await withWindowRolloverRetry(attempt, now);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("propagates a SECOND failure — retrying never swallows a genuine bug", async () => {
    const now = clockSequence([0, 60_000]);
    const secondErr = new Error("still broken after the retry");
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      throw calls === 1 ? new Error("first failure, window rolled") : secondErr;
    });

    await expect(withWindowRolloverRetry(attempt, now)).rejects.toBe(secondErr);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

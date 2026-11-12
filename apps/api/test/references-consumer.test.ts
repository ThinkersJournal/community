// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { consumeRefreshBatch, type QueueMessageLike } from "../src/references/refresh-consumer";

/**
 * consumeRefreshBatch (M3.2c-3b): one Queue batch -> one refresh per distinct reference id. A finished refresh (any
 * outcome, including "unknown" and "throttled", which the runner already rescheduled) is acked; a malformed body is acked
 * and dropped (a retry could never fix it); a throw (a database error) is retried so the message is not lost.
 */
function msg(body: unknown): QueueMessageLike & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe("consumeRefreshBatch", () => {
  it("runs the refresh for each message and acks it (mutation: forget to ack)", async () => {
    const a = msg({ referenceId: "r1" });
    const b = msg({ referenceId: "r2" });
    const run = vi.fn(async () => "refreshed" as const);
    await consumeRefreshBatch([a, b], run);
    expect(run.mock.calls.map((c) => c[0])).toEqual(["r1", "r2"]);
    expect(a.ack).toHaveBeenCalledTimes(1);
    expect(b.ack).toHaveBeenCalledTimes(1);
    expect(a.retry).not.toHaveBeenCalled();
  });

  it("acks every outcome the runner finished with, including unknown and throttled (mutation: retry on unknown)", async () => {
    for (const outcome of ["missing", "gone", "orphan", "throttled", "unknown", "refreshed"] as const) {
      const m = msg({ referenceId: "r" });
      await consumeRefreshBatch([m], async () => outcome);
      expect(m.ack, outcome).toHaveBeenCalledTimes(1);
      expect(m.retry, outcome).not.toHaveBeenCalled();
    }
  });

  it("retries a message whose refresh threw, and carries on with the rest (mutation: let the throw escape / ack it)", async () => {
    const bad = msg({ referenceId: "boom" });
    const good = msg({ referenceId: "ok" });
    const run = vi.fn(async (id: string) => {
      if (id === "boom") throw new Error("db down");
      return "refreshed" as const;
    });
    await consumeRefreshBatch([bad, good], run);
    expect(bad.retry).toHaveBeenCalledTimes(1);
    expect(bad.ack).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalledTimes(1);
  });

  it("acks and drops a malformed body without running anything (mutation: run with undefined, or retry)", async () => {
    const bodies: unknown[] = [null, "r1", 42, {}, { referenceId: 7 }, { referenceId: "" }];
    const ms = bodies.map(msg);
    const run = vi.fn(async () => "refreshed" as const);
    await consumeRefreshBatch(ms, run);
    expect(run).not.toHaveBeenCalled();
    for (const m of ms) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  it("refreshes a reference once when the batch repeats its id, and acks every copy (mutation: run per message)", async () => {
    const a = msg({ referenceId: "r1" });
    const b = msg({ referenceId: "r1" });
    const run = vi.fn(async () => "refreshed" as const);
    await consumeRefreshBatch([a, b], run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a.ack).toHaveBeenCalledTimes(1);
    expect(b.ack).toHaveBeenCalledTimes(1);
  });

  it("retries every copy when a repeated id's refresh threw", async () => {
    const a = msg({ referenceId: "r1" });
    const b = msg({ referenceId: "r1" });
    await consumeRefreshBatch([a, b], async () => {
      throw new Error("db down");
    });
    expect(a.retry).toHaveBeenCalledTimes(1);
    expect(b.retry).toHaveBeenCalledTimes(1);
  });
});

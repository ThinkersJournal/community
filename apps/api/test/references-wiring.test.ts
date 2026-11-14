// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { budgetFromEnv, enqueueDue } from "../src/references/refresh-wiring";

/**
 * The Worker glue for the reference refresh (M3.2c-3c), tested with fakes: the budget adapter must ask the AUTHOR's own
 * Durable Object (one bucket per author), and the sweep must send exactly the claimed ids, one message each.
 */
describe("budgetFromEnv", () => {
  it("spends from the named author's own bucket and returns its answer (mutation: one shared name, or drop the cost)", async () => {
    const take = vi.fn(async (_cost: number) => ({ ok: true as const, state: { tokens: 59, updatedAt: 1 } }));
    const getByName = vi.fn((_name: string) => ({ take }));
    const budget = budgetFromEnv({ AUTHOR_BUDGET: { getByName } } as unknown as Pick<Env, "AUTHOR_BUDGET">);
    const out = await budget.take("author-7", 3);
    expect(getByName).toHaveBeenCalledWith("author-7");
    expect(take).toHaveBeenCalledWith(3);
    expect(out.ok).toBe(true);
  });

  it("passes a refusal through with its retryAfterMs (mutation: swallow it)", async () => {
    const refusal = { ok: false as const, state: { tokens: 0, updatedAt: 1 }, retryAfterMs: 5000 };
    const budget = budgetFromEnv({
      AUTHOR_BUDGET: { getByName: () => ({ take: async () => refusal }) },
    } as unknown as Pick<Env, "AUTHOR_BUDGET">);
    expect(await budget.take("a", 1)).toEqual(refusal);
  });
});

describe("enqueueDue", () => {
  it("sends one message per claimed id and returns the count (mutation: send ids joined, or drop one)", async () => {
    const sendBatch = vi.fn(async () => {});
    const n = await enqueueDue(async () => ["r1", "r2", "r3"], { sendBatch });
    expect(n).toBe(3);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledWith([{ body: { referenceId: "r1" } }, { body: { referenceId: "r2" } }, { body: { referenceId: "r3" } }]);
  });

  it("sends nothing when nothing is due (mutation: send an empty batch)", async () => {
    const sendBatch = vi.fn(async () => {});
    expect(await enqueueDue(async () => [], { sendBatch })).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("lets a failed send throw, so the caller logs it; the claimed rows are retried when their lease ends", async () => {
    const sendBatch = vi.fn(async () => {
      throw new Error("queue down");
    });
    await expect(enqueueDue(async () => ["r1"], { sendBatch })).rejects.toThrow("queue down");
  });
});

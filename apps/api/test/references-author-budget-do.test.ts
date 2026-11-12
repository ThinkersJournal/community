// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.2b: AuthorBudgetDO persists the token bucket per author. Pool project, real DO storage, explicit clock.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AUTHOR_BUDGET } from "../src/references/author-budget";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const fresh = () => env.AUTHOR_BUDGET.getByName(`test-author-${crypto.randomUUID()}`);

describe("AuthorBudgetDO", () => {
  it("allows a full bucket of spends, then refuses and says when to retry", async () => {
    await runInDurableObject(fresh(), async (b) => {
      for (let i = 0; i < AUTHOR_BUDGET.capacity; i++) expect((await b.takeAt(1, T0)).ok).toBe(true);
      const refused = await b.takeAt(1, T0);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.retryAfterMs).toBe(MIN); // 1 token per minute
    });
  });

  it("the balance survives across calls and refills with time", async () => {
    await runInDurableObject(fresh(), async (b) => {
      for (let i = 0; i < AUTHOR_BUDGET.capacity; i++) await b.takeAt(1, T0);
      expect((await b.takeAt(1, T0 + MIN - 1)).ok).toBe(false);
      expect((await b.takeAt(1, T0 + MIN)).ok).toBe(true);
    });
  });

  it("a refused spend does not drain the balance", async () => {
    await runInDurableObject(fresh(), async (b) => {
      for (let i = 0; i < AUTHOR_BUDGET.capacity; i++) await b.takeAt(1, T0);
      for (let i = 0; i < 5; i++) await b.takeAt(1, T0);
      expect((await b.takeAt(1, T0 + MIN)).ok).toBe(true);
    });
  });

  it("authors are independent", async () => {
    const a = fresh();
    const other = fresh();
    await runInDurableObject(a, async (b) => {
      for (let i = 0; i < AUTHOR_BUDGET.capacity; i++) await b.takeAt(1, T0);
      expect((await b.takeAt(1, T0)).ok).toBe(false);
    });
    await runInDurableObject(other, async (b) => {
      expect((await b.takeAt(1, T0)).ok).toBe(true);
    });
  });

  it("rejects a cost that is not a positive integer", async () => {
    await runInDurableObject(fresh(), async (b) => {
      for (const bad of [0, -1, 1.5, Number.NaN]) await expect(b.takeAt(bad, T0)).rejects.toThrow(RangeError);
    });
  });
});

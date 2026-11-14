// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-3c: the thin glue between the refresh engine and the Worker (STUB: red-first; the behaviour lands in the next commit).
 */
import type { RefreshBudget } from "./refresh";

export function budgetFromEnv(_env: Pick<Env, "AUTHOR_BUDGET">): RefreshBudget {
  throw new Error("not implemented");
}

export interface BatchSender {
  sendBatch(messages: { body: { referenceId: string } }[]): Promise<void>;
}

export async function enqueueDue(_claim: () => Promise<string[]>, _queue: BatchSender): Promise<number> {
  throw new Error("not implemented");
}

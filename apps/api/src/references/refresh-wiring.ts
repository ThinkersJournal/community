// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-3c: the thin glue between the refresh engine and the Worker. The pure parts (`budgetFromEnv`, `enqueueDue`) are
 * unit-tested with fakes; the two Env-bound entry points (`sweepDueReferences` on the cron tick, `handleRefreshQueue` as the
 * Queue consumer) only assemble them.
 *
 * The sweep is behind `REFERENCE_REFRESH` ("1" = on, anything else off, shipped "0"): the queue and the consumer can exist
 * while nothing is sent. A claimed id whose message never reaches the queue is simply retried when its lease ends
 * (refresh-queue.ts), so a failed send is logged, never fatal.
 */
import { createGuardedFetch } from "./guarded-fetch";
import { claimDueRefreshes, type RefreshMessage } from "./refresh-queue";
import { consumeRefreshBatch } from "./refresh-consumer";
import { refreshReference, type RefreshBudget } from "./refresh";
import { defaultRegistry } from "./registry";
import { withClient } from "../db/client";

import type { FetchCtx } from "@thinkersjournal/shared";

/** The per-author budget, backed by the author's own Durable Object (one bucket per author id). */
export function budgetFromEnv(env: Pick<Env, "AUTHOR_BUDGET">): RefreshBudget {
  return { take: (authorId, cost) => env.AUTHOR_BUDGET.getByName(authorId).take(cost) };
}

export interface BatchSender {
  sendBatch(messages: { body: RefreshMessage }[]): Promise<unknown>;
}

/** Claim what is due and send one message per id. Returns how many were sent; a failed send throws. */
export async function enqueueDue(claim: () => Promise<string[]>, queue: BatchSender): Promise<number> {
  const ids = await claim();
  if (ids.length === 0) return 0;
  await queue.sendBatch(ids.map((referenceId) => ({ body: { referenceId } })));
  return ids.length;
}

/** The cron tick. Never throws (it runs under `waitUntil`). */
export async function sweepDueReferences(env: Env, ctx: ExecutionContext): Promise<void> {
  if (env.REFERENCE_REFRESH !== "1") return;
  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, (db) => enqueueDue(() => claimDueRefreshes(db, new Date()), env.REFRESH_QUEUE));
  } catch (err) {
    console.error("references: refresh sweep failed", err);
  }
}

/** The Queue consumer: one database connection per batch, one refresh per distinct reference id. */
export async function handleRefreshQueue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
  const fetchCtx: FetchCtx = { fetch: createGuardedFetch({ fetchImpl: (input, init) => fetch(input, init) }) };
  const budget = budgetFromEnv(env);
  await withClient(env.HYPERDRIVE_FRESH, ctx, (db) =>
    consumeRefreshBatch(batch.messages, (id) => refreshReference(db, id, { registry: defaultRegistry, ctx: fetchCtx, budget, now: new Date() })),
  );
}

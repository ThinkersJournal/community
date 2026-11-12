// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-3b: the Queue consumer's logic, with the queue and the runner injected so it is testable without either.
 *
 * A finished refresh is acked whatever its outcome (the runner already rescheduled unknown and throttled ones). A malformed
 * body is acked and dropped: a retry cannot fix it. A throw (a database error) is retried, so the message is not lost.
 * A reference repeated within a batch is refreshed once and every copy gets the same verdict.
 */
import type { RefreshOutcome } from "./refresh";

/** The part of a Cloudflare Queue message this consumer uses. */
export interface QueueMessageLike {
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

function referenceIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { referenceId?: unknown }).referenceId;
  return typeof id === "string" && id !== "" ? id : null;
}

export async function consumeRefreshBatch(
  messages: readonly QueueMessageLike[],
  run: (referenceId: string) => Promise<RefreshOutcome>,
): Promise<void> {
  const byId = new Map<string, QueueMessageLike[]>();
  for (const m of messages) {
    const id = referenceIdOf(m.body);
    if (id === null) {
      m.ack();
      continue;
    }
    const group = byId.get(id);
    if (group) group.push(m);
    else byId.set(id, [m]);
  }
  for (const [id, group] of byId) {
    try {
      await run(id);
      for (const m of group) m.ack();
    } catch {
      for (const m of group) m.retry();
    }
  }
}

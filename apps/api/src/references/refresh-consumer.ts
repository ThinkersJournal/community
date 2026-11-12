// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-3b: the Queue consumer's logic, with the queue and the runner injected so it is testable without either.
 * (STUB: red-first; the behaviour lands in the next commit.)
 */
import type { RefreshOutcome } from "./refresh";

/** The part of a Cloudflare Queue message this consumer uses. */
export interface QueueMessageLike {
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export async function consumeRefreshBatch(
  _messages: readonly QueueMessageLike[],
  _run: (referenceId: string) => Promise<RefreshOutcome>,
): Promise<void> {
  throw new Error("not implemented");
}

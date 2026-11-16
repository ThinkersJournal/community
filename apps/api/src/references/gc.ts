// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Client } from "pg";

export const GC_GRACE_MS = 24 * 60 * 60 * 1000;
export const GC_BATCH = 500;

/** RED-FIRST STUB: deletes nothing. */
export async function gcOrphanReferences(_db: Client, _now: Date, _limit: number = GC_BATCH): Promise<number> {
  return 0;
}

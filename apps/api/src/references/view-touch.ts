// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Client } from "pg";

/** RED-FIRST STUB: touches nothing. */
export const VIEW_TOUCH_MIN_MS = 60_000;

export async function touchViewed(_db: Client, _postIds: readonly string[], _now: Date): Promise<number> {
  return 0;
}

// SPDX-License-Identifier: MIT OR Apache-2.0
/** STUB (red-first commit). */
import type { RefCard } from "@thinkersjournal/shared";
import type { Client } from "pg";

export function loadRefCards(_db: Client, _postIds: readonly string[]): Promise<Map<string, RefCard | null>> {
  return Promise.resolve(new Map());
}

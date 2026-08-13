import { USERNAME_PATTERN } from "@thinkersjournal/shared";
import { RESERVED_USERNAMES } from "./reserved-usernames";
import type { Client } from "pg";

const MAX_LEN = 30;
const SUGGESTION_COUNT = 3;

/** Candidate variants of `base`, all valid + non-reserved, in preference order. */
export function candidateHandles(base: string): string[] {
  const out: string[] = [];
  const push = (h: string): void => {
    if (USERNAME_PATTERN.test(h) && !RESERVED_USERNAMES.has(h) && !out.includes(h)) out.push(h);
  };
  for (const suffix of ["2", "3", "4", "5", "_", "1", "7", "99"]) {
    push(`${base.slice(0, MAX_LEN - suffix.length)}${suffix}`);
  }
  return out;
}

/** Up to SUGGESTION_COUNT available (unclaimed, non-reserved) handles near `base`. */
export async function suggestUsernames(client: Client, base: string): Promise<string[]> {
  const candidates = candidateHandles(base);
  if (candidates.length === 0) return [];
  const { rows } = await client.query<{ username: string }>(
    `SELECT username FROM profiles WHERE username = ANY($1::citext[])`,
    [candidates],
  );
  const taken = new Set(rows.map((r) => r.username.toLowerCase()));
  return candidates.filter((h) => !taken.has(h)).slice(0, SUGGESTION_COUNT);
}

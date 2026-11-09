// SPDX-License-Identifier: MIT OR Apache-2.0
// STUB (red-first commit): implemented in the next commit.
import type { FetchCtx } from "@thinkersjournal/shared";

export const BOT_USER_AGENT = "ThinkersJournalBot/1.0 (+https://community.thinkersjournal.com/bot)";
export const GUARD_DEFAULTS = {
  timeoutMs: 5000,
  maxBytes: 512 * 1024,
  maxRedirects: 3,
} as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ResolveHost = (host: string, signal?: AbortSignal) => Promise<string[]>;

export interface GuardedFetchOptions {
  fetchImpl: FetchLike;
  resolveHost?: ResolveHost;
  robotsAllowed?: (url: URL, signal: AbortSignal) => Promise<boolean>;
  selfHosts?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export function createGuardedFetch(_opts: GuardedFetchOptions): FetchCtx["fetch"] {
  throw new Error("not implemented");
}
export function createDohResolver(_fetchImpl: FetchLike, _endpoint?: string): ResolveHost {
  throw new Error("not implemented");
}
export function isAllowedByRobots(_robotsTxt: string, _path: string): boolean {
  throw new Error("not implemented");
}

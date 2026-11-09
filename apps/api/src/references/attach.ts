// SPDX-License-Identifier: MIT OR Apache-2.0
/** STUB (red-first commit). */
import type { LimiterLike } from "./origin-limit";
import type { Registry } from "./registry";
import type { FetchCtx } from "@thinkersjournal/shared";
import type { Client } from "pg";

export type AttachFailure =
  | "invalid_url"
  | "unsupported"
  | "blocked_target"
  | "not_found"
  | "too_large"
  | "timeout"
  | "upstream"
  | "rate_limited"
  | "too_many_references"
  | "post_not_found"
  | "internal";

export type AttachResult = { ok: true; token: string; referenceId: string; reused: boolean } | { ok: false; reason: AttachFailure };

export interface AttachDeps {
  ctx: FetchCtx;
  limiter?: LimiterLike;
  registry?: Registry;
  now?: () => Date;
  newToken?: () => string;
}

export function attachReference(
  _db: Client,
  _input: { postId: string; authorId: string; url: string },
  _deps: AttachDeps,
): Promise<AttachResult> {
  return Promise.resolve({ ok: false, reason: "internal" });
}

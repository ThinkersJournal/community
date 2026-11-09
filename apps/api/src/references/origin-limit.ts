// SPDX-License-Identifier: MIT OR Apache-2.0
/** STUB (red-first commit). */
import { ConnectorError, type FetchCtx } from "@thinkersjournal/shared";

/** The shape of a Workers `RateLimit` binding that this code needs; a binding satisfies it. */
export interface LimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export class OriginRateLimitedError extends ConnectorError {}

export function withOriginLimit(inner: FetchCtx["fetch"], _limiter: LimiterLike): FetchCtx["fetch"] {
  return inner;
}

// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The per-origin fetch rate limit (spec 5 rule 6, deferred from M3.1a): so the connectors cannot be used to hammer a
 * third-party site. It wraps the guarded door (`FetchCtx["fetch"]`) and asks a limiter, keyed on the target HOST, before
 * every call; a refused call never reaches the network.
 *
 * The limiter is injected. Production passes a Workers rate-limit binding (`RateLimit`), which satisfies `LimiterLike`;
 * tests pass a counter. ⚠️ As for every binding here (src/auth/ratelimit.ts), the limit is per Cloudflare location and
 * eventually consistent: it shapes a ceiling, it is not an exact count.
 *
 * ⚠️ Only the FIRST hop's host is counted: redirects the guard follows afterwards are not. The guard allows at most 3
 * hops and the per-user attach limit bounds how often a user can start a chain, so this is a deliberate simplification.
 *
 * Suggested binding value for the wiring PR (M3.4): `ORIGIN_FETCH_LIMIT_PER_MINUTE` per host.
 */
import { ConnectorError, type FetchCtx } from "@thinkersjournal/shared";

/** The shape of a Workers `RateLimit` binding that this code needs; a binding satisfies it. */
export interface LimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Fetches allowed per host per minute: a card unfurl is one GET, so a handful a minute is far above honest use. */
export const ORIGIN_FETCH_LIMIT_PER_MINUTE = 6;

/** Our own refusal. A `ConnectorError` (code `upstream`, retryable) so the engine treats it like any soft failure. */
export class OriginRateLimitedError extends ConnectorError {
  constructor(message = "per-origin fetch limit reached", retryable = true) {
    super("upstream", message, retryable);
    this.name = "OriginRateLimitedError";
  }
}

function originKey(input: string | URL): string {
  try {
    const url = new URL(typeof input === "string" ? input : input.href);
    return `origin:${url.hostname.toLowerCase().replace(/\.$/, "")}`;
  } catch {
    throw new ConnectorError("invalid_url", "not a URL");
  }
}

export function withOriginLimit(inner: FetchCtx["fetch"], limiter: LimiterLike): FetchCtx["fetch"] {
  return async (input, init) => {
    const { success } = await limiter.limit({ key: originKey(input) });
    if (!success) throw new OriginRateLimitedError();
    return inner(input, init);
  };
}

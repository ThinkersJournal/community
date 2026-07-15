import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { enforceRateLimit } from "../src/auth/ratelimit";

import type { ApiErrorBody } from "@thinkersjournal/shared";

/**
 * The local `@cloudflare/vitest-pool-workers` pool DOES simulate real `simple`
 * ratelimit counting (verified empirically: a bare `env.LOGIN_LIMITER.limit()`
 * loop against a single key returns `success: true` for exactly the first 10
 * calls — matching `LOGIN_LIMITER`'s `limit: 10` in `wrangler.jsonc` — then
 * `success: false` from the 11th call onward). So this suite exercises
 * `enforceRateLimit` against the REAL binding, past its configured threshold,
 * rather than needing a stub for that part.
 */
describe("enforceRateLimit", () => {
  it("returns null for calls within LOGIN_LIMITER's quota, then a 429 Response once exhausted", async () => {
    // Unique key per test run so this test never collides with quota consumed
    // by other tests/files sharing the same binding within the isolate.
    const key = `login-${crypto.randomUUID()}`;

    for (let i = 0; i < 10; i++) {
      expect(await enforceRateLimit(env.LOGIN_LIMITER, key)).toBeNull();
    }

    const blocked = await enforceRateLimit(env.LOGIN_LIMITER, key);
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked?.status).toBe(429);
  });

  it("returns a 429 Response iff the limiter reports success: false (deterministic branch logic via a stub)", async () => {
    const alwaysBlocked: RateLimit = {
      limit: async () => ({ success: false }),
    };
    const alwaysAllowed: RateLimit = {
      limit: async () => ({ success: true }),
    };

    const blocked = await enforceRateLimit(alwaysBlocked, "k");
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked?.status).toBe(429);
    expect(((await blocked?.json()) as ApiErrorBody).code).toBe("RATE_LIMITED");

    expect(await enforceRateLimit(alwaysAllowed, "k")).toBeNull();
  });

  it("wires the real SIGNUP_LIMITER / LOGIN_LIMITER bindings as callable RateLimits", () => {
    expect(env.SIGNUP_LIMITER).toBeDefined();
    expect(env.LOGIN_LIMITER).toBeDefined();
    expect(typeof env.SIGNUP_LIMITER.limit).toBe("function");
    expect(typeof env.LOGIN_LIMITER.limit).toBe("function");
  });
});

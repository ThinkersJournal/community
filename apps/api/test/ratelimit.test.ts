import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { awaitLimiterBurstWindow } from "./helpers/limiter-window";
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
    //
    // ⚠️ Uniqueness alone does NOT make this burst deterministic: the limiter
    // wipes EVERY key when its wall-clock window rolls, so a burst straddling a
    // minute boundary loses its count no matter how private its key is. See
    // ./helpers/limiter-window.ts.
    const key = `login-${crypto.randomUUID()}`;
    await awaitLimiterBurstWindow();

    for (let i = 0; i < 10; i++) {
      expect(await enforceRateLimit(env.LOGIN_LIMITER, key)).toBeNull();
    }

    const blocked = await enforceRateLimit(env.LOGIN_LIMITER, key);
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked?.status).toBe(429);
  },
  // ⚠️ REQUIRED, and this was the ONE `awaitLimiterBurstWindow` caller missing it
  // (login's three, resend's and signup's all have it). The helper may hold the
  // burst for up to ~12s waiting for a clean window, which does not fit vitest's
  // 5s default: whenever this test's body happened to start in the last ~10s of a
  // wall-clock minute it timed out — ~17% of runs, at random, with a failure
  // message ("Test timed out in 5000ms") that pointed nowhere near the cause.
  // Reproduced on an unmodified tree; nothing about the code under test changed.
  //
  // NOT a flake-hiding timeout bump: the wait is bounded and deliberate, the
  // burst still has to earn its 429 from the REAL limiter binding, and the
  // assertions above are untouched. See ./helpers/limiter-window.ts.
  60_000);

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

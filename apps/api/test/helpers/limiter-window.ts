/**
 * Keeps a rate-limiter burst inside ONE limiter window.
 *
 * ⚠️ WITHOUT THIS, EVERY "SPEND THE QUOTA, THEN ASSERT A 429" TEST IS A
 * WALL-CLOCK LOTTERY — and it is the limiter EMULATOR's shape, not our routes',
 * that makes it one.
 *
 * `@cloudflare/vitest-pool-workers` backs `SIGNUP_LIMITER`/`LOGIN_LIMITER` with
 * miniflare's local limiter, whose whole implementation is
 * (miniflare/dist/src/workers/ratelimit/ratelimit-object.worker.js):
 *
 *     const epoch = Math.floor(Date.now() / (period * 1000));
 *     if (epoch !== this.#epoch) { this.#epoch = epoch; this.#buckets.clear(); }
 *     const value = this.#buckets.get(key) ?? 0;
 *     if (value >= limit) return { success: false };
 *     this.#buckets.set(key, value + 1);
 *     return { success: true };
 *
 * Two properties of that are load-bearing here:
 *
 *   1. The window is a FIXED window aligned to the WALL CLOCK — `Date.now()`
 *      divided by the period. For our `period: 60` limiters the boundary is
 *      every absolute wall-clock minute, and NOT relative to when a test starts.
 *      Nothing about a test's own timing shifts it.
 *   2. On a roll it calls `#buckets.clear()`, wiping EVERY key — including the
 *      per-test unique key the burst has been carefully filling.
 *
 * So a burst that straddles a minute boundary has its count silently reset
 * mid-flight, and the request that was supposed to be blocked sails through with
 * the route's normal status instead of a 429. The assertion then fails for a
 * reason that has nothing whatsoever to do with the code under test.
 *
 * ⚠️ IT IS NOT A "SLOW UNDER LOAD" PROBLEM, AND NOT A SHARED-KEY PROBLEM —
 * both of those were the natural first guesses and BOTH ARE WRONG. Every burst
 * already uses a per-test unique email/key, so no two tests share a bucket. And
 * an instrumented full-suite run caught the failure in the act: the burst took
 * **928ms end to end** (~85ms per request), with the minute boundary falling
 * inside it. The burst is not slow; it is simply ~1s wide and unpinned, so it
 * lands on a boundary in roughly 1-2% of runs at random. That is why it passes
 * 12/12 in isolation and still fails eventually in a long run — a small sample
 * of a low-probability event, not a load effect.
 *
 * ⚠️ WHY A LEAD-IN AS WELL AS A BUDGET. The same instrumented run showed the
 * TEST's clock had already crossed the boundary before request 1 (the burst ran
 * entirely inside the new minute by its own reckoning) and the burst STILL lost
 * its count — which means the limiter Durable Object rolled the epoch LATER than
 * the test observed it. That is workerd's `Date.now()` semantics: the clock is
 * pinned and only advances on I/O, so the DO's view of "now" lags the test's.
 * Being just PAST a boundary is therefore not safe either — the DO may still be
 * a step behind and roll underneath the burst. `BURST_LEAD_IN_MS` holds the
 * burst off until both clocks are unambiguously inside the same window.
 *
 * ⚠️ THIS WEAKENS NOTHING. It is not a retry, not a timeout bump, and not a
 * loosened assertion: the burst still has to earn its 429 from the real limiter
 * binding, and deleting a route's `email:` bucket still turns its test RED
 * (mutation-verified). All this does is refuse to START a burst in the ~1s of
 * each minute where the emulator would pull the rug out from under it.
 */

/** Matches `simple.period: 60` on both limiters in `wrangler.jsonc`. */
const LIMITER_PERIOD_MS = 60_000;

/**
 * How far PAST a window boundary the burst must start, to cover the limiter
 * DO's lagging clock (see the header). Requests are ~85ms apart, so 2s is a
 * ~20x margin on the lag actually observed.
 */
const BURST_LEAD_IN_MS = 2_000;

/**
 * How much room the burst needs BEFORE the next boundary. The widest burst in
 * the suite (login's 11 Argon2id-paying requests) measured ~1s under full-suite
 * load, so this is a ~10x margin.
 */
const BURST_BUDGET_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Resolve once there is a full `BURST_BUDGET_MS` of the current limiter window
 * left to run a burst in. Usually returns immediately (the safe band is 50 of
 * every 60 seconds); at worst it waits ~10s for the next window to open.
 *
 * Call this AFTER any expensive per-test setup and IMMEDIATELY BEFORE the first
 * request of a burst that asserts a 429 — anything between the two spends part
 * of the budget this reserves.
 */
export async function awaitLimiterBurstWindow(): Promise<void> {
  for (;;) {
    const offset = Date.now() % LIMITER_PERIOD_MS;
    if (offset >= BURST_LEAD_IN_MS && offset <= LIMITER_PERIOD_MS - BURST_BUDGET_MS) {
      return;
    }
    // Either too close to the boundary just crossed, or too close to the next
    // one: sleep to `BURST_LEAD_IN_MS` past the start of the usable window. The
    // loop re-checks rather than trusting the sleep to land exactly.
    await sleep(
      offset < BURST_LEAD_IN_MS
        ? BURST_LEAD_IN_MS - offset
        : LIMITER_PERIOD_MS - offset + BURST_LEAD_IN_MS,
    );
  }
}

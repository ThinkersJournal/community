/**
 * Retries `attempt` ONCE if the limiter's fixed wall-clock window
 * (`epoch = floor(now / 60000)`, Miniflare's `RateLimit` emulator) rolled over
 * while `attempt` was running — see test/search.test.ts, where a burst of
 * requests against `SEARCH_LIMITER` can straddle a minute boundary and never
 * trip the 429 it's asserting.
 *
 * ⚠️ FIX ROUND 2 (the first version only retried on a SUCCESSFUL `attempt`).
 * A roll-over mid-burst doesn't just reset the limiter's count silently — it
 * makes the burst's own "did we see a 429" assertion FAIL, which THROWS
 * before the epoch comparison ever runs. So the one failure mode this guard
 * exists for was exactly the one the original version never caught (CI run
 * 36965048036 on #137: `sawRateLimitedA` false, burst took 394ms, no retry).
 * Both the success and the failure path now check whether the epoch moved;
 * only an UNCHANGED epoch lets a failure propagate as a real failure — this
 * must never swallow a genuine bug inside one window.
 *
 * `now`, injectable (defaults to `Date.now`), so the retry/no-retry/rethrow
 * branches have a pure unit test (window-rollover-retry.node.test.ts) that
 * doesn't depend on wall-clock timing or the workers pool.
 */
export async function withWindowRolloverRetry(
  attempt: () => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  const epoch = () => Math.floor(now() / 60_000);
  const before = epoch();
  try {
    await attempt();
  } catch (err) {
    if (epoch() !== before) {
      // The window rolled over WHILE `attempt` was failing — retry once and
      // let THAT result (success, or a fresh throw) stand; a second failure
      // is a real bug, not another rollover, so it is never caught again.
      await attempt();
      return;
    }
    throw err;
  }
  if (epoch() !== before) {
    await attempt();
  }
}

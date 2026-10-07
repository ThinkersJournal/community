/**
 * The reapers' security clean-up for one account (security-alerting spec §2.6
 * N7, m-e): forget it in the ledger, leaving a 30-day tombstone. PR 2 adds the
 * device-list and pending-notice steps beside this one.
 *
 * Each call is logged and continued on failure — the same handling as the
 * anonymise reaper's post-scrub epoch bump. The backstop: the 7-day ref expiry.
 */
export async function forgetAccountEverywhere(
  env: Pick<Env, "SECURITY_LEDGER">,
  userId: string,
  source: string,
): Promise<void> {
  const steps: readonly (readonly [string, () => Promise<void>])[] = [
    ["forgetAccount", () => env.SECURITY_LEDGER.getByName("ledger").forgetAccount(userId)],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      console.error(`${source}: ${name} failed for ${userId}; the TTL backstop applies`, err);
    }
  }
}

/** At most this many accounts' clean-ups in flight at once (bounds concurrent RPCs per run). */
export const FORGET_CONCURRENCY = 50;

/**
 * Both reapers AWAIT this after their locks are released (PM ruling R2-1): every
 * id's clean-up, `FORGET_CONCURRENCY` at a time, so a run of 500 neither ends
 * before its forgets nor opens 1,500 RPCs at once. Never throws.
 */
export async function forgetAll(
  env: Parameters<typeof forgetAccountEverywhere>[0],
  ids: readonly string[],
  source: string,
): Promise<void> {
  for (let i = 0; i < ids.length; i += FORGET_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + FORGET_CONCURRENCY).map((id) => forgetAccountEverywhere(env, id, source)));
  }
}

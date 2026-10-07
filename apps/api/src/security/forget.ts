/**
 * The reapers' security clean-up for one account (security-alerting spec §2.6
 * N7, m-e): forget it in the ledger, leaving a 30-day tombstone. PR 2 adds the
 * device-list and pending-notice steps beside this one.
 *
 * Each call is logged and continued on failure. The backstop is the nightly
 * sweep (src/security/forget-sweep.ts), which finds the account itself and
 * re-forgets it; held rows have no TTL of their own.
 *
 * ⚠️ NO USER ID IN THE LOG (final review I-2). This path exists to erase the
 * account from the security system, and Workers Logs' retention is not ours to
 * scrub: a failure logs the source, the step and the error's NAME only (an
 * RPC error's message could carry anything).
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
      console.error(
        `${source}: ${name} failed; the nightly sweep (src/security/forget-sweep.ts) re-forgets it`,
        err instanceof Error ? err.name : "threw",
      );
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

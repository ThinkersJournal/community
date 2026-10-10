/**
 * The reapers' security clean-up for one account (security-alerting spec §4.5,
 * §2.6 N7, m-e): forget its browsers, end its pending notices as
 * `dropped_account_gone`, and forget it in the ledger (leaving a 30-day
 * tombstone).
 *
 * Three independent calls, each logged and continued on failure. The backstop
 * is the nightly sweep (src/security/forget-sweep.ts), which finds the account
 * itself and re-runs all three; held rows have no TTL of their own, and the
 * device alarm's 400-day pruning bounds a browser list the sweep never reaches.
 *
 * ⚠️ NO USER ID IN THE LOG (final review I-2). This path exists to erase the
 * account from the security system, and Workers Logs' retention is not ours to
 * scrub: a failure logs the source, the step and the error's NAME only (an
 * RPC error's message could carry anything).
 */
import type { SecurityLedgerDO } from "../durable-objects/SecurityLedgerDO";

/** The ledger slice the clean-up uses (the nightly sweep passes its own instance). */
export type ForgetLedger = Pick<SecurityLedgerDO, "forgetAccount">;

/**
 * Returns true when every step succeeded (the sweep counts the others). Each
 * stub is looked up inside its own step, so a failed lookup is that step's
 * failure, never the whole call's.
 */
export async function forgetAccountEverywhere(
  env: Pick<Env, "USER_SECURITY" | "SECURITY_LEDGER">,
  userId: string,
  source: string,
  ledger?: ForgetLedger,
): Promise<boolean> {
  const steps: readonly (readonly [string, () => Promise<void>])[] = [
    ["forgetDevices", () => env.USER_SECURITY.getByName(userId).forgetDevices()],
    ["dropPendingNotices", () => env.USER_SECURITY.getByName(userId).dropPendingNotices()],
    ["forgetAccount", () => (ledger ?? env.SECURITY_LEDGER.getByName("ledger")).forgetAccount(userId)],
  ];
  let ok = true;
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      ok = false;
      logForgetFailure(source, name, err);
    }
  }
  return ok;
}

/** A clean-up that failed: the source, the step and the error's NAME only (I-2: never the account id). */
function logForgetFailure(source: string, step: string, err: unknown): void {
  console.error(
    `${source}: ${step} failed; the nightly sweep (src/security/forget-sweep.ts) re-forgets it`,
    err instanceof Error ? err.name : "threw",
  );
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
    try {
      await Promise.all(ids.slice(i, i + FORGET_CONCURRENCY).map((id) => forgetAccountEverywhere(env, id, source)));
    } catch (err) {
      // Unreachable while forgetAccountEverywhere keeps its own catch; logged, never
      // thrown, so a reaper's run still ends normally ("Never throws" above).
      logForgetFailure(source, "forgetAll", err);
    }
  }
}

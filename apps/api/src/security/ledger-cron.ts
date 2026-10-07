/**
 * The cron's one ledger call (security-alerting spec §2.6 m-d): if the ledger's
 * alarm stopped, the next two-minute tick sets one. Idempotent; never throws,
 * so it can ride `ctx.waitUntil` beside the tick's real work.
 */
export async function ensureLedgerAlarm(env: Pick<Env, "SECURITY_LEDGER">): Promise<void> {
  try {
    await env.SECURITY_LEDGER.getByName("ledger").ensureAlarm();
  } catch (err) {
    console.error("security-ledger: ensureAlarm failed", err instanceof Error ? err.name : "threw");
  }
}

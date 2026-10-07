/**
 * The nightly N7 sweep (security-alerting spec §2.6 N7, m-e; PM ruling R2-1).
 *
 * A reaper's forget can be lost: the Durable Object call fails (logged once),
 * or the invocation ends after the Postgres commit. Neither reaper selects that
 * account again: an anonymised row no longer matches its candidate query, and an
 * unverified one is deleted. So this sweep re-forgets, every night from the
 * existing `30 3 * * *` cron:
 *
 *   1. every account ANONYMISED in the last 3 days (refreshing its tombstone,
 *      so a report that waited out an outage cannot re-create its rows); and
 *   2. every account id the ledger still holds (held rows, refs) whose user is
 *      anonymised or DELETED — a deleted row leaves nothing to query, so the
 *      ledger's own ids are reconciled against Postgres instead.
 *
 * Idempotent (`forgetAccount` only deletes and refreshes a tombstone), bounded
 * per run (SWEEP_BATCH ids each; the ledger's page cursor wraps), never throws,
 * and logs each run's counts.
 */
import { withClient } from "../db/client";
import type { SecurityLedgerDO } from "../durable-objects/SecurityLedgerDO";

export const SWEEP_BATCH = 200;
export const SWEEP_RECENT_DAYS = 3;

/** The ledger slice the sweep uses: the two RPCs, as `SecurityLedgerDO` declares them. */
export type ForgetSweepLedger = Pick<SecurityLedgerDO, "accountIdsPage" | "forgetAccount">;

export interface SweepCounts {
  readonly recentAnonymised: number;
  readonly ledgerChecked: number;
  readonly ledgerForgotten: number;
  readonly failed: number;
}

/** Forgets in flight at once: bounds the run's concurrent RPCs (and its length). */
export const SWEEP_CONCURRENCY = 50;

async function forgetEach(ledger: ForgetSweepLedger, ids: readonly string[]): Promise<number> {
  let failed = 0;
  for (let i = 0; i < ids.length; i += SWEEP_CONCURRENCY) {
    const results = await Promise.allSettled(ids.slice(i, i + SWEEP_CONCURRENCY).map((id) => ledger.forgetAccount(id)));
    failed += results.filter((r) => r.status === "rejected").length;
  }
  return failed;
}

/** The given ids that still belong to a live (not anonymised, not deleted) account. */
async function liveIds(env: Pick<Env, "HYPERDRIVE_FRESH">, ctx: ExecutionContext, ids: readonly string[]) {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE id::text = ANY($1::text[]) AND anonymised_at IS NULL",
      [ids],
    );
    return new Set(rows.map((r) => r.id));
  });
}

export async function sweepForgottenAccounts(
  env: Pick<Env, "HYPERDRIVE_FRESH" | "SECURITY_LEDGER">,
  ctx: ExecutionContext,
  ledger: ForgetSweepLedger = env.SECURITY_LEDGER.getByName("ledger"),
): Promise<SweepCounts | null> {
  try {
    const recent = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE anonymised_at > now() - make_interval(days => $1)
          ORDER BY anonymised_at DESC LIMIT $2`,
        [SWEEP_RECENT_DAYS, SWEEP_BATCH],
      );
      return rows.map((r) => r.id);
    });
    let failed = await forgetEach(ledger, recent);
    const page = await ledger.accountIdsPage(SWEEP_BATCH);
    const live = page.length === 0 ? new Set<string>() : await liveIds(env, ctx, page);
    const gone = page.filter((id) => !live.has(id));
    failed += await forgetEach(ledger, gone);
    const counts = { recentAnonymised: recent.length, ledgerChecked: page.length, ledgerForgotten: gone.length, failed };
    console.log("security-forget-sweep", counts);
    return counts;
  } catch (err) {
    console.error("security-forget-sweep: run failed", err instanceof Error ? err.name : "threw");
    return null;
  }
}

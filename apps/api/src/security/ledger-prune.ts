/**
 * The ledger's prune step (security-alerting spec §2.6 step 7, F3): delete
 * aged-out covered `held` rows, expired cooldowns and refs, and old day rows, in
 * chunks of 1,000, until nothing is left or the run's budget is spent.
 *
 * ⚠️ PLAN RULING P-4: THE BUDGET IS COUNTED IN CHUNKS, NOT MILLISECONDS. The spec
 * says "2 s", but workerd's clock does not advance during synchronous SQL (it
 * moves only on I/O; apps/api/test/helpers/limiter-window.ts's header), so a
 * `Date.now()` budget inside one transaction would never expire.
 * `PRUNE_CHUNKS_PER_RUN` chunks bound the work per alarm the same way; the caller
 * re-arms for NOW when work remains.
 */
import { deleteHeld, HELD_CLASSES } from "./ledger-held";
import { REF_TTL_MS, utcDay, type LedgerStore } from "./ledger-store";

export const PRUNE_CHUNK = 1_000;
export const PRUNE_CHUNKS_PER_RUN = 5;
/** A covered held row stays on the admin page this long after its last update (§2.6). */
export const COVERED_TTL_MS = 7 * 86_400_000;

/** One chunk of one prune target; returns how many rows it deleted. */
type PruneTarget = () => number;

function sqlTarget(store: LedgerStore, sql: string, ...bindings: (string | number)[]): PruneTarget {
  return () => store.sql.exec(sql, ...bindings).toArray().length;
}

function targets(store: LedgerStore, nowMs: number): PruneTarget[] {
  const yesterday = utcDay(nowMs - 86_400_000);
  const held = HELD_CLASSES.map(
    (c): PruneTarget =>
      () =>
        deleteHeld(
          store,
          `(signal_class, subject_key) IN (
             SELECT signal_class, subject_key FROM held
             WHERE signal_class = ? AND version <= ? AND updated_ms < ? LIMIT ${PRUNE_CHUNK})`,
          c,
          store.watermark(c),
          nowMs - COVERED_TTL_MS,
        ),
  );
  return [
    ...held,
    sqlTarget(
      store,
      `DELETE FROM cooldowns WHERE (signal, subject) IN (
         SELECT signal, subject FROM cooldowns WHERE until_ms <= ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs,
    ),
    sqlTarget(
      store,
      `DELETE FROM account_refs WHERE user_id IN (
         SELECT user_id FROM account_refs WHERE last_used_ms < ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs - REF_TTL_MS,
    ),
    sqlTarget(
      store,
      `DELETE FROM forgotten WHERE user_id IN (
         SELECT user_id FROM forgotten WHERE until_ms <= ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs,
    ),
    sqlTarget(
      store,
      `DELETE FROM outbox_poison WHERE id IN (
         SELECT id FROM outbox_poison WHERE poisoned_ms < ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs - COVERED_TTL_MS,
    ),
    sqlTarget(store, "DELETE FROM meta WHERE k LIKE 'notice_dropped:%' AND substr(k, -10) < ? RETURNING 1", yesterday),
    sqlTarget(store, "DELETE FROM class_day WHERE day < ? RETURNING 1", yesterday),
    sqlTarget(store, "DELETE FROM held_overflow WHERE day < ? RETURNING 1", yesterday),
  ];
}

/**
 * Returns true when work may remain (the caller re-arms for NOW).
 *
 * ⚠️ HARD BOUND (audit I-1): the budget is checked BEFORE EVERY chunk, with
 * `<= 0`, so one call runs at most PRUNE_CHUNKS_PER_RUN chunks that delete
 * anything, whatever the targets' sizes or the order their chunks come back
 * short in. A chunk that deletes nothing costs no budget; a target is done when
 * a chunk comes back short.
 */
export function pruneLedger(store: LedgerStore, nowMs: number): boolean {
  let budget = PRUNE_CHUNKS_PER_RUN;
  for (const chunk of targets(store, nowMs)) {
    for (;;) {
      if (budget <= 0) return true;
      const deleted = chunk();
      if (deleted > 0) budget -= 1;
      if (deleted < PRUNE_CHUNK) break;
    }
  }
  return false;
}

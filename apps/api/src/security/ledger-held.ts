/**
 * Held subjects: one row each, versioned, capped, reported in bounded pages
 * (security-alerting spec §2.6, R1/F2/F3). Synchronous; callers run these inside
 * `transactionSync`.
 */
import {
  HELD_PAGE_SIZE,
  HELD_PRIORITY,
  HELD_ROW_CAP,
  HeldReportBuilder,
  SIGNAL_RULES,
  type CounterReport,
  type SecurityAlertSignal,
  type SecurityAlertSubject,
  type SecurityHeldReport,
  type SignalClass,
  type SubjectKind,
} from "@thinkersjournal/shared";

import { utcDay, type LedgerStore } from "./ledger-store";

type HeldRow = {
  signal_class: string;
  subject_key: string;
  signal: string;
  subject_kind: string;
  subject: string;
  events: number;
  suppressed: number;
  version: number;
};

/** One named row a held report covers: its class, key and the version it was named at. */
export type CoveredRow = readonly [SignalClass, string, number];

export interface HeldCovers {
  readonly s: number;
  readonly rows: readonly CoveredRow[];
}

const CLASS_OF: ReadonlyMap<string, SignalClass> = new Map(SIGNAL_RULES.map((r) => [r.signal, r.signalClass]));

/** How a raw subject appears in a message: a ref for an account, never a user id (§3.2 I7). */
export function renderSubject(
  store: LedgerStore,
  kind: SubjectKind | string,
  subject: string,
  nowMs: number,
): SecurityAlertSubject {
  if (kind === "account") return { kind: "account", ref: store.refFor(subject, nowMs) };
  if (kind === "site") return { kind: "site" };
  return subject === "none" ? { kind: "no_ip" } : { kind: "ip_prefix", value: subject };
}

/** Stored rows per class, kept exact by `deleteHeld` and the insert below (no per-insert COUNT scan). */
export function heldStored(store: LedgerStore, signalClass: SignalClass): number {
  return store.metaNumber(`held_n:${signalClass}`);
}

/**
 * THE ONE WAY a held row is deleted, so each class's stored count stays exact.
 * `where` is a fixed SQL fragment from this module or the ledger, never input.
 */
export function deleteHeld(store: LedgerStore, where: string, ...bindings: (string | number)[]): number {
  const gone = store.sql.exec<{ signal_class: string }>(`DELETE FROM held WHERE ${where} RETURNING signal_class`, ...bindings).toArray();
  const byClass = new Map<string, number>();
  for (const r of gone) byClass.set(r.signal_class, (byClass.get(r.signal_class) ?? 0) + 1);
  for (const [c, n] of byClass) store.addMeta(`held_n:${c}`, -n);
  return gone.length;
}

/**
 * A suppressed crossing: update its row in place, or insert it if the class has
 * room, or evict the class's oldest COVERED row, or — every row still open —
 * count it in `held_overflow` (F3). Returns true when this was the class's first
 * counted subject today, so the caller queues `held_capped`.
 */
export function upsertHeld(store: LedgerStore, r: CounterReport, nowMs: number): boolean {
  const key = `${r.signal}|${r.subject}`;
  const updated = store.sql.exec(
    `UPDATE held SET events = events + ?, suppressed = suppressed + 1, version = ?, updated_ms = ?
     WHERE signal_class = ? AND subject_key = ?`,
    r.events,
    store.nextVersion(),
    nowMs,
    r.signalClass,
    key,
  ).rowsWritten;
  if (updated > 0) return false;
  if (!hasRoom(store, r.signalClass)) return countOverflow(store, r.signalClass, nowMs);
  store.sql.exec(
    `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    r.signalClass,
    key,
    r.signal,
    r.subjectKind,
    r.subject,
    r.events,
    store.nextVersion(),
    nowMs,
  );
  store.addMeta(`held_n:${r.signalClass}`, 1);
  return false;
}

/** Room for one more row, evicting the oldest covered row (lowest version ≤ W) if the class is full. */
function hasRoom(store: LedgerStore, signalClass: SignalClass): boolean {
  if (heldStored(store, signalClass) < HELD_ROW_CAP[signalClass]) return true;
  const evicted = deleteHeld(
    store,
    `(signal_class, subject_key) IN (
       SELECT signal_class, subject_key FROM held WHERE signal_class = ? AND version <= ? ORDER BY version LIMIT 1)`,
    signalClass,
    store.watermark(signalClass),
  );
  return evicted > 0;
}

/** Count, not store. True on the class's first such count today. */
export function countOverflow(store: LedgerStore, signalClass: SignalClass, nowMs: number, by = 1): boolean {
  const day = utcDay(nowMs);
  const before = countedToday(store, signalClass, day);
  store.sql.exec(
    `INSERT INTO held_overflow (signal_class, day, counted) VALUES (?, ?, ?)
     ON CONFLICT(signal_class, day) DO UPDATE SET counted = counted + excluded.counted`,
    signalClass,
    day,
    by,
  );
  return before === 0;
}

export function countedToday(store: LedgerStore, signalClass: SignalClass, day: string): number {
  return store.count(
    "SELECT COALESCE(SUM(counted), 0) AS n FROM held_overflow WHERE signal_class = ? AND day = ?",
    signalClass,
    day,
  );
}

/**
 * Counted-not-stored over every UTC day from `fromMs` to `toMs` (batch-2 review
 * m-3). A count made after the day's last message, before 00:00, is carried into
 * the first report after midnight instead of falling between two days.
 */
export function countedSince(store: LedgerStore, signalClass: SignalClass, fromMs: number, toMs: number): number {
  return store.count(
    "SELECT COALESCE(SUM(counted), 0) AS n FROM held_overflow WHERE signal_class = ? AND day >= ? AND day <= ?",
    signalClass,
    utcDay(fromMs),
    utcDay(toMs),
  );
}

export function openCount(store: LedgerStore, signalClass: SignalClass): number {
  return store.count(
    "SELECT COUNT(*) AS n FROM held WHERE signal_class = ? AND version > ?",
    signalClass,
    store.watermark(signalClass),
  );
}

/** Every class that can hold rows, in no particular order. */
export const HELD_CLASSES: readonly SignalClass[] = (Object.keys(HELD_ROW_CAP) as SignalClass[]).filter(
  (c) => HELD_ROW_CAP[c] > 0,
);

/** One page of a signal's open rows: uncapped events, most first; keyset on (events, key). */
function openPage(store: LedgerStore, signal: SecurityAlertSignal, after: HeldRow | null): HeldRow[] {
  const signalClass = CLASS_OF.get(signal);
  if (signalClass === undefined) return [];
  return store.sql
    .exec<HeldRow>(
      `SELECT signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version FROM held
       WHERE signal_class = ? AND signal = ? AND version > ?
         AND (? IS NULL OR events < ? OR (events = ? AND subject_key > ?))
       ORDER BY events DESC, subject_key ASC LIMIT ?`,
      signalClass,
      signal,
      store.watermark(signalClass),
      after === null ? null : 1,
      after?.events ?? 0,
      after?.events ?? 0,
      after?.subject_key ?? "",
      HELD_PAGE_SIZE,
    )
    .toArray();
}

/**
 * Build the held-subject report at sequence value S (R1). Pages `held` in
 * `HELD_PRIORITY` order, 200 rows a query, until the 64 KB byte cap; everything
 * after the first refusal is counted in `more`. Returns null when nothing is open.
 */
export function buildHeldReport(
  store: LedgerStore,
  period: { readonly startMs: number; readonly endMs: number },
  adminUrl: string | null,
): { readonly report: SecurityHeldReport; readonly covers: HeldCovers } | null {
  const s = store.currentVersion();
  const open = new Map(HELD_CLASSES.map((c) => [c, openCount(store, c)] as const));
  if ([...open.values()].every((n) => n === 0)) return null;
  const builder = new HeldReportBuilder();
  const rows: CoveredRow[] = [];
  const named = new Map<SignalClass, number>();
  pageAll(store, period.endMs, builder, rows, named);
  return {
    report: {
      type: "held_report",
      periodStart: new Date(period.startMs).toISOString(),
      periodEnd: new Date(period.endMs).toISOString(),
      entries: builder.entries,
      more: HELD_CLASSES.map((c) => ({ signalClass: c, count: (open.get(c) ?? 0) - (named.get(c) ?? 0) })).filter(
        (m) => m.count > 0,
      ),
      adminUrl,
      countedNotStored: HELD_CLASSES.map((c) => ({ signalClass: c, count: countedSince(store, c, period.startMs, period.endMs) })).filter(
        (m) => m.count > 0,
      ),
    },
    covers: { s, rows },
  };
}

function pageAll(
  store: LedgerStore,
  nowMs: number,
  builder: HeldReportBuilder,
  rows: CoveredRow[],
  named: Map<SignalClass, number>,
): void {
  for (const signal of HELD_PRIORITY) {
    let after: HeldRow | null = null;
    for (;;) {
      const page = openPage(store, signal, after);
      for (const row of page) {
        const signalClass = row.signal_class as SignalClass;
        const entry = {
          signal: row.signal as SecurityAlertSignal,
          subject: renderSubject(store, row.subject_kind, row.subject, nowMs),
          events: row.events,
          suppressed: row.suppressed,
        };
        if (!builder.tryAdd(entry)) return;
        rows.push([signalClass, row.subject_key, row.version]);
        named.set(signalClass, (named.get(signalClass) ?? 0) + 1);
      }
      const last = page.at(-1);
      if (last === undefined || page.length < HELD_PAGE_SIZE) break;
      after = last;
    }
  }
}

/** Durable Object SQLite's limit on bound parameters in one statement. */
export const DO_SQL_MAX_PARAMS = 100;
/** Parameters `applyCoverage` binds per named row: (signal_class, subject_key, version). */
const COVER_PARAMS_PER_KEY = 3;

/**
 * Keys per DELETE statement on delivery (§2.6 F2: "in statements of at most 100 keys").
 *
 * ⚠️ DERIVED, NEVER 100: each key binds `COVER_PARAMS_PER_KEY` parameters
 * (class, key, version), and Durable Object SQLite refuses a statement with
 * more than `DO_SQL_MAX_PARAMS` bound parameters ("too many SQL variables").
 * At 100 keys the delete threw after the sink had accepted the report, so the
 * report was kept and re-sent by every alarm (test/security-ledger-do.test.ts,
 * "coverage of a large held report"). Adding a column to the WHERE below means
 * changing `COVER_PARAMS_PER_KEY` with it.
 */
export const COVER_DELETE_CHUNK = Math.floor(DO_SQL_MAX_PARAMS / COVER_PARAMS_PER_KEY);

/**
 * A held report was DELIVERED: delete each named row only if its version is at
 * or below the version the report named, then raise every class's watermark to S.
 */
export function applyCoverage(store: LedgerStore, covers: HeldCovers): void {
  for (let i = 0; i < covers.rows.length; i += COVER_DELETE_CHUNK) {
    const chunk = covers.rows.slice(i, i + COVER_DELETE_CHUNK);
    const where = chunk.map(() => "(signal_class = ? AND subject_key = ? AND version <= ?)").join(" OR ");
    deleteHeld(store, where, ...chunk.flat());
  }
  for (const c of HELD_CLASSES) store.raiseWatermark(c, covers.s);
}

/**
 * Forget (§2.6 N7; batch-2 review m-2): strip an account's rows from every
 * pending held report's `covers`, the one place a raw user id waits in the
 * outbox. Covers that do not parse are dropped (they could never be applied).
 * Bounded: only held reports carry covers, at most one queued per hour.
 */
export function forgetCovers(store: LedgerStore, userId: string): void {
  const pending = store.sql
    .exec<{ id: number; covers: string }>("SELECT id, covers FROM outbox WHERE covers IS NOT NULL")
    .toArray();
  for (const row of pending) {
    let covers: HeldCovers;
    try {
      covers = JSON.parse(row.covers) as HeldCovers;
    } catch {
      store.sql.exec("UPDATE outbox SET covers = NULL WHERE id = ?", row.id);
      continue;
    }
    const kept = covers.rows.filter(([, key]) => key.slice(key.indexOf("|") + 1) !== userId);
    if (kept.length === covers.rows.length) continue;
    store.sql.exec("UPDATE outbox SET covers = ? WHERE id = ?", JSON.stringify({ s: covers.s, rows: kept }), row.id);
  }
}

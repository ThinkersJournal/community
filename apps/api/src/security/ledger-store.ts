/**
 * Typed access to `SecurityLedgerDO`'s SQLite tables (security-alerting spec
 * §2.6). Every method is synchronous, so callers can compose them inside one
 * `transactionSync`. No method makes an RPC or awaits anything.
 */
import type { SecurityAlertMessage, SignalClass } from "@thinkersjournal/shared";

const DAY_MS = 86_400_000;
/** An account ref is forgotten this long after the last message that named it (§2.6). */
export const REF_TTL_MS = 7 * DAY_MS;

type MetaRow = { v: string };
type ClassDayRow = { sent: number; onset_signals: string; exhausted_queued: number; suppressed: number };
type UntilRow = { until_ms: number };
type RefRow = { ref: string };
type CountRow = { n: number };

export interface ClassDay {
  readonly sent: number;
  readonly onsetSignals: readonly string[];
  readonly exhaustedQueued: boolean;
  readonly suppressed: number;
}

export type PeriodField = "sent" | "by_cooldown" | "by_budget";

/**
 * Every catch in the ledger logs at least WHY (final review M-2): the error's
 * name only, never its message, which could carry a subject or a user id.
 */
export function logLedgerError(where: string, err: unknown): void {
  console.error(`security-ledger: ${where} threw`, err instanceof Error ? err.name : "threw");
}

/** `YYYY-MM-DD`, UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 32 lowercase hex characters from 16 CSPRNG bytes: the opaque account ref (§2.6). */
export function newRef(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `T` or `null`, named once (a shared-package type in a bare `| null` union reads as `any` to an analyser that cannot resolve the workspace). */
export type Nullable<T> = T | null;

export class LedgerStore {
  readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  meta(k: string): string | null {
    return this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  metaNumber(k: string): number {
    return Number(this.meta(k) ?? "0");
  }

  addMeta(k: string, by: number): number {
    const next = this.metaNumber(k) + by;
    this.setMeta(k, String(next));
    return next;
  }

  /** The ledger's one monotonic sequence (F2). Versions come from here, never from a clock. */
  nextVersion(): number {
    return this.addMeta("seq", 1);
  }

  currentVersion(): number {
    return this.metaNumber("seq");
  }

  /** The class's coverage watermark `W`: rows with `version` ≤ W are covered. */
  watermark(signalClass: SignalClass): number {
    return this.metaNumber(`w:${signalClass}`);
  }

  /** `W = max(W, S)`: never moves back, even if an older report is delivered after a newer one (m1). */
  raiseWatermark(signalClass: SignalClass, s: number): void {
    if (s > this.watermark(signalClass)) this.setMeta(`w:${signalClass}`, String(s));
  }

  classDay(signalClass: SignalClass, day: string): ClassDay {
    const row = this.sql
      .exec<ClassDayRow>(
        "SELECT sent, onset_signals, exhausted_queued, suppressed FROM class_day WHERE class = ? AND day = ?",
        signalClass,
        day,
      )
      .toArray()
      .at(0);
    if (row === undefined) return { sent: 0, onsetSignals: [], exhaustedQueued: false, suppressed: 0 };
    return {
      sent: row.sent,
      onsetSignals: JSON.parse(row.onset_signals) as string[],
      exhaustedQueued: row.exhausted_queued === 1,
      suppressed: row.suppressed,
    };
  }

  saveClassDay(signalClass: SignalClass, day: string, d: ClassDay): void {
    this.sql.exec(
      `INSERT INTO class_day (class, day, sent, onset_signals, exhausted_queued, suppressed) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(class, day) DO UPDATE SET sent = excluded.sent, onset_signals = excluded.onset_signals,
         exhausted_queued = excluded.exhausted_queued, suppressed = excluded.suppressed`,
      signalClass,
      day,
      d.sent,
      JSON.stringify(d.onsetSignals),
      d.exhaustedQueued ? 1 : 0,
      d.suppressed,
    );
  }

  cooldownUntil(signal: string, subject: string): number | null {
    return (
      this.sql.exec<UntilRow>("SELECT until_ms FROM cooldowns WHERE signal = ? AND subject = ?", signal, subject).toArray()[0]
        ?.until_ms ?? null
    );
  }

  setCooldown(signal: string, subject: string, untilMs: number): void {
    this.sql.exec(
      `INSERT INTO cooldowns (signal, subject, until_ms) VALUES (?, ?, ?)
       ON CONFLICT(signal, subject) DO UPDATE SET until_ms = excluded.until_ms`,
      signal,
      subject,
      untilMs,
    );
  }

  addPeriod(signalClass: SignalClass, field: PeriodField): void {
    this.sql.exec(
      `INSERT INTO class_period (class, sent, by_cooldown, by_budget) VALUES (?, 0, 0, 0)
       ON CONFLICT(class) DO NOTHING`,
      signalClass,
    );
    this.sql.exec(`UPDATE class_period SET ${field} = ${field} + 1 WHERE class = ?`, signalClass);
  }

  period(signalClass: SignalClass): Record<PeriodField, number> {
    const row = this.sql
      .exec<Record<PeriodField, number>>("SELECT sent, by_cooldown, by_budget FROM class_period WHERE class = ?", signalClass)
      .toArray()
      .at(0);
    return row ?? { sent: 0, by_cooldown: 0, by_budget: 0 };
  }

  resetPeriod(): void {
    this.sql.exec("DELETE FROM class_period");
  }

  /** The account's ref: reused while it keeps appearing, refreshed on every use (§2.6). */
  refFor(userId: string, nowMs: number): string {
    const found = this.sql.exec<RefRow>("SELECT ref FROM account_refs WHERE user_id = ?", userId).toArray().at(0);
    const ref = found?.ref ?? newRef();
    this.sql.exec(
      `INSERT INTO account_refs (user_id, ref, last_used_ms) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_used_ms = excluded.last_used_ms`,
      userId,
      ref,
      nowMs,
    );
    return ref;
  }

  /** Queue one message for the alarm's delivery step. `covers` is set on held reports only. */
  queue(message: SecurityAlertMessage, nowMs: number, covers: string | null = null): void {
    this.sql.exec(
      "INSERT INTO outbox (message, covers, attempts, next_ms) VALUES (?, ?, 0, ?)",
      JSON.stringify(message),
      covers,
      nowMs,
    );
  }

  count(sqlText: string, ...bindings: (string | number)[]): number {
    return this.sql.exec<CountRow>(sqlText, ...bindings).one().n;
  }
}

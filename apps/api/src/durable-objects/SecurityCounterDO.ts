/**
 * `SecurityCounterDO` — counts security events (security-alerting spec §2.4).
 *
 * A FIXED set of 33 instances (`ip:0`…`ip:15`, `acct:0`…`acct:15`, `site`;
 * `shardFor` in packages/shared), so rotating /64s adds rows, never instances.
 * It receives batches from the per-isolate `SecurityEventBuffer`, evaluates the
 * rules in `SIGNAL_RULES`, and reports crossings to the one `SecurityLedgerDO`.
 *
 * ⚠️ NEVER CALLS A SINK. A counter's only outlet is `ledger.report()`; if the
 * ledger is unreachable it keeps the report, backs off, and logs
 * `security: alerting_fault` (§2.4, N3). The raw address of a distinct member
 * never reaches storage: members are salted SHA-256, truncated (§2.4 step 2).
 */
import { DurableObject } from "cloudflare:workers";

import {
  CLASS_POLICY,
  logSecurityEvent,
  SIGNAL_RULES,
  type CounterBatch,
  type CounterReport,
  type CounterRow,
  type SecurityAlertSignal,
  type SecurityLedgerReportRpc,
  type SignalActivity,
  type SignalClass,
  type SignalRule,
  type SiteSummary,
} from "@thinkersjournal/shared";

import { COUNTER_SCHEMA } from "../security/counter-schema";

const MINUTE_MS = 60_000;
/** `buckets`, `members` and `last_report` live at most this long (§2.4 Retention). */
export const COUNTER_RETENTION_MINUTES = 60;
/** `overflow` (site only) lives at most this long. */
export const OVERFLOW_RETENTION_MINUTES = 120;
/** Past this many pending reports, a new subject's report is only counted (§2.4 m4). */
export const MAX_PENDING_REPORTS = 10_000;
/** Reports per `ledger.report()` call (§2.4 alarm step 1). */
export const REPORTS_PER_CALL = 500;
/** With nothing to report, the alarm still runs this often, to prune. */
export const IDLE_ALARM_MS = 10 * MINUTE_MS;
/** `credential_stuffing` stores members only from its subject's 3rd event in the window (§2.4 step 2). */
const STUFFING_MEMBER_SKIP = 2;

const RULES: ReadonlyMap<SecurityAlertSignal, SignalRule> = new Map(SIGNAL_RULES.map((r) => [r.signal, r]));

/** Backoff after the n-th failed report (§2.4 alarm step 2): 1, 5, then every 15 minutes, forever. */
export function reportRetryDelayMs(attempts: number): number {
  if (attempts <= 1) return MINUTE_MS;
  if (attempts === 2) return 5 * MINUTE_MS;
  return 15 * MINUTE_MS;
}

/** A batch row whose members are already salted and hashed. */
interface HashedRow extends Omit<CounterRow, "members"> {
  readonly memberHashes: readonly string[];
}

type CountsRow = { counts: string };
type MinuteCountsRow = { minute: number; route: string; counts: string };
type CountRow = { n: number };
type ReportRow = { id: number; report: string; attempts: number };
type MetaRow = { v: string };

async function memberHash(salt: string, member: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}${member}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function hashRows(rows: readonly CounterRow[], salt: string): Promise<HashedRow[]> {
  return Promise.all(
    rows.map(async ({ members, ...rest }) => ({
      ...rest,
      memberHashes: await Promise.all(members.map((m) => memberHash(salt, m))),
    })),
  );
}

function parseCounts(text: string): Record<string, number> {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
}

export class SecurityCounterDO extends DurableObject<Env> {
  /** TEST SEAM (§3.3): tests replace this on the instance via `runInDurableObject`. */
  ledgerFor: () => SecurityLedgerReportRpc = () => this.env.SECURITY_LEDGER.getByName("ledger");
  /** TEST SEAM: where the next alarm goes, so a real alarm never races a test's explicit clock. */
  armAt: (ms: number) => Promise<void> = (ms) => this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private ensureSchema(): void {
    for (const ddl of COUNTER_SCHEMA) this.sql.exec(ddl);
  }

  /** RPC (§2.4): one batch from one isolate's flush. */
  async record(batch: CounterBatch): Promise<void> {
    await this.recordAt(batch, Date.now());
  }

  /** `record` with an explicit clock, so tests never sleep (§2.4 Clock). */
  async recordAt(batch: CounterBatch, nowMs: number): Promise<void> {
    // Hashing is async, so it runs BEFORE the transaction, which must stay synchronous.
    const hashed = await hashRows(batch.rows, this.salt());
    const gained = this.ctx.storage.transactionSync(() => this.apply(hashed, batch.overflowEvents, nowMs));
    if (gained) {
      await this.armAt(nowMs);
    } else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.armAt(nowMs + IDLE_ALARM_MS);
    }
  }

  /** The per-instance member salt: 32 random bytes, created on first use, gone with `deleteAll`. */
  private salt(): string {
    const existing = this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = 'salt'").toArray()[0];
    if (existing !== undefined) return existing.v;
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('salt', ?) ON CONFLICT(k) DO NOTHING", fresh);
    return this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = 'salt'").one().v;
  }

  /** Steps 1–4 of `record`, inside `transactionSync`. True when `reports` gained a row. */
  private apply(rows: readonly HashedRow[], overflowEvents: number, nowMs: number): boolean {
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    const touched = new Map<string, HashedRow>();
    for (const row of rows) {
      const rule = RULES.get(row.signal);
      if (rule === undefined) continue;
      const before = this.eventsInWindow(row.signal, row.subject, nowMinute - rule.windowMinutes).events;
      this.addBucket(row);
      this.addMembers(row, rule, before, nowMinute);
      touched.set(`${row.signal}|${row.subject}`, row);
    }
    if (overflowEvents > 0) {
      this.sql.exec(
        "INSERT INTO overflow (minute, n) VALUES (?, ?) ON CONFLICT(minute) DO UPDATE SET n = n + excluded.n",
        nowMinute,
        overflowEvents,
      );
    }
    let gained = false;
    for (const row of touched.values()) {
      if (this.evaluate(row.signal, row.subject, nowMs)) gained = true;
    }
    return gained;
  }

  /** Step 1: one `buckets` row per (subject, minute, route), its JSON counts summed. */
  private addBucket(row: HashedRow): void {
    const found = this.sql
      .exec<CountsRow>("SELECT counts FROM buckets WHERE subject = ? AND minute = ? AND route = ?", row.subject, row.minute, row.route)
      .toArray()[0];
    const counts = found === undefined ? {} : parseCounts(found.counts);
    counts[row.signal] = (counts[row.signal] ?? 0) + row.n;
    this.sql.exec(
      `INSERT INTO buckets (subject, minute, route, counts) VALUES (?, ?, ?, ?)
       ON CONFLICT(subject, minute, route) DO UPDATE SET counts = excluded.counts`,
      row.subject,
      row.minute,
      row.route,
      JSON.stringify(counts),
    );
  }

  /** Step 2: distinct members, with both cost guards (3rd-event start; 2 × threshold per window). */
  private addMembers(row: HashedRow, rule: SignalRule, eventsBefore: number, nowMinute: number): void {
    if (row.memberHashes.length === 0) return;
    const skip = row.signal === "credential_stuffing" ? Math.max(0, STUFFING_MEMBER_SKIP - eventsBefore) : 0;
    const room = 2 * rule.threshold - this.distinctMembers(row.signal, row.subject, nowMinute - rule.windowMinutes, nowMinute);
    for (const member of row.memberHashes.slice(skip, skip + Math.max(0, room))) {
      this.sql.exec(
        "INSERT INTO members (signal, subject, minute, member) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        row.signal,
        row.subject,
        row.minute,
        member,
      );
    }
  }

  /** Events and by-route counts for one (signal, subject) with `minute > sinceMinute`. */
  private eventsInWindow(
    signal: SecurityAlertSignal,
    subject: string,
    sinceMinute: number,
    untilMinute = Number.MAX_SAFE_INTEGER,
  ): { events: number; byRoute: Record<string, number> } {
    const byRoute: Record<string, number> = {};
    let events = 0;
    const rows = this.sql.exec<MinuteCountsRow>(
      "SELECT minute, route, counts FROM buckets WHERE subject = ? AND minute > ? AND minute <= ?",
      subject,
      sinceMinute,
      untilMinute,
    );
    for (const r of rows) {
      const n = parseCounts(r.counts)[signal] ?? 0;
      if (n === 0) continue;
      events += n;
      byRoute[r.route] = (byRoute[r.route] ?? 0) + n;
    }
    return { events, byRoute };
  }

  private distinctMembers(signal: SecurityAlertSignal, subject: string, sinceMinute: number, untilMinute: number): number {
    return this.sql
      .exec<CountRow>(
        "SELECT COUNT(DISTINCT member) AS n FROM members WHERE signal = ? AND subject = ? AND minute > ? AND minute <= ?",
        signal,
        subject,
        sinceMinute,
        untilMinute,
      )
      .one().n;
  }

  /** Steps 3–4: over threshold and not reported within the window → queue a report. */
  private evaluate(signal: SecurityAlertSignal, subject: string, nowMs: number): boolean {
    const rule = RULES.get(signal);
    if (rule === undefined) return false;
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    const sinceMinute = nowMinute - rule.windowMinutes;
    const { events, byRoute } = this.eventsInWindow(signal, subject, sinceMinute);
    const observed = rule.measure === "events" ? events : this.distinctMembers(signal, subject, sinceMinute, nowMinute);
    if (observed < rule.threshold) return false;
    const windowMs = rule.windowMinutes * MINUTE_MS;
    const last = this.sql
      .exec<{ at_ms: number }>("SELECT at_ms FROM last_report WHERE signal = ? AND subject = ?", signal, subject)
      .toArray()[0];
    if (last !== undefined && last.at_ms > nowMs - windowMs) return false;
    this.sql.exec(
      `INSERT INTO last_report (signal, subject, at_ms) VALUES (?, ?, ?)
       ON CONFLICT(signal, subject) DO UPDATE SET at_ms = excluded.at_ms`,
      signal,
      subject,
      nowMs,
    );
    return this.queueReport(
      {
        signal,
        signalClass: rule.signalClass,
        subjectKind: rule.subject,
        subject,
        windowStartMs: (sinceMinute + 1) * MINUTE_MS,
        windowEndMs: nowMs,
        observed,
        events,
        threshold: rule.threshold,
        severity: rule.severity,
        byRoute,
      },
      nowMs,
    );
  }

  /** Merge into a pending report for the same (signal, subject), count past the cap, or insert. */
  private queueReport(report: CounterReport, nowMs: number): boolean {
    const rkey = `${report.signal}|${report.subject}`;
    const pending = this.sql.exec<ReportRow>("SELECT id, report, attempts FROM reports WHERE rkey = ?", rkey).toArray()[0];
    if (pending !== undefined) {
      const merged = mergeReports(JSON.parse(pending.report) as CounterReport, report);
      this.sql.exec("UPDATE reports SET report = ? WHERE id = ?", JSON.stringify(merged), pending.id);
      return false;
    }
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM reports").one().n >= MAX_PENDING_REPORTS) {
      this.addReportsOverflow(report.signalClass);
      return false;
    }
    this.sql.exec(
      "INSERT INTO reports (rkey, report, attempts, next_ms) VALUES (?, ?, 0, ?)",
      rkey,
      JSON.stringify(report),
      nowMs,
    );
    return true;
  }

  private addReportsOverflow(signalClass: SignalClass): void {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`,
      `reports_overflow:${signalClass}`,
    );
  }

  private readReportsOverflow(): Partial<Record<SignalClass, number>> {
    const out: Partial<Record<SignalClass, number>> = {};
    for (const signalClass of Object.keys(CLASS_POLICY) as SignalClass[]) {
      const row = this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = ?", `reports_overflow:${signalClass}`).toArray()[0];
      if (row !== undefined) out[signalClass] = Number(row.v);
    }
    return out;
  }

  /**
   * RPC, `site` only (§2.4): summary-class events and overflow for the ledger's
   * digest, over the HALF-OPEN minutes `[fromMinute, toMinute)`, so consecutive
   * digests never count their shared boundary minute twice (audit M-5).
   */
  async summarise(fromMinute: number, toMinute: number): Promise<SiteSummary> {
    const activity: Record<string, SignalActivity> = {};
    for (const rule of SIGNAL_RULES) {
      if (rule.subject !== "site" || CLASS_POLICY[rule.signalClass].mode !== "summary") continue;
      activity[rule.signal] = { events: this.eventsInWindow(rule.signal, "site", fromMinute - 1, toMinute - 1).events };
    }
    const overflow = this.sql
      .exec<CountRow>("SELECT COALESCE(SUM(n), 0) AS n FROM overflow WHERE minute >= ? AND minute < ?", fromMinute, toMinute)
      .one().n;
    return { activity, overflowEvents: overflow };
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /** The alarm with an explicit clock: report, prune, then empty or re-arm (§2.4). */
  async alarmAt(nowMs: number): Promise<void> {
    await this.deliverReports(nowMs);
    this.prune(nowMs);
    if (this.isEmpty()) {
      await this.ctx.storage.deleteAll();
      // `deleteAll` drops the tables too; the next `record` needs them.
      this.ensureSchema();
      return;
    }
    const next = this.sql.exec<{ next_ms: number | null }>("SELECT MIN(next_ms) AS next_ms FROM reports").one().next_ms;
    await this.armAt(Math.min(next ?? Number.MAX_SAFE_INTEGER, nowMs + IDLE_ALARM_MS));
  }

  /**
   * Alarm steps 1–2: one RPC with up to 500 due reports; on failure keep them,
   * back off, log.
   *
   * ⚠️ NO DELETE-AFTER-AWAIT ON STATE THAT MAY HAVE CHANGED (audit I-2). The
   * RPC's await opens the input gate, so a `record` can run meanwhile. The rows
   * being sent are DETACHED first (their merge key becomes `inflight:<id>`), so
   * a crossing arriving during the call lands in a NEW row and survives; the
   * overflow counts sent are SUBTRACTED, not deleted.
   */
  private async deliverReports(nowMs: number): Promise<void> {
    const due = this.sql
      .exec<ReportRow>("SELECT id, report, attempts FROM reports WHERE next_ms <= ? ORDER BY id LIMIT ?", nowMs, REPORTS_PER_CALL)
      .toArray();
    const countedOverflow = this.readReportsOverflow();
    if (due.length === 0 && Object.keys(countedOverflow).length === 0) return;
    this.ctx.storage.transactionSync(() => {
      for (const r of due) this.sql.exec("UPDATE reports SET rkey = ? WHERE id = ?", `inflight:${r.id}`, r.id);
    });
    try {
      await this.ledgerFor().report({ reports: due.map((r) => JSON.parse(r.report) as CounterReport), countedOverflow });
    } catch {
      this.ctx.storage.transactionSync(() => this.reattach(due, nowMs));
      logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "ledger_unreachable", ip: null });
      return;
    }
    this.ctx.storage.transactionSync(() => {
      for (const r of due) this.sql.exec("DELETE FROM reports WHERE id = ?", r.id);
      for (const [signalClass, n] of Object.entries(countedOverflow)) this.subtractOverflow(signalClass, n ?? 0);
    });
  }

  /** A failed send: each detached report backs off, merged into any crossing that arrived meanwhile. */
  private reattach(due: readonly ReportRow[], nowMs: number): void {
    for (const r of due) {
      const sent = JSON.parse(r.report) as CounterReport;
      const rkey = `${sent.signal}|${sent.subject}`;
      const live = this.sql.exec<ReportRow>("SELECT id, report, attempts FROM reports WHERE rkey = ?", rkey).toArray()[0];
      const report = live === undefined ? sent : mergeReports(sent, JSON.parse(live.report) as CounterReport);
      if (live !== undefined) this.sql.exec("DELETE FROM reports WHERE id = ?", live.id);
      this.sql.exec(
        "UPDATE reports SET rkey = ?, report = ?, attempts = ?, next_ms = ? WHERE id = ?",
        rkey,
        JSON.stringify(report),
        r.attempts + 1,
        nowMs + reportRetryDelayMs(r.attempts + 1),
        r.id,
      );
    }
  }

  private subtractOverflow(signalClass: string, n: number): void {
    const k = `reports_overflow:${signalClass}`;
    this.sql.exec("UPDATE meta SET v = CAST(CAST(v AS INTEGER) - ? AS TEXT) WHERE k = ?", n, k);
    this.sql.exec("DELETE FROM meta WHERE k = ? AND CAST(v AS INTEGER) <= 0", k);
  }

  /** Alarm step 3. */
  private prune(nowMs: number): void {
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    this.sql.exec("DELETE FROM buckets WHERE minute <= ?", nowMinute - COUNTER_RETENTION_MINUTES);
    this.sql.exec("DELETE FROM members WHERE minute <= ?", nowMinute - COUNTER_RETENTION_MINUTES);
    this.sql.exec("DELETE FROM last_report WHERE at_ms <= ?", nowMs - COUNTER_RETENTION_MINUTES * MINUTE_MS);
    this.sql.exec("DELETE FROM overflow WHERE minute <= ?", nowMinute - OVERFLOW_RETENTION_MINUTES);
  }

  /** Alarm step 4: every table but `meta` empty. A pending report keeps the instance alive. */
  private isEmpty(): boolean {
    for (const table of ["buckets", "members", "reports", "last_report", "overflow"]) {
      if (this.sql.exec<CountRow>(`SELECT COUNT(*) AS n FROM ${table}`).one().n > 0) return false;
    }
    return true;
  }
}

/** Two reports for one (signal, subject) while the ledger is down: events added, window widened (§2.4 m4). */
export function mergeReports(a: CounterReport, b: CounterReport): CounterReport {
  const byRoute: Record<string, number> = { ...a.byRoute };
  for (const [route, n] of Object.entries(b.byRoute)) byRoute[route] = (byRoute[route] ?? 0) + n;
  return {
    ...b,
    windowStartMs: Math.min(a.windowStartMs, b.windowStartMs),
    windowEndMs: Math.max(a.windowEndMs, b.windowEndMs),
    observed: Math.max(a.observed, b.observed),
    events: a.events + b.events,
    byRoute,
  };
}

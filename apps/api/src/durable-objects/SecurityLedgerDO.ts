/**
 * `SecurityLedgerDO` — decides (security-alerting spec §2.6). One instance,
 * `ledger`. It receives only threshold crossings, never raw events, so a flood
 * cannot reach it at volume. It owns every cooldown, budget, held subject,
 * report and outbox row, mints the account refs, and is THE ONLY CALLER OF A
 * SINK (§3.3).
 *
 * ⚠️ THE DESIGN RULE (PM): no attacker-reachable signal may silence a
 * different signal class. Budgets are per class (`decide`, packages/shared).
 *
 * ⚠️ `alarm()` RUNS INDEPENDENT STEPS. Each is its own try/catch and, where it
 * writes, its own transaction; a failure logs `security: alerting_fault` with the
 * step as its reason and the next step still runs (R1). The ledger never calls
 * `deleteAll()`.
 */
import { DurableObject } from "cloudflare:workers";

import {
  CLASS_POLICY,
  decide,
  deliverSecurityAlert,
  HELD_ROW_CAP,
  LogSecurityAlertSink,
  logSecurityEvent,
  selectSecurityAlertSink,
  type CounterReport,
  type LedgerReportBatch,
  type SecurityAlertEnv,
  type SecurityAlertMessage,
  type SecurityAlertSink,
  type SecurityNoticeDropped,
  type SignalClass,
  type SiteSummary,
  type SiteSummaryRpc,
} from "@thinkersjournal/shared";

import { COUNTER_RETENTION_MINUTES, MAX_PENDING_REPORTS } from "./SecurityCounterDO";
import { alertFrom, digestFrom, heartbeatFrom, HEARTBEAT_HOUR_UTC } from "../security/ledger-messages";
import {
  applyCoverage,
  buildHeldReport,
  countedToday,
  countOverflow,
  deleteHeld,
  forgetCovers,
  renderSubject,
  upsertHeld,
  type HeldCovers,
} from "../security/ledger-held";
import { pruneLedger } from "../security/ledger-prune";
import { LEDGER_SCHEMA } from "../security/ledger-schema";
import { LedgerStore, utcDay, type ClassDay } from "../security/ledger-store";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** An anonymised account's tombstone outlasts any plausible ledger outage (§2.6 m-e). */
export const TOMBSTONE_MS = 30 * 86_400_000;
const DROP_STATES: readonly SecurityNoticeDropped["endState"][] = ["dropped_permanent_refusal", "dropped_expired"];
/** KV key in the HEALTH namespace: "the ledger's alarm runs" (§2.6 step 1, R2). */
export const LIVENESS_KEY = "security-ledger:ok";
/** Outbox rows delivered per alarm (§2.6 step 2). */
export const DELIVER_PER_RUN = 20;
/** Backoff after the 1st, 2nd and 3rd failed delivery; the 4th failure drops the row (§2.6 step 2). */
export const OUTBOX_BACKOFF_MINUTES: readonly number[] = [1, 5, 30];
/**
 * `adminUrl` in every held-subject report (§2.6). Null until the admin page
 * ships in PR 3, so no message links to a 404 (PM ruling I-11).
 */
export const SECURITY_ADMIN_URL: string | null = null;

type OutboxRow = { id: number; message: string; covers: string | null; attempts: number };

export class SecurityLedgerDO extends DurableObject<Env> {
  /** TEST SEAM (§3.3): which sink delivers. Board 131 changes `null` to its factory, here only. */
  sinkFactory: (env: SecurityAlertEnv) => SecurityAlertSink = (env) => selectSecurityAlertSink(env, null);
  /** TEST SEAM: the `site` counter, read for the digest's summary-class activity. */
  siteFor: () => SiteSummaryRpc = () => this.env.SECURITY_COUNTER.getByName("site");
  /**
   * TEST SEAM: where the next alarm goes. Tests record it, so a REAL alarm never
   * races their explicit clock (`alarmAt(nowMs)`); one test keeps it real to pin
   * the cron's `ensureLedgerAlarm`.
   */
  armAt: (ms: number) => Promise<void> = (ms) => this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      for (const ddl of LEDGER_SCHEMA) this.ctx.storage.sql.exec(ddl);
    });
  }

  private get store(): LedgerStore {
    return new LedgerStore(this.ctx.storage.sql);
  }

  /** RPC from a counter's alarm (§2.4): a batch of crossings. */
  async report(batch: LedgerReportBatch): Promise<void> {
    await this.reportAt(batch, Date.now());
  }

  async reportAt(batch: LedgerReportBatch, nowMs: number): Promise<void> {
    const lastQueued = this.lastOutboxId();
    // Batch-2 review m-5: a single bad report used to roll back the whole batch,
    // and the counter re-sends the same batch forever. The batch still runs as ONE
    // transaction (per-report transactions doubled the cost of a 500-report
    // batch); only if that throws is it redone one transaction per entry.
    let invalid: number;
    try {
      invalid = this.ctx.storage.transactionSync(() => this.applyEntries(batch, nowMs));
    } catch (err) {
      invalid = this.applyIsolated(batch, nowMs, err);
    }
    if (invalid > 0) logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "report_invalid", ip: null });
    if (this.lastOutboxId() > lastQueued) {
      // Batch-2 review I-1: a queued message goes out on the NEXT tick. An idle
      // alarm sits at the next hour, so "an alarm exists" is not enough here.
      await this.armNoLaterThan(nowMs);
      return;
    }
    // ALWAYS, even for an empty batch: a dead alarm must not survive a report (N2).
    await this.ensureAlarm();
  }

  /** RPC from the two-minute cron (m-d): set an alarm for now if none is set. Idempotent. */
  async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.armAt(Date.now());
  }

  /** A batch's crossings and counted overflows, each with its class and how to apply it. */
  private entriesOf(batch: LedgerReportBatch, nowMs: number): (readonly [string, () => void])[] {
    const entries: (readonly [string, () => void])[] = batch.reports.map(
      (r) => [r.signalClass, () => this.processReport(r, nowMs)] as const,
    );
    for (const [signalClass, n] of Object.entries(batch.countedOverflow)) {
      if (n !== undefined && n > 0) entries.push([signalClass, () => this.countNotStored(signalClass as SignalClass, nowMs, n)]);
    }
    return entries;
  }

  /** The fast path, inside the caller's one transaction: returns how many entries of an unknown class were skipped. */
  private applyEntries(batch: LedgerReportBatch, nowMs: number): number {
    let invalid = 0;
    for (const [signalClass, apply] of this.entriesOf(batch, nowMs)) {
      if (Object.hasOwn(CLASS_POLICY, signalClass)) apply();
      else invalid += 1;
    }
    return invalid;
  }

  /**
   * The batch threw: redo it one transaction per entry, so a bad entry is dropped alone.
   *
   * ⚠️ NEVER A SILENT DROP (batch-2 re-review N-1). If NO valid entry succeeds, the
   * cause is not one entry (a storage fault, a bug every entry hits): `batchError`
   * is rethrown, so `report()` rejects and the counter keeps the batch and retries
   * it. A valid-class entry dropped by a throw is COUNTED (`countOverflow`), so the
   * next digest and held report carry it.
   */
  private applyIsolated(batch: LedgerReportBatch, nowMs: number, batchError: unknown): number {
    let invalid = 0;
    let succeeded = 0;
    const dropped: SignalClass[] = [];
    for (const [signalClass, apply] of this.entriesOf(batch, nowMs)) {
      if (!Object.hasOwn(CLASS_POLICY, signalClass)) {
        invalid += 1;
        continue;
      }
      try {
        this.ctx.storage.transactionSync(apply);
        succeeded += 1;
      } catch {
        dropped.push(signalClass as SignalClass);
      }
    }
    if (succeeded === 0 && dropped.length > 0) throw batchError;
    for (const signalClass of dropped) {
      this.ctx.storage.transactionSync(() => countOverflow(this.store, signalClass, nowMs));
    }
    return invalid + dropped.length;
  }

  /** Move the alarm to `ms` unless one is already set at or before it. */
  private async armNoLaterThan(ms: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > ms) await this.armAt(ms);
  }

  private lastOutboxId(): number {
    return this.store.count("SELECT COALESCE(MAX(id), 0) AS n FROM outbox");
  }

  private processReport(r: CounterReport, nowMs: number): void {
    const store = this.store;
    if (r.subjectKind === "account" && this.isForgotten(r.subject, nowMs)) return;
    const day = utcDay(nowMs);
    const cd = store.classDay(r.signalClass, day);
    const action = decide(r.signalClass, {
      nowMs,
      cooldownUntilMs: store.cooldownUntil(r.signal, r.subject),
      onsetSentToday: cd.onsetSignals.includes(r.signal),
      classSentToday: cd.sent,
      exhaustedQueuedToday: cd.exhaustedQueued,
    });
    switch (action.action) {
      case "send":
        this.send(r, action.cooldownUntilMs, cd, nowMs);
        return;
      case "summarise":
        // Summary-class activity reaches the digest from `site.summarise`, not from here.
        return;
      case "suppress_cooldown":
        store.addPeriod(r.signalClass, "by_cooldown");
        this.hold(r, nowMs);
        return;
      case "suppress_budget":
        this.refuseOnBudget(r, cd, action.queueExhausted, nowMs);
        return;
    }
  }

  private send(r: CounterReport, cooldownUntilMs: number | null, cd: ClassDay, nowMs: number): void {
    const store = this.store;
    const subject = renderSubject(store, r.subjectKind, r.subject, nowMs);
    store.queue(alertFrom(r, subject, this.env.CF_VERSION_METADATA?.id ?? null), nowMs);
    // The cooldown starts when the alert is QUEUED (§2.6).
    if (cooldownUntilMs !== null) store.setCooldown(r.signal, r.subject, cooldownUntilMs);
    const summary = CLASS_POLICY[r.signalClass].mode === "summary";
    const onsetSignals = summary ? [...cd.onsetSignals, r.signal] : cd.onsetSignals;
    store.saveClassDay(r.signalClass, utcDay(nowMs), { ...cd, sent: cd.sent + 1, onsetSignals });
    store.addPeriod(r.signalClass, "sent");
  }

  private refuseOnBudget(r: CounterReport, cd: ClassDay, queueExhausted: boolean, nowMs: number): void {
    const store = this.store;
    const day = utcDay(nowMs);
    const suppressed = cd.suppressed + 1;
    store.saveClassDay(r.signalClass, day, { ...cd, suppressed, exhaustedQueued: cd.exhaustedQueued || queueExhausted });
    store.addPeriod(r.signalClass, "by_budget");
    if (queueExhausted) {
      // Exempt from every budget: exhaustion is never silent (§2.6).
      store.queue(
        {
          type: "budget_exhausted",
          signalClass: r.signalClass,
          day,
          budget: CLASS_POLICY[r.signalClass].dailyBudget,
          suppressedSoFar: suppressed,
        },
        nowMs,
      );
    }
    this.hold(r, nowMs);
  }

  private hold(r: CounterReport, nowMs: number): void {
    if (upsertHeld(this.store, r, nowMs)) this.queueHeldCapped(r.signalClass, HELD_ROW_CAP[r.signalClass], nowMs);
  }

  private countNotStored(signalClass: SignalClass, nowMs: number, n: number): void {
    if (countOverflow(this.store, signalClass, nowMs, n)) this.queueHeldCapped(signalClass, MAX_PENDING_REPORTS, nowMs);
  }

  /**
   * `cap` is the cap that was HIT (batch-2 review m-4): the ledger's row cap when
   * a held row did not fit, a counter's per-class pending-report cap when the
   * counter could only count (`countedOverflow`).
   */
  private queueHeldCapped(signalClass: SignalClass, cap: number, nowMs: number): void {
    const day = utcDay(nowMs);
    this.store.queue(
      {
        type: "held_capped",
        signalClass,
        day,
        cap,
        countedNotStored: countedToday(this.store, signalClass, day),
      },
      nowMs,
    );
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /** §2.6's seven independent steps, then re-arm. */
  async alarmAt(nowMs: number): Promise<void> {
    await this.step("liveness", () => this.env.HEALTH.put(LIVENESS_KEY, String(nowMs)));
    const delivered = await this.step("deliver", () => this.deliver(nowMs));
    await this.step("heartbeat", () => this.heartbeat(nowMs));
    await this.step("held_report", () => this.heldReport(nowMs));
    await this.step("digest", () => this.digest(nowMs));
    await this.step("config", () => this.configFault(nowMs));
    let pruneRemaining = false;
    await this.step("prune", () => {
      pruneRemaining = this.ctx.storage.transactionSync(() => pruneLedger(this.store, nowMs));
    });
    // A deliver step that threw outright must not re-fire at once (batch-2 review I-2).
    await this.rearm(nowMs, pruneRemaining, delivered ? nowMs : nowMs + MINUTE_MS);
  }

  /** One independent step: a throw is logged as `alerting_fault <reason>`. True when it completed. */
  private async step(reason: string, run: () => Promise<void> | void): Promise<boolean> {
    try {
      await run();
      return true;
    } catch {
      logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason, ip: null });
      return false;
    }
  }

  /**
   * Step 2: up to 20 due rows through `deliverSecurityAlert`; backoff 1, 5, 30
   * min; the 4th failure drops.
   *
   * ⚠️ EACH ROW IS ISOLATED (batch-2 review I-2). A row whose handling throws is
   * backed off like a refusal and, on its 4th attempt, quarantined with ONE
   * fault, so it can never block the rows behind it or re-fire the alarm.
   */
  private async deliver(nowMs: number): Promise<void> {
    this.dropSentRows();
    const sink = this.sinkFactory(this.env);
    const due = this.ctx.storage.sql
      .exec<OutboxRow>(
        "SELECT id, message, covers, attempts FROM outbox WHERE sent_ms IS NULL AND next_ms <= ? ORDER BY next_ms, id LIMIT ?",
        nowMs,
        DELIVER_PER_RUN,
      )
      .toArray();
    for (const row of due) {
      try {
        await this.deliverRow(sink, row, nowMs);
      } catch {
        this.rowThrew(row, nowMs);
      }
    }
  }

  /**
   * Rows already sent whose delete failed (m-A). Retried here, idempotently; a
   * failure leaves them marked for the next run, and never blocks delivery.
   */
  private dropSentRows(): void {
    try {
      this.ctx.storage.sql.exec("DELETE FROM outbox WHERE sent_ms IS NOT NULL");
    } catch {
      // Still marked: skipped by every send, retried by the next run.
    }
  }

  private async deliverRow(sink: SecurityAlertSink, row: OutboxRow, nowMs: number): Promise<void> {
    const message = JSON.parse(row.message) as SecurityAlertMessage;
    const result = await deliverSecurityAlert(sink, message);
    if (!result.delivered) {
      await this.deliveryFailed(row, message, nowMs);
      return;
    }
    // SENT. Marked first, then deleted, each on its own: if the delete fails, the
    // mark keeps every later run from sending it again (batch-2 re-review m-A).
    this.ctx.storage.sql.exec("UPDATE outbox SET sent_ms = ? WHERE id = ?", nowMs, row.id);
    this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
    if (row.covers !== null) this.coverAfterSend(row.covers);
  }

  /** Post-send bookkeeping for a held report. A failure leaves its rows held; the next report names them. */
  private coverAfterSend(covers: string): void {
    try {
      this.ctx.storage.transactionSync(() => applyCoverage(this.store, JSON.parse(covers) as HeldCovers));
    } catch {
      logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "deliver_bookkeeping", ip: null });
    }
  }

  /** A row whose handling THREW (not a refusal): back off, then quarantine it with one fault. */
  private rowThrew(row: OutboxRow, nowMs: number): void {
    const attempts = row.attempts + 1;
    const backoff = OUTBOX_BACKOFF_MINUTES[attempts - 1];
    const sql = this.ctx.storage.sql;
    if (backoff !== undefined) {
      sql.exec("UPDATE outbox SET attempts = ?, next_ms = ? WHERE id = ?", attempts, nowMs + backoff * MINUTE_MS, row.id);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO outbox_poison (message, poisoned_ms) VALUES (?, ?)", row.message, nowMs);
      sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
      this.store.addMeta("undeliverable", 1);
    });
    logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "deliver_poison", ip: null });
  }

  private async deliveryFailed(row: OutboxRow, message: SecurityAlertMessage, nowMs: number): Promise<void> {
    const attempts = row.attempts + 1;
    const backoff = OUTBOX_BACKOFF_MINUTES[attempts - 1];
    if (backoff !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE outbox SET attempts = ?, next_ms = ? WHERE id = ?",
        attempts,
        nowMs + backoff * MINUTE_MS,
        row.id,
      );
      return;
    }
    // Dropped: the full message goes to the log first (bounded, PII-minimal, §3.2), and the digest counts it.
    await new LogSecurityAlertSink().send(message);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
      this.store.addMeta("undeliverable", 1);
    });
  }

  /** Step 3: the first alarm at or after 09:00 UTC each day queues one heartbeat (N2, m-d). */
  private heartbeat(nowMs: number): void {
    const day = utcDay(nowMs);
    if (new Date(nowMs).getUTCHours() < HEARTBEAT_HOUR_UTC) return;
    this.ctx.storage.transactionSync(() => {
      if (this.store.meta("last_heartbeat_day") === day) return;
      this.store.queue(heartbeatFrom(this.store, nowMs), nowMs);
      this.store.setMeta("last_heartbeat_day", day);
    });
  }

  /** Step 4: once per hour while anything is open, built in one transaction at sequence S (R1). */
  private heldReport(nowMs: number): void {
    const hour = String(Math.floor(nowMs / HOUR_MS));
    this.ctx.storage.transactionSync(() => {
      const store = this.store;
      if (store.meta("last_held_hour") === hour) return;
      const startMs = Number(store.meta("last_held_ms") ?? String(nowMs - HOUR_MS));
      const built = buildHeldReport(store, { startMs, endMs: nowMs }, SECURITY_ADMIN_URL);
      if (built === null) return;
      store.queue(built.report, nowMs, JSON.stringify(built.covers));
      store.setMeta("last_held_hour", hour);
      store.setMeta("last_held_ms", String(nowMs));
    });
  }

  /** Step 5: hourly, counts only. `site.summarise` is an RPC, so it runs OUTSIDE the transaction. */
  private async digest(nowMs: number): Promise<void> {
    const hour = String(Math.floor(nowMs / HOUR_MS));
    if (this.store.meta("last_digest_hour") === hour) return;
    // Clamped to what the site counter still holds (audit M-5): the digest's
    // period says exactly what was counted, never more.
    const lastMs = Number(this.store.meta("last_digest_ms") ?? String(nowMs - HOUR_MS));
    const startMs = Math.max(lastMs, nowMs - (COUNTER_RETENTION_MINUTES - 1) * MINUTE_MS);
    let site: SiteSummary | null = null;
    try {
      site = await this.siteFor().summarise(Math.floor(startMs / MINUTE_MS), Math.floor(nowMs / MINUTE_MS));
    } catch {
      site = null; // the digest says `siteSummaryUnavailable`
    }
    this.ctx.storage.transactionSync(() => {
      const store = this.store;
      const dropped = {
        dropped_permanent_refusal: store.metaNumber("notices_dropped:dropped_permanent_refusal"),
        dropped_expired: store.metaNumber("notices_dropped:dropped_expired"),
      };
      // The counted-not-stored total runs from the LAST digest, unclamped (m-3).
      const period = { startMs, endMs: nowMs, countedFromMs: lastMs };
      const digest = digestFrom(store, period, site, store.metaNumber("undeliverable"), dropped);
      if (digest !== null) store.queue(digest, nowMs);
      for (const state of DROP_STATES) store.setMeta(`notices_dropped:${state}`, "0");
      store.resetPeriod();
      store.setMeta("undeliverable", "0");
      store.setMeta("last_digest_hour", hour);
      store.setMeta("last_digest_ms", String(nowMs));
    });
  }

  /** Step 6 (PR 2 fills this in): one `config_fault` per UTC day while the device key is absent. */
  private configFault(_nowMs: number): void {}

  private isForgotten(userId: string, nowMs: number): boolean {
    return this.store.count("SELECT COUNT(*) AS n FROM forgotten WHERE user_id = ? AND until_ms > ?", userId, nowMs) > 0;
  }

  /**
   * RPC for the nightly sweep (R2-1): the next `limit` account ids the ledger
   * still holds by user id (held rows and refs), after a cursor kept in `meta`
   * that wraps to the start, so successive runs visit every id, bounded per run.
   */
  async accountIdsPage(limit: number): Promise<string[]> {
    return this.ctx.storage.transactionSync(() => {
      const store = this.store;
      const after = store.meta("sweep_after") ?? "";
      const ids = store.sql
        .exec<{ id: string }>(
          `SELECT id FROM (SELECT subject AS id FROM held WHERE subject_kind = 'account'
                           UNION SELECT user_id AS id FROM account_refs)
           WHERE id > ? ORDER BY id LIMIT ?`,
          after,
          limit,
        )
        .toArray()
        .map((r) => r.id);
      store.setMeta("sweep_after", ids.length < limit ? "" : (ids.at(-1) ?? ""));
      return ids;
    });
  }

  /** RPC from both reapers (§2.6 m-e, §4.5): forget the account, and leave a 30-day tombstone. Idempotent. */
  async forgetAccount(userId: string): Promise<void> {
    await this.forgetAccountAt(userId, Date.now());
  }

  async forgetAccountAt(userId: string, nowMs: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM account_refs WHERE user_id = ?", userId);
      deleteHeld(this.store, "subject_kind = 'account' AND subject = ?", userId);
      sql.exec("DELETE FROM cooldowns WHERE subject = ?", userId);
      // Batch-2 review m-2: the two other places a raw id can wait (N7).
      if (this.store.meta("sweep_after") === userId) this.store.setMeta("sweep_after", "");
      forgetCovers(this.store, userId);
      sql.exec(
        `INSERT INTO forgotten (user_id, until_ms) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET until_ms = excluded.until_ms`,
        userId,
        nowMs + TOMBSTONE_MS,
      );
    });
  }

  /** Prune work left → now; otherwise the next due outbox row or the next hour, whichever is sooner. */
  private async rearm(nowMs: number, pruneRemaining: boolean, earliestMs: number): Promise<void> {
    if (pruneRemaining) {
      await this.armAt(earliestMs);
      return;
    }
    const next = this.ctx.storage.sql
      .exec<{ next_ms: number | null }>("SELECT MIN(next_ms) AS next_ms FROM outbox WHERE sent_ms IS NULL")
      .one().next_ms;
    const nextHour = (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS;
    await this.armAt(Math.max(earliestMs, Math.min(next ?? nextHour, nextHour)));
  }
}

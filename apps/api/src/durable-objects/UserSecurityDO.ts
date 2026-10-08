/**
 * `UserSecurityDO` — a per-user monotonic "security epoch" counter, one
 * Durable Object instance per user (addressed via `getByName(userId)`).
 *
 * A session's `SessionData.securityEpoch` is stamped at login time. On every
 * revocation check (Tasks 16-17), the request handler compares that stamp
 * against the *current* epoch from this DO: if they differ, the session was
 * issued before the last `bumpEpoch()` call and is treated as revoked. This
 * lets "log out everywhere" / "force re-auth after password change" revoke
 * every outstanding session for a user in O(1) — no need to enumerate or
 * delete individual session records.
 *
 * Backed by the DO's SQLite storage (`new_sqlite_classes` — see
 * `wrangler.jsonc`), NOT in-memory state, so the epoch survives eviction,
 * hibernation, and redeploys.
 *
 * Security alerting PR 2 (docs/superpowers/specs/2026-10-07-security-alerting-design.md
 * §4.1, §4.4) adds the account's device list, its notice send times and its
 * one pending notice per kind, all in this object's SQLite, with an alarm that
 * enforces the 400-day device bound and sends deferred notices.
 */
import { DurableObject } from "cloudflare:workers";

import {
  DEVICE_TTL_MS,
  logSecurityEvent,
  NOTICE_MAX_AGE_MS,
  noticeRetryDelayMs,
  type AccountNoticeKind,
  type DeviceHashes,
  type DeviceRecordMode,
  type PendingNotice,
  type SignInRecord,
} from "@thinkersjournal/shared";

import { sendNotice, type NoticeFacts, type NoticeSendResult } from "../security/account-notice-send";
import {
  allPending,
  claimNoticeSync,
  detachDue,
  holdDue,
  mergePending,
  NOTICE_KINDS,
  overdueClaims,
  recordDeviceSync,
  releaseSlot,
  takeClaimed,
  USER_DEVICE_SCHEMA,
  type NoticeClaimResult,
  type NoticeEvent,
} from "../security/user-devices";

const DAY_MS = 86_400_000;
/** After an alarm step faulted, the next alarm is at least this far off, so a persistent fault cannot spin (review M-2). */
const ALARM_FAULT_RETRY_MS = 60_000;

interface SecurityRow extends Record<string, string | number | null> {
  epoch: number;
}

/** The one log line per ended notice (§4.4 G1): the state and the kind, never an id or an address. */
export function logNoticeEnd(state: string, kind: AccountNoticeKind): void {
  console.warn(`account-notice: dropped ${state} ${kind}`);
}

/** The ledger slice a Postmark drop is reported to (§4.4). */
export interface NoticeDropRpc {
  noticeDropped(endState: "dropped_permanent_refusal" | "dropped_expired"): Promise<void>;
}

export class UserSecurityDO extends DurableObject<Env> {
  /** TEST SEAM: the send a deferred notice uses. Tests replace it via `runInDurableObject`. */
  noticeSender: typeof sendNotice = sendNotice;
  /** TEST SEAM: where a Postmark drop is reported. */
  ledgerFor: () => NoticeDropRpc = () => this.env.SECURITY_LEDGER.getByName("ledger");
  /** TEST SEAM: whether notices are on at SEND time (final review M-5); production reads this object's own env. */
  noticesEnabled: () => boolean = () => this.env.ACCOUNT_NOTICES_ENABLED === "1";
  /** TEST SEAM: where the next alarm goes (null clears it), so a real alarm never races `alarmAt`. */
  armAt: (ms: number | null) => Promise<void> = (ms) =>
    ms === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Runs before any request this instance handles, and only once per
    // instance lifetime — safe to call unconditionally on every construction
    // because both the CREATE TABLE and the seed INSERT are idempotent.
    void this.ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS security (
           id INTEGER PRIMARY KEY,
           epoch INTEGER NOT NULL DEFAULT 0
         )`,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO security (id, epoch) VALUES (1, 0)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const ddl of USER_DEVICE_SCHEMA) this.ctx.storage.sql.exec(ddl);
      return Promise.resolve();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** The current security epoch for this user (starts at 0). */
  getEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>("SELECT epoch FROM security WHERE id = 1")
      .one();
    return Promise.resolve(row.epoch);
  }

  /**
   * Atomically increments the epoch and returns the new value. Strictly
   * monotonic: each call increments by exactly 1.
   */
  bumpEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>(
        "UPDATE security SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch",
      )
      .one();
    return Promise.resolve(row.epoch);
  }

  /** Plan ruling P-7: remember whose object this is, for the alarm's deferred send. */
  private rememberOwner(): void {
    const name = this.ctx.id.name;
    if (name !== undefined) this.sql.exec("INSERT INTO owner (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING", name);
  }

  private owner(): string | null {
    return this.sql.exec<{ user_id: string }>("SELECT user_id FROM owner WHERE id = 1").toArray().at(0)?.user_id ?? null;
  }

  /** §4.1: record this browser; `signup` and `reset` clear the list first (see `recordDeviceSync`). */
  async recordDevice(hashes: DeviceHashes, nowMs: number, mode: DeviceRecordMode): Promise<SignInRecord> {
    const record = this.ctx.storage.transactionSync(() => {
      this.rememberOwner();
      return recordDeviceSync(this.sql, hashes, nowMs, mode);
    });
    await this.rearm();
    return record;
  }

  /** §4.4: never drops a notice; sends now or folds it into the one pending notice of its kind. */
  async claimNotice(kind: AccountNoticeKind, event: NoticeEvent, nowMs: number, notBeforeMs: number): Promise<NoticeClaimResult> {
    const claim = this.ctx.storage.transactionSync(() => {
      this.rememberOwner();
      return claimNoticeSync(this.sql, kind, event, nowMs, notBeforeMs);
    });
    await this.rearm();
    return claim;
  }

  /**
   * Plan rulings P-5 and R2-3: the route reports how its immediate send of claim
   * `claimId` ended. Sent: the claim is cleared and its cap slot stays spent.
   * Anything else gives the slot back (review M-3: only a send in progress or a
   * mail that went out counts). Transient (a refusal or a throw, CR-1): it
   * becomes this kind's pending notice, folded with any that arrived meanwhile,
   * retried after `noticeRetryDelayMs(1)`. If this call never arrives, the alarm
   * recovers the claim at its `due_ms`. Returns false when there was no such
   * claim (settled already, or recovered by the alarm), so the caller logs an
   * end state only once.
   */
  async settleClaim(claimId: number, result: NoticeSendResult, nowMs: number): Promise<boolean> {
    const took = this.ctx.storage.transactionSync(() => {
      const claimed = takeClaimed(this.sql, claimId);
      if (claimed === null) return false;
      const p = claimed.notice;
      if (result !== "sent") releaseSlot(this.sql, p.kind, claimed.claimedMs);
      if (result === "transient") mergePending(this.sql, { ...p, attempts: 1, dueMs: nowMs + noticeRetryDelayMs(1) });
      return true;
    });
    await this.rearm();
    return took;
  }

  /** Clears the device list only; the epoch and the notice tables are untouched (§4.1). */
  async forgetDevices(): Promise<void> {
    this.sql.exec("DELETE FROM known_devices");
    await this.rearm();
  }

  /** Both reapers call this: every pending (or in-flight) notice ends `dropped_account_gone`, logged (§4.5). */
  async dropPendingNotices(): Promise<void> {
    const ended = this.ctx.storage.transactionSync(() =>
      (["pending_notice", "inflight_notice", "claimed_notice"] as const).flatMap((table) => {
        const rows = allPending(this.sql, table);
        this.sql.exec(`DELETE FROM ${table}`);
        return rows.map((p) => p.kind);
      }),
    );
    for (const kind of ended) logNoticeEnd("dropped_account_gone", kind);
    await this.rearm();
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /**
   * Prune expired browsers and send times, recover stranded sends, send what is
   * due, re-arm (§4.1, §4.4). Review M-2: each step and each kind's send is
   * isolated, so one throw never strands the others, and the re-arm runs in a
   * `finally`, so pending or in-flight work always has an alarm.
   */
  async alarmAt(nowMs: number): Promise<void> {
    let faulted = false;
    try {
      const pruned = this.step("prune", () => {
        this.pruneExpired(nowMs);
      });
      const recovered = this.step("recover", () => {
        this.ctx.storage.transactionSync(() => {
          this.recoverStranded(nowMs);
        });
      });
      faulted = !pruned || !recovered;
      for (const kind of NOTICE_KINDS) {
        try {
          await this.sendPending(kind, nowMs);
        } catch (err) {
          faulted = true;
          this.fault("send", err);
        }
      }
    } finally {
      await this.rearm(faulted ? nowMs + ALARM_FAULT_RETRY_MS : null);
    }
  }

  private pruneExpired(nowMs: number): void {
    this.sql.exec("DELETE FROM known_devices WHERE last_seen <= ?", nowMs - DEVICE_TTL_MS);
    this.sql.exec("DELETE FROM notices WHERE sent_ms <= ?", nowMs - DAY_MS);
  }

  /**
   * A send interrupted by an eviction (or a fault) left its row in flight, and a
   * route cut off after its claim left a claimed row past its timeout (R2-3):
   * both are pending again and go out in this run. Each gives back the cap slot
   * it held; the send that follows takes its own (review M-3).
   */
  private recoverStranded(nowMs: number): void {
    for (const p of allPending(this.sql, "inflight_notice")) {
      this.sql.exec("DELETE FROM inflight_notice WHERE kind = ?", p.kind);
      releaseSlot(this.sql, p.kind, p.dueMs);
      mergePending(this.sql, p);
    }
    for (const c of overdueClaims(this.sql, nowMs)) {
      this.sql.exec("DELETE FROM claimed_notice WHERE claim_id = ?", c.claimId);
      releaseSlot(this.sql, c.notice.kind, c.claimedMs);
      mergePending(this.sql, { ...c.notice, dueMs: nowMs, attempts: Math.max(c.notice.attempts, 1) });
    }
  }

  /** One isolated alarm step: a throw is logged as `alerting_fault account-notice alarm_<step>`. True when it completed. */
  private step(name: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (err) {
      this.fault(name, err);
      return false;
    }
  }

  /** Never an id, an address or the error's message: the step and the error's name only. */
  private fault(name: string, err: unknown): void {
    console.error(`account-notice: alarm step ${name} failed`, err instanceof Error ? err.name : "threw");
    logSecurityEvent({ kind: "alerting_fault", route: "account-notice", reason: `alarm_${name}`, ip: null });
  }

  private async sendPending(kind: AccountNoticeKind, nowMs: number): Promise<void> {
    if (!this.noticesEnabled()) {
      await this.holdPending(kind, nowMs);
      return;
    }
    // Detach BEFORE the await (audit I-2), on fresh state (review M-3): a sign-in
    // folded while Postmark is answering lands in a fresh pending row, which
    // settle never touches, and sees this send's cap slot.
    const p = this.ctx.storage.transactionSync(() => detachDue(this.sql, kind, nowMs));
    if (p === null) return;
    const userId = this.owner();
    if (userId === null) {
      // Audit I-9: its own outcome, never "account gone". Retried until the
      // owner is known or the notice's maximum age passes.
      console.warn(`account-notice: owner_unknown ${kind}`);
      await this.settle(p, "transient", nowMs);
      return;
    }
    const facts: NoticeFacts = {
      kind: p.kind,
      atMs: p.lastEventMs,
      country: p.lastCountry,
      coalesced: p.count > 1 ? { count: p.count - 1, sinceMs: p.firstEventMs } : null,
      listWasEmpty: p.listWasEmpty,
    };
    const waitUntil = (x: Promise<unknown>): void => {
      this.ctx.waitUntil(x);
    };
    let result: NoticeSendResult;
    try {
      result = await this.noticeSender(this.env, { waitUntil }, userId, facts);
    } catch {
      result = "transient";
    }
    await this.settle(p, result, nowMs);
  }

  /**
   * Final review M-5: notices are off at send time, so nothing is sent. The due
   * notice is held (see `holdDue`), or, once too old, ends `dropped_expired`.
   */
  private async holdPending(kind: AccountNoticeKind, nowMs: number): Promise<void> {
    const expired = this.ctx.storage.transactionSync(() => holdDue(this.sql, kind, nowMs));
    if (expired === null) {
      console.warn(`account-notice: held ${kind}`);
      return;
    }
    await this.endDropped(expired.kind, "dropped_expired");
  }

  /**
   * The named end states (§4.4 G1). Only the detached in-flight row is settled;
   * pending folds are untouched. `nowMs` is the detach time, so it names the cap
   * slot this send took: kept when the mail went out, given back otherwise.
   *
   * Final review M-2: if the in-flight row is gone, a reaper's
   * `dropPendingNotices` ended this notice (and logged it) while Postmark was
   * answering. Nothing is merged back, and nothing is logged twice.
   */
  private async settle(p: PendingNotice, result: NoticeSendResult, nowMs: number): Promise<void> {
    const retry = result === "transient" && nowMs - p.firstEventMs < NOTICE_MAX_AGE_MS;
    const live = this.ctx.storage.transactionSync(() => {
      const inflight = this.sql.exec("SELECT 1 FROM inflight_notice WHERE kind = ?", p.kind).toArray().length > 0;
      if (!inflight) return false;
      this.sql.exec("DELETE FROM inflight_notice WHERE kind = ?", p.kind);
      if (result !== "sent") releaseSlot(this.sql, p.kind, nowMs);
      if (retry) mergePending(this.sql, { ...p, attempts: p.attempts + 1, dueMs: nowMs + noticeRetryDelayMs(p.attempts + 1) });
      return true;
    });
    if (!live || retry || result === "sent") return;
    if (result === "gone") {
      logNoticeEnd("dropped_account_gone", p.kind);
      return;
    }
    await this.endDropped(p.kind, result === "permanent" ? "dropped_permanent_refusal" : "dropped_expired");
  }

  /** A Postmark-side end state: logged once, and told to the ledger (§4.4). */
  private async endDropped(kind: AccountNoticeKind, state: "dropped_permanent_refusal" | "dropped_expired"): Promise<void> {
    logNoticeEnd(state, kind);
    try {
      await this.ledgerFor().noticeDropped(state);
    } catch {
      // The log line above stands; the ledger is not this object's to retry.
    }
  }

  /**
   * The earliest of: the oldest browser's expiry, the oldest send time's expiry,
   * the next due notice (pending, in flight or claimed); never before `notBeforeMs`.
   */
  private async rearm(notBeforeMs: number | null = null): Promise<void> {
    const next = this.sql
      .exec<{ t: number | null }>(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(last_seen) + ? AS t FROM known_devices
           UNION ALL SELECT MIN(sent_ms) + ? FROM notices
           UNION ALL SELECT MIN(due_ms) FROM pending_notice
           UNION ALL SELECT MIN(due_ms) FROM inflight_notice
           UNION ALL SELECT MIN(due_ms) FROM claimed_notice)`,
        DEVICE_TTL_MS,
        DAY_MS,
      )
      .one().t;
    await this.armAt(next === null || notBeforeMs === null ? next : Math.max(next, notBeforeMs));
  }
}

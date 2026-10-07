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
  NOTICE_MAX_AGE_MS,
  noticeRetryDelayMs,
  type AccountNoticeKind,
  type DeviceHashes,
  type DeviceRecordMode,
  type NoticeClaim,
  type PendingNotice,
  type SignInRecord,
} from "@thinkersjournal/shared";

import { sendNotice, type NoticeFacts, type NoticeSendResult } from "../security/account-notice-send";
import {
  allPending,
  claimNoticeSync,
  detachPending,
  mergePending,
  recordDeviceSync,
  takeClaimed,
  USER_DEVICE_SCHEMA,
  type NoticeEvent,
} from "../security/user-devices";

const DAY_MS = 86_400_000;

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
  /** TEST SEAM: where the next alarm goes (null clears it), so a real alarm never races `alarmAt`. */
  armAt: (ms: number | null) => Promise<void> = (ms) =>
    ms === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Runs before any request this instance handles, and only once per
    // instance lifetime — safe to call unconditionally on every construction
    // because both the CREATE TABLE and the seed INSERT are idempotent.
    this.ctx.blockConcurrencyWhile(async () => {
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
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** The current security epoch for this user (starts at 0). */
  async getEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>("SELECT epoch FROM security WHERE id = 1")
      .one();
    return Number(row.epoch);
  }

  /**
   * Atomically increments the epoch and returns the new value. Strictly
   * monotonic: each call increments by exactly 1.
   */
  async bumpEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>(
        "UPDATE security SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch",
      )
      .one();
    return Number(row.epoch);
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
  async claimNotice(kind: AccountNoticeKind, event: NoticeEvent, nowMs: number, notBeforeMs: number): Promise<NoticeClaim> {
    const claim = this.ctx.storage.transactionSync(() => {
      this.rememberOwner();
      return claimNoticeSync(this.sql, kind, event, nowMs, notBeforeMs);
    });
    await this.rearm();
    return claim;
  }

  /**
   * Plan rulings P-5 and R2-3: the route reports how its immediate send of the
   * claim for the event at `atMs` ended. Sent or a drop state: the durable claim
   * is cleared. Transient (a refusal or a throw, CR-1): it becomes this kind's
   * pending notice, folded with any that arrived meanwhile, retried after
   * `noticeRetryDelayMs(1)`; its cap slot was spent at claim time. If this call
   * never arrives, the alarm recovers the claim at its `due_ms`.
   */
  async settleClaim(kind: AccountNoticeKind, atMs: number, result: NoticeSendResult, nowMs: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const claimed = takeClaimed(this.sql, kind, atMs);
      if (claimed !== null && result === "transient") {
        mergePending(this.sql, { ...claimed, attempts: 1, dueMs: nowMs + noticeRetryDelayMs(1) });
      }
    });
    await this.rearm();
  }

  /** Clears the device list only; the epoch and the notice tables are untouched (§4.1). */
  async forgetDevices(): Promise<void> {
    this.sql.exec("DELETE FROM known_devices");
    await this.rearm();
  }

  /** Both reapers call this: every pending (or in-flight) notice ends `dropped_account_gone`, logged (§4.5). */
  async dropPendingNotices(): Promise<void> {
    for (const table of ["pending_notice", "inflight_notice", "claimed_notice"] as const) {
      for (const p of allPending(this.sql, table)) {
        this.sql.exec(`DELETE FROM ${table} WHERE kind = ? AND last_event_ms = ?`, p.kind, p.lastEventMs);
        logNoticeEnd("dropped_account_gone", p.kind);
      }
    }
    await this.rearm();
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /** Prune expired browsers and send times, send what is due, re-arm (§4.1, §4.4). */
  async alarmAt(nowMs: number): Promise<void> {
    this.sql.exec("DELETE FROM known_devices WHERE last_seen <= ?", nowMs - DEVICE_TTL_MS);
    this.sql.exec("DELETE FROM notices WHERE sent_ms <= ?", nowMs - DAY_MS);
    // A send interrupted by an eviction left its row in flight, and a route cut
    // off after its claim left a claimed row past its timeout (R2-3): both are
    // pending again, and go out in this run.
    this.ctx.storage.transactionSync(() => {
      for (const p of allPending(this.sql, "inflight_notice")) {
        this.sql.exec("DELETE FROM inflight_notice WHERE kind = ?", p.kind);
        mergePending(this.sql, p);
      }
      for (const p of allPending(this.sql, "claimed_notice")) {
        if (p.dueMs > nowMs) continue;
        this.sql.exec("DELETE FROM claimed_notice WHERE kind = ? AND last_event_ms = ?", p.kind, p.lastEventMs);
        mergePending(this.sql, { ...p, dueMs: nowMs, attempts: Math.max(p.attempts, 1) });
      }
    });
    for (const p of allPending(this.sql)) {
      if (p.dueMs <= nowMs) await this.sendPending(p.kind, nowMs);
    }
    await this.rearm();
  }

  private async sendPending(kind: AccountNoticeKind, nowMs: number): Promise<void> {
    // Detach BEFORE the await (audit I-2): a sign-in folded while Postmark is
    // answering lands in a fresh pending row, which settle never touches.
    const p = this.ctx.storage.transactionSync(() => detachPending(this.sql, kind));
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

  /** The named end states (§4.4 G1). Only the detached in-flight row is settled; pending folds are untouched. */
  private async settle(p: PendingNotice, result: NoticeSendResult, nowMs: number): Promise<void> {
    const retry = result === "transient" && nowMs - p.firstEventMs < NOTICE_MAX_AGE_MS;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM inflight_notice WHERE kind = ?", p.kind);
      if (retry) mergePending(this.sql, { ...p, attempts: p.attempts + 1, dueMs: nowMs + noticeRetryDelayMs(p.attempts + 1) });
      if (result === "sent") this.sql.exec("INSERT INTO notices (kind, sent_ms) VALUES (?, ?)", p.kind, nowMs);
    });
    if (retry || result === "sent") return;
    if (result === "gone") {
      logNoticeEnd("dropped_account_gone", p.kind);
      return;
    }
    const state = result === "permanent" ? "dropped_permanent_refusal" : "dropped_expired";
    logNoticeEnd(state, p.kind);
    try {
      await this.ledgerFor().noticeDropped(state);
    } catch {
      // The log line above stands; the ledger is not this object's to retry.
    }
  }

  /** The earliest of: the oldest browser's expiry, the oldest send time's expiry, the next due notice. */
  private async rearm(): Promise<void> {
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
    await this.armAt(next);
  }
}

/**
 * `UserSecurityDO`'s device list and notice tables (security-alerting spec §4.1,
 * §4.4). Synchronous functions over the DO's SQLite, so `UserSecurityDO` can run
 * each RPC in one `transactionSync`. Created in the DO's constructor beside the
 * `security` table, so there is no wrangler migration (§4.1).
 */
import {
  capAllows,
  capReopensAt,
  foldedDueMs,
  NOTICE_MAX_AGE_MS,
  noticeRetryDelayMs,
  type AccountNoticeKind,
  type DeviceHashes,
  type DeviceRecordMode,
  type NoticeClaim,
  type PendingNotice,
  type SignInRecord,
} from "@thinkersjournal/shared";

/** At most this many browsers per account; the least recently seen is evicted (§4.1). */
export const DEVICE_LIST_CAP = 20;
const DAY_MS = 86_400_000;

export const USER_DEVICE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS known_devices (device_hash TEXT PRIMARY KEY, kid TEXT NOT NULL,
     first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL) WITHOUT ROWID`,
  "CREATE TABLE IF NOT EXISTS notices (kind TEXT NOT NULL, sent_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS notices_kind_sent ON notices (kind, sent_ms)",
  `CREATE TABLE IF NOT EXISTS pending_notice (kind TEXT PRIMARY KEY, count INTEGER NOT NULL,
     first_event_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL, last_country TEXT,
     list_was_empty INTEGER NOT NULL, due_ms INTEGER NOT NULL, attempts INTEGER NOT NULL) WITHOUT ROWID`,
  // Plan ruling P-7: the alarm sends a deferred notice with no request in hand, so it needs the user id.
  "CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL)",
  // Audit I-2: the notice being SENT, detached from `pending_notice` before the
  // alarm awaits Postmark, so a sign-in folded meanwhile lands in a fresh
  // pending row instead of being deleted or overwritten on settle.
  `CREATE TABLE IF NOT EXISTS inflight_notice (kind TEXT PRIMARY KEY, count INTEGER NOT NULL,
     first_event_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL, last_country TEXT,
     list_was_empty INTEGER NOT NULL, due_ms INTEGER NOT NULL, attempts INTEGER NOT NULL) WITHOUT ROWID`,
  // R2-3: a notice a ROUTE claimed for an immediate send, with its folds, written
  // in the same transaction that took it out of `pending_notice`. The route
  // settles it by `claim_id`; if the route is cut off, the alarm recovers it at
  // `due_ms`. Review M-4: keyed by a never-reused id, NOT by the event time, so
  // two claims in one millisecond stay two claims. `claimed_ms` is the cap slot
  // (`notices.sent_ms`) the claim holds while it is in progress (review M-3).
  `CREATE TABLE IF NOT EXISTS claimed_notice (claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL, count INTEGER NOT NULL,
     first_event_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL, last_country TEXT,
     list_was_empty INTEGER NOT NULL, due_ms INTEGER NOT NULL, attempts INTEGER NOT NULL,
     claimed_ms INTEGER NOT NULL)`,
];

/** Both notice kinds, in the order the alarm sends them. */
export const NOTICE_KINDS: readonly AccountNoticeKind[] = ["new_sign_in", "password_reset"];

/** `claimNotice`'s answer in this object: a send-now claim carries the id the route settles it by (review M-4). */
export type NoticeClaimResult =
  | (Extract<NoticeClaim, { send: "now" }> & { readonly claimId: number })
  | Extract<NoticeClaim, { send: "deferred" }>;

type NoticeTable = "pending_notice" | "inflight_notice" | "claimed_notice";

type DeviceRow = { device_hash: string; kid: string; first_seen: number };
type PendingRow = {
  kind: string;
  count: number;
  first_event_ms: number;
  last_event_ms: number;
  last_country: string | null;
  list_was_empty: number;
  due_ms: number;
  attempts: number;
};

/** §4.1: `signup` clears then records; `reset` clears all but this browser; `login` records. */
export function recordDeviceSync(sql: SqlStorage, h: DeviceHashes, nowMs: number, mode: DeviceRecordMode): SignInRecord {
  const entries = sql.exec<DeviceRow>("SELECT device_hash, kid, first_seen FROM known_devices").toArray();
  const listWasEmpty = entries.length === 0;
  const cur = entries.find((e) => e.device_hash === h.current);
  const old = h.prev === null || h.prev === h.current ? undefined : entries.find((e) => e.device_hash === h.prev);
  const kids = new Set([h.currentKid, h.prevKid]);
  const unknownKeysOnly = !listWasEmpty && !entries.some((e) => kids.has(e.kid));
  if (mode !== "login") {
    sql.exec("DELETE FROM known_devices");
  } else if (old !== undefined) {
    // A `prev` match moves to the `current` hash (N5). Review I-1: the browser
    // may ALSO hold a `current` entry (a key replaced without `_PREV`, then
    // `_PREV` set), so the prev row is deleted and merged into the upsert below,
    // never renamed onto an existing primary key.
    sql.exec("DELETE FROM known_devices WHERE device_hash = ?", old.device_hash);
  }
  // The earliest first-seen survives the merge; a `current` row keeps its own through `MIN` on conflict.
  const firstSeen = mode === "login" ? Math.min(nowMs, old?.first_seen ?? nowMs) : nowMs;
  sql.exec(
    `INSERT INTO known_devices (device_hash, kid, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(device_hash) DO UPDATE SET kid = excluded.kid, last_seen = excluded.last_seen,
       first_seen = MIN(known_devices.first_seen, excluded.first_seen)`,
    h.current,
    h.currentKid,
    firstSeen,
    nowMs,
  );
  sql.exec(
    `DELETE FROM known_devices WHERE device_hash IN (
       SELECT device_hash FROM known_devices ORDER BY last_seen DESC LIMIT -1 OFFSET ?)`,
    DEVICE_LIST_CAP,
  );
  return { knownDevice: cur !== undefined || old !== undefined, listWasEmpty, unknownKeysOnly };
}

export function readPending(sql: SqlStorage, kind: AccountNoticeKind, table: NoticeTable = "pending_notice"): PendingNotice | null {
  const row = sql.exec<PendingRow>(`SELECT * FROM ${table} WHERE kind = ?`, kind).toArray().at(0);
  return row === undefined ? null : toPending(row);
}

export function allPending(sql: SqlStorage, table: NoticeTable = "pending_notice"): PendingNotice[] {
  return sql.exec<PendingRow>(`SELECT * FROM ${table} ORDER BY due_ms`).toArray().map(toPending);
}

function toPending(row: PendingRow): PendingNotice {
  return {
    kind: row.kind as AccountNoticeKind,
    count: row.count,
    firstEventMs: row.first_event_ms,
    lastEventMs: row.last_event_ms,
    lastCountry: row.last_country,
    listWasEmpty: row.list_was_empty === 1,
    dueMs: row.due_ms,
    attempts: row.attempts,
  };
}

export function writePending(sql: SqlStorage, p: PendingNotice, table: NoticeTable = "pending_notice"): void {
  sql.exec(
    `INSERT INTO ${table} (kind, count, first_event_ms, last_event_ms, last_country, list_was_empty, due_ms, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET count = excluded.count, first_event_ms = excluded.first_event_ms,
       last_event_ms = excluded.last_event_ms, last_country = excluded.last_country,
       list_was_empty = excluded.list_was_empty, due_ms = excluded.due_ms, attempts = excluded.attempts`,
    p.kind,
    p.count,
    p.firstEventMs,
    p.lastEventMs,
    p.lastCountry,
    p.listWasEmpty ? 1 : 0,
    p.dueMs,
    p.attempts,
  );
}

/**
 * Fold `p` into the kind's pending notice (or make it the pending notice): counts
 * add, the earliest first event and due time win, the latest event's time and
 * country are kept. Used for a requeue (P-5, CR-1) and a transient settle.
 */
export function mergePending(sql: SqlStorage, p: PendingNotice): void {
  const cur = readPending(sql, p.kind);
  if (cur === null) {
    writePending(sql, p);
    return;
  }
  const pLater = p.lastEventMs >= cur.lastEventMs;
  writePending(sql, {
    kind: p.kind,
    count: cur.count + p.count,
    firstEventMs: Math.min(cur.firstEventMs, p.firstEventMs),
    lastEventMs: pLater ? p.lastEventMs : cur.lastEventMs,
    lastCountry: pLater ? p.lastCountry : cur.lastCountry,
    listWasEmpty: cur.listWasEmpty || p.listWasEmpty,
    dueMs: Math.min(cur.dueMs, p.dueMs),
    attempts: Math.max(cur.attempts, p.attempts),
  });
}

/** Take one cap slot (a `notices` row) for a send now in progress (review M-3). */
function takeSlot(sql: SqlStorage, kind: AccountNoticeKind, atMs: number): void {
  sql.exec("INSERT INTO notices (kind, sent_ms) VALUES (?, ?)", kind, atMs);
}

/** Give back the slot a send took at `atMs` when it ended without a mail going out (review M-3). */
export function releaseSlot(sql: SqlStorage, kind: AccountNoticeKind, atMs: number): void {
  sql.exec(
    "DELETE FROM notices WHERE rowid IN (SELECT rowid FROM notices WHERE kind = ? AND sent_ms = ? LIMIT 1)",
    kind,
    atMs,
  );
}

/**
 * The alarm's send of the kind's pending notice, decided on FRESH state inside
 * the caller's transaction (review M-3): only if it is still due and the cap
 * still allows a send, counting every send in progress. Then it is detached into
 * `inflight_notice` (due = `nowMs`, the slot it holds) with a cap slot taken. A
 * notice the cap now refuses is re-deferred to when the cap reopens.
 */
export function detachDue(sql: SqlStorage, kind: AccountNoticeKind, nowMs: number): PendingNotice | null {
  const p = readPending(sql, kind);
  if (p === null || p.dueMs > nowMs) return null;
  const sent = sentTimes(sql, kind, nowMs);
  if (!capAllows(sent, nowMs, kind)) {
    writePending(sql, { ...p, dueMs: capReopensAt(sent, nowMs, kind) });
    return null;
  }
  sql.exec("DELETE FROM pending_notice WHERE kind = ?", kind);
  writePending(sql, { ...p, dueMs: nowMs }, "inflight_notice");
  takeSlot(sql, kind, nowMs);
  return p;
}

/** How long a notice held by the flag (final review M-5) waits before the alarm looks again. */
export const NOTICE_HOLD_MS = 3_600_000;

/**
 * Final review M-5: with notices OFF at send time, the kind's due notice is
 * HELD (kept, its due time moved `NOTICE_HOLD_MS` on, so the alarm does not
 * spin) until the flag is on again, or it is taken out and returned for a
 * `dropped_expired` once it is `NOTICE_MAX_AGE_MS` old. Null when nothing is due
 * or it was held.
 */
export function holdDue(sql: SqlStorage, kind: AccountNoticeKind, nowMs: number): PendingNotice | null {
  const p = readPending(sql, kind);
  if (p === null || p.dueMs > nowMs) return null;
  if (nowMs - p.firstEventMs >= NOTICE_MAX_AGE_MS) {
    sql.exec("DELETE FROM pending_notice WHERE kind = ?", kind);
    return p;
  }
  writePending(sql, { ...p, dueMs: nowMs + NOTICE_HOLD_MS });
  return null;
}

type ClaimRow = PendingRow & { claim_id: number; claimed_ms: number };

/** A route's claim: the notice, its id, and the cap slot it holds. */
export interface Claimed {
  readonly claimId: number;
  readonly claimedMs: number;
  readonly notice: PendingNotice;
}

function toClaimed(row: ClaimRow): Claimed {
  return { claimId: row.claim_id, claimedMs: row.claimed_ms, notice: toPending(row) };
}

/** R2-3: record a route's send-now claim durably (folds included), retried at `dueMs` unless settled. Returns its id. */
export function writeClaimed(sql: SqlStorage, p: PendingNotice, claimedMs: number): number {
  return sql
    .exec<{ claim_id: number }>(
      `INSERT INTO claimed_notice (kind, count, first_event_ms, last_event_ms, last_country, list_was_empty, due_ms, attempts, claimed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING claim_id`,
      p.kind,
      p.count,
      p.firstEventMs,
      p.lastEventMs,
      p.lastCountry,
      p.listWasEmpty ? 1 : 0,
      p.dueMs,
      p.attempts,
      claimedMs,
    )
    .one().claim_id;
}

/** Take (read and delete) the claim `claimId`; null if it was settled already or the alarm recovered it. */
export function takeClaimed(sql: SqlStorage, claimId: number): Claimed | null {
  const row = sql.exec<ClaimRow>("SELECT * FROM claimed_notice WHERE claim_id = ?", claimId).toArray().at(0);
  if (row === undefined) return null;
  sql.exec("DELETE FROM claimed_notice WHERE claim_id = ?", claimId);
  return toClaimed(row);
}

/** Claims past their due time: routes cut off before they settled (R2-3). */
export function overdueClaims(sql: SqlStorage, nowMs: number): Claimed[] {
  return sql
    .exec<ClaimRow>("SELECT * FROM claimed_notice WHERE due_ms <= ? ORDER BY claim_id", nowMs)
    .toArray()
    .map(toClaimed);
}

export function sentTimes(sql: SqlStorage, kind: AccountNoticeKind, nowMs: number): number[] {
  return sql
    .exec<{ sent_ms: number }>("SELECT sent_ms FROM notices WHERE kind = ? AND sent_ms > ?", kind, nowMs - DAY_MS)
    .toArray()
    .map((r) => r.sent_ms);
}

export interface NoticeEvent {
  readonly atMs: number;
  readonly country: string | null;
  readonly listWasEmpty: boolean;
}

/** §4.4: send now (folding any pending notice in), or fold this event into the one pending notice. */
export function claimNoticeSync(
  sql: SqlStorage,
  kind: AccountNoticeKind,
  event: NoticeEvent,
  nowMs: number,
  notBeforeMs: number,
): NoticeClaimResult {
  const sent = sentTimes(sql, kind, nowMs);
  const pending = readPending(sql, kind);
  if (notBeforeMs <= nowMs && capAllows(sent, nowMs, kind)) {
    // R2-3: out of `pending_notice` and into `claimed_notice` in ONE transaction,
    // so a route cut off mid-send still leaves the notice (and its folds) on disk.
    sql.exec("DELETE FROM pending_notice WHERE kind = ?", kind);
    const claimId = writeClaimed(
      sql,
      {
        kind,
        count: (pending?.count ?? 0) + 1,
        firstEventMs: pending?.firstEventMs ?? event.atMs,
        lastEventMs: event.atMs,
        lastCountry: event.country,
        listWasEmpty: (pending?.listWasEmpty ?? false) || event.listWasEmpty,
        dueMs: nowMs + noticeRetryDelayMs(1),
        attempts: 0,
      },
      nowMs,
    );
    takeSlot(sql, kind, nowMs);
    const coalesced = pending === null ? null : { count: pending.count, sinceMs: pending.firstEventMs };
    return { send: "now", claimId, coalesced };
  }
  const dueMs = foldedDueMs(pending?.dueMs ?? null, notBeforeMs, capReopensAt(sent, nowMs, kind));
  writePending(sql, {
    kind,
    count: (pending?.count ?? 0) + 1,
    firstEventMs: pending?.firstEventMs ?? event.atMs,
    lastEventMs: event.atMs,
    lastCountry: event.country,
    listWasEmpty: (pending?.listWasEmpty ?? false) || event.listWasEmpty,
    dueMs,
    attempts: pending?.attempts ?? 0,
  });
  return { send: "deferred", dueMs };
}

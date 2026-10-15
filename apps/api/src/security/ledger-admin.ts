/**
 * The ledger's two admin reads (security-alerting spec §2.6 N6, F2), PR 3.
 * Synchronous over the ledger's SQLite.
 */
import {
  ADMIN_HELD_PAGE_SIZE,
  HELD_PRIORITY,
  SIGNAL_RULES,
  type AdminHeldRow,
  type AdminSecurityHeldResponse,
  type SecurityAlertSignal,
  type SignalClass,
} from "@thinkersjournal/shared";

import { renderSubject } from "./ledger-held";
import { newRef, REF_TTL_MS, type LedgerStore } from "./ledger-store";

type ListRow = {
  subject_key: string;
  signal: string;
  subject_kind: string;
  subject: string;
  events: number;
  suppressed: number;
  version: number;
};

/** Classes in the order `HELD_PRIORITY` first names them: account, stuffing, ip_burst, infra. */
export const HELD_CLASS_ORDER: readonly SignalClass[] = [
  ...new Set(
    HELD_PRIORITY.map((s) => SIGNAL_RULES.find((r) => r.signal === s)?.signalClass).filter(
      (c): c is SignalClass => c !== undefined,
    ),
  ),
];

/** The one freshness predicate for a ref (§2.6: 7 days from last use); lookup and listing both use it. */
const REF_FRESH_SQL = "last_used_ms >= ?";
const refFreshParam = (nowMs: number): number => nowMs - REF_TTL_MS;

/** The account a ref names, or null when unknown or unused for 7 days: the same answer for both (§2.6). */
export function resolveRefSync(store: LedgerStore, ref: string, nowMs: number): string | null {
  return (
    store.sql
      .exec<{ user_id: string }>(
        `SELECT user_id FROM account_refs WHERE ref = ? AND ${REF_FRESH_SQL}`,
        ref,
        refFreshParam(nowMs),
      )
      .toArray()[0]?.user_id ?? null
  );
}

/**
 * Listing is not a message (§2.6: a ref lives 7 days after the last MESSAGE that
 * named the account), so a FRESH ref is shown without refreshing it. A held
 * account with no ref, or whose ref has expired but is not yet pruned, gets a
 * new ref now (a stale ref is never shown: the lookup route would 404 it). The
 * stale row is rotated in place (user_id is the key), so the old ref stops
 * existing and its last_used is not extended.
 */
function refForListing(store: LedgerStore, userId: string, nowMs: number): string {
  const found = store.sql
    .exec<{ ref: string }>(`SELECT ref FROM account_refs WHERE user_id = ? AND ${REF_FRESH_SQL}`, userId, refFreshParam(nowMs))
    .toArray()[0];
  if (found !== undefined) return found.ref;
  const ref = newRef();
  store.sql.exec(
    `INSERT INTO account_refs (user_id, ref, last_used_ms) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET ref = excluded.ref, last_used_ms = excluded.last_used_ms`,
    userId,
    ref,
    nowMs,
  );
  return ref;
}

const PUBLIC_ACCOUNT_KEY = /^([a-z_]+)\|([0-9a-f]{32})$/;

/**
 * A stored account key is `signal|<user id>`; the page must never carry a user id
 * (R4: only the audited ref lookup reveals one), so an account row's public key is
 * `signal|<ref>` and the cursor is translated back to the stored key here. A ref
 * that no longer resolves (pruned between pages) yields null: comparing the raw
 * `signal|<ref>` string against `signal|<uuid>` keys would skip or repeat rows.
 */
function storedCursor(store: LedgerStore, after: string): string | null {
  const m = PUBLIC_ACCOUNT_KEY.exec(after);
  if (m === null) return after;
  const row = store.sql.exec<{ user_id: string }>("SELECT user_id FROM account_refs WHERE ref = ?", m[2] ?? "").toArray()[0];
  return row === undefined ? null : `${m[1] ?? ""}|${row.user_id}`;
}

/**
 * One page of a class's stored rows, `subject_key > after`, in key order (F2: the
 * cursor never moves). Null when an account cursor's ref can no longer be resolved.
 */
export function listHeldSync(
  store: LedgerStore,
  signalClass: SignalClass,
  after: string,
  nowMs: number,
): AdminSecurityHeldResponse | null {
  const cursor = storedCursor(store, after);
  if (cursor === null) return null;
  const rows = store.sql
    .exec<ListRow>(
      `SELECT subject_key, signal, subject_kind, subject, events, suppressed, version FROM held
       WHERE signal_class = ? AND subject_key > ? ORDER BY subject_key LIMIT ?`,
      signalClass,
      cursor,
      ADMIN_HELD_PAGE_SIZE,
    )
    .toArray();
  const w = store.watermark(signalClass);
  const listed: AdminHeldRow[] = rows.map((r) => {
    const signal = r.signal as SecurityAlertSignal;
    if (r.subject_kind !== "account") {
      return {
        subjectKey: r.subject_key,
        signal,
        subject: renderSubject(store, r.subject_kind, r.subject, nowMs),
        events: r.events,
        suppressed: r.suppressed,
        version: r.version,
        open: r.version > w,
      };
    }
    const ref = refForListing(store, r.subject, nowMs);
    return {
      subjectKey: `${r.signal}|${ref}`,
      signal,
      subject: { kind: "account", ref },
      events: r.events,
      suppressed: r.suppressed,
      version: r.version,
      open: r.version > w,
    };
  });
  const lastRow = listed.at(-1);
  return {
    signalClass,
    rows: listed,
    nextAfter: lastRow !== undefined && rows.length === ADMIN_HELD_PAGE_SIZE ? lastRow.subjectKey : null,
    classOrder: HELD_CLASS_ORDER,
  };
}

/**
 * The moderation notice OUTBOX drain and purge (notice outbox design, sections
 * 5-7; nothing here depends on the kind: the body is rendered at enqueue
 * time, in the decision's transaction, by notice-enqueue.ts).
 *
 * One pass per two-minute cron tick (index.ts `scheduled`):
 *   1. LEASE a bounded batch with ONE atomic conditional UPDATE ... RETURNING
 *      (`FOR UPDATE SKIP LOCKED`, so two overlapping passes can never take the
 *      same row). A row whose lease expired (a pass that died mid-send) is
 *      taken again. Same lease idea as email_drain_lock (0008): an OPAQUE
 *      per-pass token (`leased_by`) fences every write, so a pass whose lease
 *      lapsed cannot overwrite its successor's work.
 *   2. For each row: re-read the ACCOUNT recipient's address from `users`
 *      (an address change is honoured; an anonymised or vanished account is
 *      `undeliverable` with NO send), send via Postmark, then settle the row in
 *      ONE UPDATE that also releases the lease.
 *
 * ⚠️ DELIVERY IS AT-LEAST-ONCE. If the process dies, or the settling UPDATE
 * fails, after Postmark accepted a message, the row is sent again later.
 *
 * ⚠️ LOGS CARRY COUNTS BY STATE AND ERROR CLASSES ONLY. Never a body, title,
 * reason, address or user id: those are in the rows, not in the logs.
 * `last_error` is likewise a class.
 *
 * ⚠️ NEVER THROWS. This runs inside `ctx.waitUntil` from `scheduled()`, where a
 * rejection would silently skip the pass.
 */
import type { Client } from "pg";

import { classifyPostmark, type PostmarkOutcome } from "@thinkersjournal/shared";

import { postmarkSendOutcome } from "../auth/postmark";
import { withClient } from "../db/client";

/** Rows leased per pass. */
export const NOTICE_OUTBOX_BATCH = 25;
/** Longer than the 2-minute tick and than the budget below, so a live pass keeps its rows. */
export const NOTICE_LEASE_SECONDS = 300;
/** No NEW row is started after this long; the rest go back to pending. Postmark sends time out at 10 s each. */
export const NOTICE_DRAIN_BUDGET_MS = 200_000;
/** Caps one purge run's DELETE (same reasoning as NOTICE_RECORD_PURGE_BATCH). */
export const NOTICE_OUTBOX_PURGE_BATCH = 500;

/** Delay after the n-th failed attempt (n = 1..6): 2 m, 10 m, 1 h, 6 h, 24 h, 24 h. The 7th failure is final. */
export const NOTICE_BACKOFF_MS: readonly number[] = [120_000, 600_000, 3_600_000, 21_600_000, 86_400_000, 86_400_000];

/** What replaces a live link in the retained body once the notice is delivered. */
export const LINK_REMOVED_MARKER = "[link removed after delivery]";

/** Milliseconds to wait after the `failures`-th failed attempt, or `null` when that failure is the last. */
export function noticeRetryDelayMs(failures: number): number | null {
  if (failures < 1 || failures > NOTICE_BACKOFF_MS.length) return null;
  return NOTICE_BACKOFF_MS[failures - 1]!;
}

// The html body carries the link twice: as the href and as the anchor text.
const ANCHOR_WITH_LINK_RE = /<a href="[^"]*\/(?:appeal|account\/delete-request)\?token=[^"]*">[^<]*<\/a>/g;
const BARE_LINK_RE = /[^\s"'<>]*\/(?:appeal|account\/delete-request)\?token=[A-Za-z0-9_%~-]*/g;

/**
 * Replace every live appeal / delete-request link in a stored body (text or
 * html) with the marker, so a retained record never holds a live credential.
 * Pure. Applied in JS to the stored strings before the delivery UPDATE.
 */
export function stripLiveLinks(body: string): string {
  return body.replace(ANCHOR_WITH_LINK_RE, LINK_REMOVED_MARKER).replace(BARE_LINK_RE, LINK_REMOVED_MARKER);
}

export interface DrainCounts {
  leased: number;
  delivered: number;
  retried: number;
  undeliverable: number;
  /** Settling UPDATEs that matched no row (the lease had been taken over). */
  lost: number;
}

export interface DrainOptions {
  /**
   * Restrict the lease to these actions. ⚠️ A TEST SEAM: the test database is
   * shared between test files running in parallel, and an unrestricted drain
   * would send another file's rows. Production never passes it.
   * @internal
   */
  readonly onlyActionIds?: readonly string[];
}

interface LeasedRow {
  id: string;
  action_id: string;
  recipient_user_id: string | null;
  recipient_email: string | null;
  subject: string;
  body_text: string;
  body_html: string;
  attempts: number;
}

type Settlement =
  | { readonly kind: "delivered"; readonly bodyText: string; readonly bodyHtml: string }
  | { readonly kind: "retry"; readonly attempts: number; readonly delayMs: number; readonly error: string }
  | { readonly kind: "undeliverable"; readonly attempts: number; readonly error: string };

const LEASE_SQL = `
  -- MATERIALIZED: an inline WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED) can be
  -- re-evaluated by the planner under concurrent updates and lease MORE than n rows (seen in CI: 27 for
  -- a batch of 25). Picking the ids once, in a materialised CTE, keeps the batch bound.
  WITH picked AS MATERIALIZED (
    SELECT id FROM moderation_notice_outbox
     WHERE ((state = 'pending' AND next_attempt_at <= now())
         OR (state = 'sending' AND leased_until < now()))
       AND ($4::uuid[] IS NULL OR action_id = ANY($4::uuid[]))
     ORDER BY next_attempt_at
     LIMIT $1
       FOR UPDATE SKIP LOCKED
  )
  UPDATE moderation_notice_outbox o
     SET state = 'sending',
         leased_until = now() + make_interval(secs => $2::double precision),
         leased_by = $3,
         -- A lease that EXPIRED means the previous pass died mid-send: count it as a failed
         -- attempt, so a row that kills the worker every pass still reaches undeliverable.
         attempts = o.attempts + CASE WHEN o.state = 'sending' THEN 1 ELSE 0 END
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.id, o.action_id, o.recipient_user_id, o.recipient_email, o.subject, o.body_text, o.body_html, o.attempts`;

/** A log-safe class for a thrown value: never its message (a pg message can quote data). */
function errorClass(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  const name = err instanceof Error ? err.name : "unknown";
  return typeof code === "string" ? `${name}:${code}` : name;
}

/** A log-safe, address-free class for a refused send. */
function failureClass(outcome: Extract<PostmarkOutcome, { ok: false }>): string {
  if (outcome.status === null) return "transport";
  if (outcome.errorCode !== null && outcome.errorCode !== 0) return `postmark_${outcome.errorCode}`;
  return `http_${outcome.status}`;
}

function retryOrGiveUp(row: LeasedRow, error: string): Settlement {
  const failures = row.attempts + 1;
  const delayMs = noticeRetryDelayMs(failures);
  return delayMs === null
    ? { kind: "undeliverable", attempts: failures, error: `retries_exhausted:${error}` }
    : { kind: "retry", attempts: failures, delayMs, error };
}

/** Decide what to do with one leased row. Sends at most one email. */
async function attempt(env: Env, ctx: ExecutionContext, row: LeasedRow): Promise<Settlement> {
  let to: string;
  const userId = row.recipient_user_id;
  if (userId === null) {
    // A reporter: the address is stored on the row (and nulled once it is settled).
    if (row.recipient_email === null) return { kind: "undeliverable", attempts: row.attempts, error: "no_recipient" };
    to = row.recipient_email;
  } else {
    // An account: re-read the address NOW.
    const account = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
      const { rows } = await c.query<{ email: string; anonymised_at: Date | null }>(
        `SELECT email, anonymised_at FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0];
    });
    if (account === undefined) return { kind: "undeliverable", attempts: row.attempts, error: "recipient_gone" };
    // The sentinel address of an anonymised account must never reach Postmark.
    if (account.anonymised_at !== null) return { kind: "undeliverable", attempts: row.attempts, error: "recipient_anonymised" };
    to = account.email;
  }

  const outcome = await postmarkSendOutcome(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject: row.subject,
    textBody: row.body_text,
    htmlBody: row.body_html,
    // Not BROADCAST: a user cannot opt out of being told they were actioned.
    stream: "outbound",
  });
  if (outcome.ok) {
    return { kind: "delivered", bodyText: stripLiveLinks(row.body_text), bodyHtml: stripLiveLinks(row.body_html) };
  }
  // Postmark's per-recipient refusals (ErrorCode 300 / 406) no retry can fix. Design §6 says
  // "4xx recipient errors are permanent"; this is deliberately narrower: other 4xx codes
  // (401, 412) are ACCOUNT-level and a retry after the account is fixed succeeds;
  // everything else (timeouts, 429, 5xx, account-level codes) is transient.
  if (classifyPostmark(outcome) === "permanent") {
    return { kind: "undeliverable", attempts: row.attempts + 1, error: "recipient_refused" };
  }
  return retryOrGiveUp(row, failureClass(outcome));
}

/** Write the settlement and release the lease. Fenced on `leased_by`. Returns whether a row matched. */
async function settle(env: Env, ctx: ExecutionContext, row: LeasedRow, token: string, s: Settlement): Promise<boolean> {
  return await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
    let rowCount: number | null;
    if (s.kind === "delivered") {
      ({ rowCount } = await c.query(
        `UPDATE moderation_notice_outbox
            SET state = 'delivered', delivered_at = now(), body_text = $3, body_html = $4,
                recipient_email = NULL, last_error = NULL, leased_until = NULL, leased_by = NULL
          WHERE id = $1 AND leased_by = $2 AND state = 'sending'`,
        [row.id, token, s.bodyText, s.bodyHtml],
      ));
    } else if (s.kind === "retry") {
      ({ rowCount } = await c.query(
        `UPDATE moderation_notice_outbox
            SET state = 'pending', attempts = $3,
                next_attempt_at = now() + make_interval(secs => $4::double precision / 1000),
                last_error = $5, leased_until = NULL, leased_by = NULL
          WHERE id = $1 AND leased_by = $2 AND state = 'sending'`,
        [row.id, token, s.attempts, s.delayMs, s.error],
      ));
    } else {
      ({ rowCount } = await c.query(
        `UPDATE moderation_notice_outbox
            SET state = 'undeliverable', attempts = $3, last_error = $4,
                recipient_email = NULL, leased_until = NULL, leased_by = NULL
          WHERE id = $1 AND leased_by = $2 AND state = 'sending'`,
        [row.id, token, s.attempts, s.error],
      ));
    }
    return (rowCount ?? 0) === 1;
  });
}

export async function drainNoticeOutbox(env: Env, ctx: ExecutionContext, opts: DrainOptions = {}): Promise<DrainCounts> {
  const counts: DrainCounts = { leased: 0, delivered: 0, retried: 0, undeliverable: 0, lost: 0 };
  const token = crypto.randomUUID();
  let leasedAny = false;
  try {
    const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
      // A row whose lease expired after its final allowed attempt is finished, not re-leased.
      await c.query(
        `UPDATE moderation_notice_outbox
            SET state = 'undeliverable', last_error = 'retries_exhausted:lease_expired',
                recipient_email = NULL, leased_until = NULL, leased_by = NULL
          WHERE state = 'sending' AND leased_until < now() AND attempts >= $1
            AND ($2::uuid[] IS NULL OR action_id = ANY($2::uuid[]))`,
        [NOTICE_BACKOFF_MS.length, opts.onlyActionIds ?? null],
      );
      const res = await c.query<LeasedRow>(LEASE_SQL, [
        NOTICE_OUTBOX_BATCH,
        NOTICE_LEASE_SECONDS,
        token,
        opts.onlyActionIds ?? null,
      ]);
      return res.rows;
    });
    counts.leased = rows.length;
    leasedAny = rows.length > 0;

    const startedAt = Date.now();
    for (const row of rows) {
      if (Date.now() - startedAt > NOTICE_DRAIN_BUDGET_MS) break; // the rest are released below
      let settlement: Settlement;
      try {
        settlement = await attempt(env, ctx, row);
      } catch (err) {
        // A lookup or transport throw: count it as a failed attempt, so a row
        // that always throws still reaches `undeliverable`.
        settlement = retryOrGiveUp(row, `internal_${errorClass(err)}`);
      }
      try {
        if (await settle(env, ctx, row, token, settlement)) {
          if (settlement.kind === "delivered") counts.delivered++;
          else if (settlement.kind === "retry") counts.retried++;
          else counts.undeliverable++;
        } else {
          counts.lost++;
        }
      } catch (err) {
        // The row stays `sending`; the sweep below (or lease expiry) returns it.
        console.error("moderation notice outbox settle failed", { error: errorClass(err) });
      }
    }
  } catch (err) {
    console.error("moderation notice outbox drain failed", { error: errorClass(err) });
  } finally {
    if (leasedAny) {
      // Release anything this pass still holds (rows past the budget, or whose
      // settle threw). Fenced on OUR token, so a successor's lease is untouched.
      try {
        await withClient(env.HYPERDRIVE_FRESH, ctx, (c: Client) =>
          c.query(
            `UPDATE moderation_notice_outbox
                SET state = 'pending', leased_until = NULL, leased_by = NULL
              WHERE leased_by = $1 AND state = 'sending'`,
            [token],
          ),
        );
      } catch (err) {
        console.error("moderation notice outbox lease release failed", { error: errorClass(err) });
      }
      console.log("moderation notice outbox drain", counts);
    }
  }
  return counts;
}

/**
 * Delete outbox rows past `retain_until`. Run daily from scheduled() on
 * "30 3 * * *", beside `purgeExpiredNoticeRecords`. A bounded batch,
 * idempotent, count logged. Returns the count; never throws.
 */
export async function purgeExpiredNoticeOutbox(env: Env, ctx: ExecutionContext): Promise<number> {
  try {
    const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
      const { rowCount } = await c.query(
        `DELETE FROM moderation_notice_outbox WHERE id IN (
           SELECT id FROM moderation_notice_outbox
            WHERE retain_until < now()
            ORDER BY retain_until
            LIMIT $1
         )`,
        [NOTICE_OUTBOX_PURGE_BATCH],
      );
      return rowCount ?? 0;
    });
    if (n > 0) {
      console.log(`purge-moderation-notice-outbox: deleted ${n} row(s)`);
    }
    return n;
  } catch (err) {
    console.error("purge-moderation-notice-outbox failed", { error: errorClass(err) });
    return 0;
  }
}

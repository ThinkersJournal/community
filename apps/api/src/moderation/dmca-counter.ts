// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The counter-notice half of the DMCA flow (ROADMAP R9; policy docs/legal/
 * dmca-policy.md section 3): the author's counter-notice, its forwarding to the
 * claimant, the restore timer, and the two moderator records that stop or end it
 * (the claimant filed suit; the claimant withdrew).
 *
 * The restoration is an ORDINARY content ruling (`content_restore`, actor
 * `system` for the timer, via `applyDecisionInTx`) carrying `source =
 * 'dmca_notice'`, exactly as the takedown was a `content_remove`.
 *
 * ⚠️ THE TIMER NEVER OVERRIDES A HUMAN. It restores only when the takedown is the
 * LATEST human ruling on the material and the author's account holds no legal
 * hold; otherwise the notice is left as `withdrawn` (superseded) or untouched
 * (held) and a person decides.
 */
import type { Client } from "pg";

import { sha256Hex } from "../auth/encoding";
import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
import { afterContentDecision } from "./after-content-decision";
import { hasActiveAccountHold } from "./account-holds";
import { applyDecisionInTx, type DecisionResult } from "./decide";
import { DMCA_RESTORE_BUSINESS_DAYS } from "./dmca-decisions";
import { enqueueDmcaAuthorNotice, enqueueDmcaClaimantNotice } from "./notice-enqueue";
import {
  renderDmcaCounterToClaimant,
  renderDmcaRestoreToAuthor,
  renderDmcaRestoreToClaimant,
} from "./notify-dmca";
import { HUMAN_CONTENT_RULING_KINDS_SQL } from "./visibility-actions";

/** How long the counter-notice link works after the takedown. A placeholder for the attorney. */
export const DMCA_COUNTER_WINDOW_DAYS = 90;

/** Caps one cron run, as the other reapers do. */
const RESTORE_BATCH = 50;

/** `date` plus `n` weekdays. Weekends only: holidays are not modelled (the wait is a placeholder). */
export function addBusinessDays(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d;
}

async function rollback(c: Client): Promise<void> {
  try {
    await c.query("ROLLBACK");
  } catch (err) {
    // The connection may already be dead, so this must never replace the caller's root
    // error, but it is LOGGED: a transaction left open by a dying connection should leave
    // a trace. The class only, never the message (it could carry SQL text).
    console.error("DMCA counter-notice: ROLLBACK failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}

// ---- The author's counter-notice -------------------------------------------

/** What the counter-notice page shows before the author fills the form. */
export interface CounterTarget {
  readonly kind: "post" | "comment";
  readonly label: string;
}

const COUNTERABLE_SQL = `state = 'taken_down' AND counter_token_hash = $1
  AND decided_at > now() - make_interval(days => $2::int)`;

/** `null` for an unknown, used or expired token: all look the same. Read only. */
export async function peekCounterToken(c: Client, token: string): Promise<CounterTarget | null> {
  const { rows } = await c.query<{ target_kind: "post" | "comment"; target_label: string }>(
    `SELECT target_kind, target_label FROM dmca_notices WHERE ${COUNTERABLE_SQL}`,
    [await sha256Hex(token), DMCA_COUNTER_WINDOW_DAYS],
  );
  const row = rows[0];
  return row === undefined ? null : { kind: row.target_kind, label: row.target_label };
}

export interface CounterNoticeInput {
  readonly token: string;
  readonly authorName: string;
  readonly authorAddress: string;
  readonly authorPhone: string;
  readonly signature: string;
}

/**
 * File the counter-notice: store it, move the notice to `counter_received` with
 * the restore date, use up the token, and queue the forward to the claimant, in
 * ONE transaction. Returns `false` for a token that is unknown, used or expired.
 */
export async function fileCounterNotice(c: Client, input: CounterNoticeInput, now: Date = new Date()): Promise<boolean> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{
      id: string; target_kind: "post" | "comment"; target_label: string; complainant_email: string;
    }>(
      `SELECT id, target_kind, target_label, complainant_email FROM dmca_notices WHERE ${COUNTERABLE_SQL} FOR UPDATE`,
      [await sha256Hex(input.token), DMCA_COUNTER_WINDOW_DAYS],
    );
    const n = rows[0];
    if (n === undefined) {
      await rollback(c);
      return false;
    }
    const restoreAfter = addBusinessDays(now, DMCA_RESTORE_BUSINESS_DAYS);
    const { rows: counterRows } = await c.query<{ id: string }>(
      `INSERT INTO dmca_counter_notices
         (notice_id, author_name, author_address, author_phone, signature, statement_mistake, consent_jurisdiction)
       VALUES ($1, $2, $3, $4, $5, true, true) RETURNING id`,
      [n.id, input.authorName, input.authorAddress, input.authorPhone, input.signature],
    );
    await c.query(
      `UPDATE dmca_notices
          SET state = 'counter_received', counter_received_at = $2, restore_after = $3, counter_token_hash = NULL
        WHERE id = $1`,
      [n.id, now, restoreAfter],
    );
    // The counter-notice has no moderation action; its own id is the outbox key.
    await enqueueDmcaClaimantNotice(c, {
      actionId: counterRows[0]!.id,
      email: n.complainant_email,
      rendered: renderDmcaCounterToClaimant({
        subject: n.target_kind,
        label: n.target_label,
        counter: input,
        restoreAfter,
      }),
    });
    await c.query("COMMIT");
    return true;
  } catch (err) {
    await rollback(c);
    throw err;
  }
}

// ---- Moderator records ------------------------------------------------------

/** A standing takedown, or one waiting out the restore wait, for the admin page. */
export interface StandingTakedown {
  readonly id: string;
  readonly kind: "post" | "comment";
  readonly label: string;
  readonly complainantName: string;
  readonly state: "taken_down" | "counter_received";
  readonly decidedAt: Date;
  readonly counterReceivedAt: Date | null;
  readonly restoreAfter: Date | null;
  readonly claimantSuedAt: Date | null;
}

/** Bounded read; the newest first. */
export const STANDING_PAGE_SIZE = 200;

export async function listStandingTakedowns(c: Client): Promise<StandingTakedown[]> {
  const { rows } = await c.query<{
    id: string; target_kind: "post" | "comment"; target_label: string; complainant_name: string;
    state: "taken_down" | "counter_received"; decided_at: Date; counter_received_at: Date | null;
    restore_after: Date | null; claimant_sued_at: Date | null;
  }>(
    `SELECT id, target_kind, target_label, complainant_name, state, decided_at, counter_received_at,
            restore_after, claimant_sued_at
       FROM dmca_notices WHERE state IN ('taken_down','counter_received')
      ORDER BY (state = 'counter_received') DESC, decided_at DESC, id LIMIT $1`,
    [STANDING_PAGE_SIZE],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.target_kind,
    label: r.target_label,
    complainantName: r.complainant_name,
    state: r.state,
    decidedAt: r.decided_at,
    counterReceivedAt: r.counter_received_at,
    restoreAfter: r.restore_after,
    claimantSuedAt: r.claimant_sued_at,
  }));
}

/**
 * Record that the claimant told us they filed a court action: the timer no
 * longer restores this notice. `false` when the notice is not waiting out the
 * wait, or was already recorded.
 */
export async function recordClaimantSued(c: Client, noticeId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE dmca_notices SET claimant_sued_at = now()
      WHERE id = $1 AND state = 'counter_received' AND claimant_sued_at IS NULL`,
    [noticeId],
  );
  return (rowCount ?? 0) > 0;
}

// ---- Restoring ----------------------------------------------------------------

export type RestoreOutcome =
  | { readonly kind: "restored"; readonly result: DecisionResult; readonly subject: "post" | "comment" }
  /** Nothing to restore (material gone, or a later human ruling superseded the takedown); the notice is closed as `withdrawn`. */
  | { readonly kind: "closed" }
  /** Not eligible now (wrong state, suit recorded, or an account hold): nothing changed. */
  | { readonly kind: "skipped" };

export interface RestoreInput {
  readonly noticeId: string;
  readonly actorAdmin: string;
  readonly cause: "counter_notice" | "withdrawn";
  /**
   * The timer restores only a notice whose wait is over and with no suit
   * recorded; a moderator's `withdrawn` restore (the claimant withdrew) is
   * allowed from `taken_down` or `counter_received`, at once.
   */
  readonly timer: boolean;
}

interface RestorableNotice {
  id: string; state: string; target_kind: "post" | "comment"; post_id: string | null; comment_id: string | null;
  takedown_action_id: string | null; subject_user_id: string | null; complainant_email: string;
  restore_due: boolean; claimant_sued_at: Date | null;
}

async function lockRestorable(c: Client, noticeId: string): Promise<RestorableNotice | undefined> {
  const { rows } = await c.query<RestorableNotice>(
    `SELECT id, state, target_kind, post_id, comment_id, takedown_action_id, subject_user_id, complainant_email,
            (restore_after IS NOT NULL AND restore_after <= now()) AS restore_due, claimant_sued_at
       FROM dmca_notices WHERE id = $1 FOR UPDATE`,
    [noticeId],
  );
  return rows[0];
}

/** The timer needs the wait over and no suit; a moderator's withdrawal may act from either standing state. */
function eligibleToRestore(n: RestorableNotice, timer: boolean): boolean {
  return timer
    ? n.state === "counter_received" && n.restore_due && n.claimant_sued_at === null
    : n.state === "taken_down" || n.state === "counter_received";
}

/** Has a later HUMAN ruling replaced the takedown on this material? (A missing target counts as superseded.) */
async function takedownSuperseded(c: Client, n: RestorableNotice, subjectId: string | null): Promise<boolean> {
  if (subjectId === null) return true;
  const col = n.target_kind === "post" ? "post_id" : "comment_id";
  const { rows } = await c.query(
    `SELECT 1 FROM moderation_actions
      WHERE ${col} = $1 AND action IN (${HUMAN_CONTENT_RULING_KINDS_SQL})
        AND created_at > (SELECT created_at FROM moderation_actions WHERE id = $2)
      LIMIT 1`,
    [subjectId, n.takedown_action_id],
  );
  return rows.length > 0;
}

/** Nothing left to restore: close the notice as `withdrawn` and commit. */
async function closeAsWithdrawn(c: Client, noticeId: string): Promise<RestoreOutcome> {
  await c.query(`UPDATE dmca_notices SET state = 'withdrawn' WHERE id = $1`, [noticeId]);
  await c.query("COMMIT");
  return { kind: "closed" };
}

/** The two emails of a restoration, queued in its transaction (the author's is skipped when no one can receive it). */
async function queueRestoreNotices(
  c: Client,
  n: RestorableNotice,
  result: DecisionResult,
  cause: RestoreInput["cause"],
): Promise<void> {
  const body = { subject: n.target_kind, postTitle: result.postTitle, cause } as const;
  if (result.noticeSkip === null) {
    await enqueueDmcaAuthorNotice(c, {
      actionId: result.actionId,
      authorId: result.authorId,
      rendered: renderDmcaRestoreToAuthor(body),
    });
  }
  await enqueueDmcaClaimantNotice(c, {
    actionId: result.actionId,
    email: n.complainant_email,
    rendered: renderDmcaRestoreToClaimant(body),
  });
}

/** Restore the material for one notice, in one transaction. */
export async function restoreDmcaNotice(c: Client, input: RestoreInput): Promise<RestoreOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const n = await lockRestorable(c, input.noticeId);
    if (n === undefined || !eligibleToRestore(n, input.timer)) {
      await rollback(c);
      return { kind: "skipped" };
    }
    if (n.subject_user_id !== null && (await hasActiveAccountHold(c, n.subject_user_id))) {
      await rollback(c);
      return { kind: "skipped" };
    }
    const subjectId = n.target_kind === "post" ? n.post_id : n.comment_id;
    // The takedown must still be the latest HUMAN ruling on this material.
    if (subjectId === null || (await takedownSuperseded(c, n, subjectId))) return await closeAsWithdrawn(c, n.id);

    const result = await applyDecisionInTx(c, {
      subject: n.target_kind,
      subjectId,
      decision: "restore",
      reason:
        input.cause === "withdrawn"
          ? "Restored: the copyright notice was withdrawn."
          : "Restored after a DMCA counter-notice; no court action was filed in time.",
      actorAdmin: input.actorAdmin,
      dmcaNoticeId: n.id,
    });
    if (result === null) return await closeAsWithdrawn(c, n.id);

    await c.query(`UPDATE dmca_notices SET state = $2, restored_at = now() WHERE id = $1`, [
      n.id,
      input.cause === "withdrawn" ? "withdrawn" : "restored",
    ]);
    await queueRestoreNotices(c, n, result, input.cause);
    await c.query("COMMIT");
    return { kind: "restored", result, subject: n.target_kind };
  } catch (err) {
    await rollback(c);
    throw err;
  }
}

/**
 * The daily timer: restore every notice whose wait is over, no suit recorded.
 * Each is its own transaction, so one failure cannot hold up the rest; the cache
 * purge and media move follow each commit. Returns the number restored.
 */
export async function restoreDueDmcaNotices(env: Env, ctx: ExecutionContext): Promise<number> {
  const ids = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM dmca_notices
        WHERE state = 'counter_received' AND restore_after <= now() AND claimant_sued_at IS NULL
        ORDER BY restore_after LIMIT $1`,
      [RESTORE_BATCH],
    );
    return rows.map((r) => r.id);
  });
  let restored = 0;
  for (const id of ids) {
    try {
      const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        restoreDmcaNotice(c, { noticeId: id, actorAdmin: "system", cause: "counter_notice", timer: true }),
      );
      if (outcome.kind === "restored") {
        restored += 1;
        await afterContentDecision(env, ctx, { subject: outcome.subject, result: outcome.result });
      }
    } catch (err) {
      console.error("dmca restore failed", { noticeId: id, err });
    }
  }
  if (restored > 0) console.log(`restore-due-dmca-notices: restored ${restored} notice(s)`);
  return restored;
}


/**
 * THE ONE WAY a content decision is applied.
 *
 * ⚠️ THE VISIBILITY WRITE AND THE AUDIT APPEND SHARE ONE TRANSACTION. An audit
 * log that can disagree with the state it describes is worse than no audit log,
 * and this is the only place the two are written together. See R4 in the plan.
 *
 * ⚠️ NO SECOND VISIBILITY PREDICATE (AC-5). `hidden_at` is the only column that
 * governs visibility. "Removed, final" differs from "hidden pending review" by
 * the `content_remove` row in the audit log, NOT by a second column — a second
 * column would be one every public read must independently remember, and the
 * structural guard cannot enforce what it does not know about.
 *
 * Takes the caller's existing `pg.Client` and never opens its own connection,
 * matching actions.ts / auto-hide.ts / is-blocked.ts.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import type { ContractualGround, LegalGround } from "@thinkersjournal/shared";

import type { LegalHoldCategory } from "../media/legal-hold";

import { imposeAccountHoldInTx } from "./account-holds";
import { recordModerationAction, type ModerationActionKind, type ModerationSource, type ViolationCategory } from "./actions";
import { loadPostTagSlugs, type PurgeTarget } from "./purge-target";

export type DecisionKind = "restore" | "keep_hidden" | "remove";

export interface DecisionInput {
  readonly subject: "post" | "comment";
  readonly subjectId: string;
  readonly decision: DecisionKind;
  /** The statement of reasons (DSA). Shown to the author. */
  readonly reason: string;
  /** Access identity (email) of the acting human. */
  readonly actorAdmin: string;
  readonly violationCategory?: ViolationCategory;
  readonly internalNote?: string;
  /**
   * #57 Q3: the intended end of a TEMPORARY keep_hidden / remove. ⚠️ RECORDED
   * ONLY — no job un-hides at this time; the content stays hidden until a
   * moderator restores it. The route refuses it on a restore.
   */
  readonly actionExpiresAt?: Date;
  /** #57 Q5: the grounds cited. The route refuses both on a restore. */
  readonly legalGround?: LegalGround;
  readonly contractualGround?: ContractualGround;
  /** Spec §3 T1: the author's account is held in THIS SAME transaction. */
  readonly accountHold?: { readonly category: LegalHoldCategory };
}

export interface DecisionResult {
  readonly actionId: string;
  /** The post's or comment's own id — issue #61's media-visibility hook keys on this. */
  readonly subjectId: string;
  /** Whose content it was — Task 2 emails them. */
  readonly authorEmail: string;
  /** Same author, as an id — #113 plan B mints the appeal token against this, from the SAME row the decision just wrote. */
  readonly authorId: string;
  /** Visibility BEFORE the decision (RETURNING old.hidden_at). Picks the notice text. */
  readonly wasHidden: boolean;
  /** Visibility AFTER the decision. */
  readonly hidden: boolean;
  /** The post's title — for a comment, its parent post's title. Identifies the content in the notice. */
  readonly postTitle: string;
  /** Canonical ids for the cache purge (purgeTagsFor). */
  readonly purge: PurgeTarget;
  /** Every CONFIRMED, open DSA notice this ruling resolved — Task 4 emails each reporter. */
  readonly dsaReporters: readonly { email: string; noticeId: string }[];
  /**
   * Why the AUTHOR's notice must not be sent, or `null` when it should be
   * (#138, #135). Computed from the row THIS statement wrote, so it cannot
   * disagree with the decision it describes. The decision itself, its audit
   * row, the hold, the purge, the media move and the DSA reporters' outcome
   * emails are all unaffected: only the notice to the author is skipped.
   *
   * ⚠️ `author_anonymised` wins when both facts hold: `anonymised_at` is the
   * column the notification email drain already gates on, so there is one
   * definition of "this account is gone" — never the address's shape.
   */
  readonly noticeSkip: "author_anonymised" | "comment_deleted" | null;
}

const ACTION_FOR: Readonly<Record<DecisionKind, ModerationActionKind>> = {
  restore: "content_restore",
  keep_hidden: "content_keep_hidden",
  remove: "content_remove",
};

/**
 * ⚠️ `COALESCE(t.hidden_at, now())` for keep_hidden and remove, NOT `now()`.
 * An already-hidden item keeps its ORIGINAL hide timestamp, which is evidence of
 * when it was hidden; restamping destroys that and the destruction is invisible.
 * An item that reached review WITHOUT being auto-hidden (auto-hide is
 * threshold-based) becomes hidden now — otherwise the queue's most common case
 * would have no reachable outcome. See R2.
 */
const HIDDEN_AT_SQL: Readonly<Record<DecisionKind, string>> = {
  restore: "NULL",
  keep_hidden: "COALESCE(t.hidden_at, now())",
  remove: "COALESCE(t.hidden_at, now())",
};

/**
 * The decision itself, INSIDE a transaction the caller owns. Transaction-
 * NEUTRAL: no BEGIN, no COMMIT, no ROLLBACK, no try/catch — errors propagate
 * to whoever owns the transaction. `applyDecision` below wraps it for a
 * moderator's decision; `resolveAppeal` (appeals.ts) calls it inside the
 * appeal's own transaction (#113 plan B), so the restore, the
 * `appeal_granted` row and the appeal's resolution commit together.
 */
export async function applyDecisionInTx(c: Client, input: DecisionInput): Promise<DecisionResult | null> {
  let row:
    | {
        id: string; author_id: string; email: string; title: string; was_hidden: boolean; hidden: boolean;
        author_anonymised: boolean; tombstoned?: boolean; post_id?: string;
      }
    | undefined;

  if (input.subject === "post") {
    const { rows } = await c.query<{ id: string; author_id: string; email: string; title: string; was_hidden: boolean; hidden: boolean; author_anonymised: boolean }>(
      `UPDATE posts AS t
          SET hidden_at = ${HIDDEN_AT_SQL[input.decision]}
        FROM users u
       WHERE t.id = $1 AND u.id = t.author_id
       RETURNING t.id, t.author_id, u.email, t.title,
                 (old.hidden_at IS NOT NULL) AS was_hidden,
                 (t.hidden_at IS NOT NULL) AS hidden,
                 (u.anonymised_at IS NOT NULL) AS author_anonymised`,
      [input.subjectId],
    );
    row = rows[0];
  } else {
    const { rows } = await c.query<{
      id: string; author_id: string; email: string; title: string; was_hidden: boolean; hidden: boolean;
      author_anonymised: boolean; tombstoned: boolean; post_id: string;
    }>(
      `UPDATE comments AS t
          SET hidden_at = ${HIDDEN_AT_SQL[input.decision]}
        FROM users u, posts p
       WHERE t.id = $1 AND u.id = t.author_id AND p.id = t.post_id
       RETURNING t.id, t.author_id, t.post_id, u.email, p.title,
                 (old.hidden_at IS NOT NULL) AS was_hidden,
                 (t.hidden_at IS NOT NULL) AS hidden,
                 (u.anonymised_at IS NOT NULL) AS author_anonymised,
                 (t.deleted_at IS NOT NULL) AS tombstoned`,
      [input.subjectId],
    );
    row = rows[0];
  }

  // No such subject: append NO action row. An audit entry for content that
  // does not exist is a lie in the log. ⚠️ No ROLLBACK here: this function
  // does not own the transaction, and a ROLLBACK would END the caller's
  // transaction, so its later writes would autocommit outside it.
  if (row === undefined) return null;

  // #57 Q1 — WHAT PROMPTED THIS DECISION, derived BEFORE the action row is
  // appended (the new row would otherwise be its own "latest ruling") and
  // stored on that row. The confirmed notices are locked here and resolved by
  // id below, so the set that decides `source` is exactly the set resolved,
  // in the same transaction. (One statement cannot both resolve the notices
  // and be the source of the action id they must point at.)
  const targetCol = input.subject === "post" ? "post_id" : "comment_id";
  const { rows: noticeRows } = await c.query<{ id: string }>(
    `SELECT id FROM dsa_notices
      WHERE ${targetCol} = $1 AND email_verified_at IS NOT NULL AND resolved_at IS NULL
      ORDER BY created_at, id
        FOR UPDATE`,
    [row.id],
  );
  // ⚠️ "Unhandled member report" is queue.ts's own definition, not a new one: a
  // report is open when no content_* decision on the target is newer than it
  // (the queue's `ma.created_at > newest_report_at` test, applied per report).
  let source: ModerationSource;
  if (noticeRows.length > 0) {
    source = "dsa_notice";
  } else {
    const { rows } = await c.query<{ unhandled: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM reports r
          WHERE r.${targetCol} = $1
            AND NOT EXISTS (SELECT 1 FROM moderation_actions ma
                             WHERE ma.${targetCol} = r.${targetCol}
                               AND ma.action LIKE 'content\\_%'
                               AND ma.created_at > r.created_at)
       ) AS unhandled`,
      [row.id],
    );
    source = rows[0]!.unhandled ? "member_report" : "own_initiative";
  }

  const actionId = await recordModerationAction(c, {
    actorAdmin: input.actorAdmin,
    action: ACTION_FOR[input.decision],
    reason: input.reason,
    postId: input.subject === "post" ? row.id : undefined,
    commentId: input.subject === "comment" ? row.id : undefined,
    subjectUserId: row.author_id,
    subjectLabel: row.email,
    violationCategory: input.violationCategory,
    internalNote: input.internalNote,
    actionExpiresAt: input.actionExpiresAt,
    legalGround: input.legalGround,
    contractualGround: input.contractualGround,
    source,
    // Several notices resolved by one ruling: the OLDEST (lowest created_at) is
    // the one stored; every one is still linked from its own side
    // (`dsa_notices.resolution_action_id`).
    dsaNoticeId: noticeRows[0]?.id,
  });

  // DSA (spec §8): a ruling on this content answers every CONFIRMED, open
  // notice about it — in the same transaction as the ruling, so the notices
  // can never claim a resolution the log does not contain. Unconfirmed
  // notices are inert and stay so (they are reaped, never resolved).
  const { rows: dsaRows } = await c.query<{ id: string; reporter_email: string }>(
    `UPDATE dsa_notices SET resolved_at = now(), resolution_action_id = $2
      WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL
      RETURNING id, reporter_email`,
    [noticeRows.map((n) => n.id), actionId],
  );

  if (input.accountHold !== undefined) {
    // Spec §3 T1: the author's account is held in THE SAME transaction as the
    // decision — unlike the image hold, which stays post-commit and best-effort.
    await imposeAccountHoldInTx(c, {
      userId: row.author_id,
      category: input.accountHold.category,
      imposedBy: input.actorAdmin,
      reason: input.reason,
      moderationActionId: actionId,
    });
  }

  const purge: PurgeTarget =
    input.subject === "post"
      ? { kind: "post", postId: row.id, authorId: row.author_id, tagSlugs: await loadPostTagSlugs(c, row.id) }
      : { kind: "comment", postId: row.post_id! };

  return {
    actionId,
    subjectId: row.id,
    authorEmail: row.email,
    authorId: row.author_id,
    wasHidden: row.was_hidden,
    hidden: row.hidden,
    postTitle: row.title,
    purge,
    dsaReporters: dsaRows.map((r) => ({ email: r.reporter_email, noticeId: r.id })),
    noticeSkip: row.author_anonymised ? "author_anonymised" : row.tombstoned === true ? "comment_deleted" : null,
  };
}

export async function applyDecision(c: Client, input: DecisionInput): Promise<DecisionResult | null> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const result = await applyDecisionInTx(c, input);
    if (result === null) {
      // No such subject: commit nothing (applyDecisionInTx wrote nothing
      // either). ⚠️ Swallow a failed ROLLBACK here, exactly as before the
      // split: the connection may already be dead (BEGIN_BOUNDED_TX's
      // idle_in_transaction_session_timeout), and the true answer is still
      // "no such subject" — returning null, not throwing, is unchanged
      // behaviour.
      try {
        await c.query("ROLLBACK");
      } catch {
        // Deliberately swallowed.
      }
      return null;
    }
    await c.query("COMMIT");
    return result;
  } catch (err) {
    // ⚠️ THE ROLLBACK GETS ITS OWN try/catch SO IT CANNOT REPLACE THE ROOT
    // ERROR. If the connection is dead, ROLLBACK throws too and `throw err`
    // below would never run — the caller would see "connection terminated"
    // instead of whatever actually failed. Copied from signup.ts, which
    // documents the same reasoning, and it is not hypothetical here:
    // BEGIN_BOUNDED_TX sets `idle_in_transaction_session_timeout`, whose whole
    // job is to TERMINATE the backend connection (25P03) on this very
    // transaction primitive.
    try {
      await c.query("ROLLBACK");
    } catch {
      // Swallowed deliberately: the original error below is the useful one.
    }
    throw err;
  }
}

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
import { recordModerationAction, type ModerationActionKind, type ViolationCategory } from "./actions";
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
}

export interface DecisionResult {
  readonly actionId: string;
  /** Whose content it was — Task 2 emails them. */
  readonly authorEmail: string;
  /** Visibility BEFORE the decision (RETURNING old.hidden_at). Picks the notice text. */
  readonly wasHidden: boolean;
  /** Visibility AFTER the decision. */
  readonly hidden: boolean;
  /** The post's title — for a comment, its parent post's title. Identifies the content in the notice. */
  readonly postTitle: string;
  /** Canonical ids for the cache purge (purgeTagsFor). */
  readonly purge: import("./purge-target").PurgeTarget;
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

export async function applyDecision(
  c: Client,
  input: DecisionInput,
): Promise<DecisionResult | null> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    let row:
      | { id: string; author_id: string; email: string; title: string; was_hidden: boolean; hidden: boolean; post_id?: string }
      | undefined;

    if (input.subject === "post") {
      const { rows } = await c.query<{ id: string; author_id: string; email: string; title: string; was_hidden: boolean; hidden: boolean }>(
        `UPDATE posts AS t
            SET hidden_at = ${HIDDEN_AT_SQL[input.decision]}
          FROM users u
         WHERE t.id = $1 AND u.id = t.author_id
         RETURNING t.id, t.author_id, u.email, t.title,
                   (old.hidden_at IS NOT NULL) AS was_hidden,
                   (t.hidden_at IS NOT NULL) AS hidden`,
        [input.subjectId],
      );
      row = rows[0];
    } else {
      const { rows } = await c.query<{ id: string; author_id: string; email: string; title: string; was_hidden: boolean; hidden: boolean; post_id: string }>(
        `UPDATE comments AS t
            SET hidden_at = ${HIDDEN_AT_SQL[input.decision]}
          FROM users u, posts p
         WHERE t.id = $1 AND u.id = t.author_id AND p.id = t.post_id
         RETURNING t.id, t.author_id, t.post_id, u.email, p.title,
                   (old.hidden_at IS NOT NULL) AS was_hidden,
                   (t.hidden_at IS NOT NULL) AS hidden`,
        [input.subjectId],
      );
      row = rows[0];
    }

    if (row === undefined) {
      // No such subject: commit nothing, and append NO action row. An audit
      // entry for content that does not exist is a lie in the log.
      try {
        await c.query("ROLLBACK");
      } catch {
        // Same reasoning as the catch below: a failed ROLLBACK must not become
        // the caller's error when the real answer is "no such subject".
      }
      return null;
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
    });

    const purge: PurgeTarget =
      input.subject === "post"
        ? { kind: "post", postId: row.id, authorId: row.author_id, tagSlugs: await loadPostTagSlugs(c, row.id) }
        : { kind: "comment", postId: row.post_id! };

    await c.query("COMMIT");
    return {
      actionId,
      authorEmail: row.email,
      wasHidden: row.was_hidden,
      hidden: row.hidden,
      postTitle: row.title,
      purge,
    };
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

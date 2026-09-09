/**
 * THE ONE WAY a `moderation_actions` row is written.
 *
 * ⚠️ There is no update and no delete, by construction: the table carries a
 * database-level trigger that refuses both (migration 0013). This module
 * therefore exposes an INSERT and nothing else — if you find yourself wanting
 * to "correct" a row, the correct act is to append a new one.
 *
 * Takes the caller's existing `pg.Client` and never opens its own connection,
 * matching `auto-hide.ts` and `is-blocked.ts`.
 */
import type { Client } from "pg";

export type ModerationActionKind =
  | "content_restore" | "content_keep_hidden" | "content_remove"
  | "user_warn" | "user_suspend" | "user_ban" | "user_terminate"
  | "appeal_granted" | "appeal_denied";

export type ViolationCategory =
  | "spam" | "harassment" | "hate" | "sexual" | "violence" | "ip_infringement" | "other";

export interface ModerationActionInput {
  /** Access identity (email) of the acting human, or "system" for automation. */
  readonly actorAdmin: string;
  readonly action: ModerationActionKind;
  /** The statement of reasons (DSA). Shown to the user. */
  readonly reason: string;
  readonly postId?: string;
  readonly commentId?: string;
  readonly subjectUserId?: string;
  /** Denormalized identity captured at action time; the log must stay readable after deletion. */
  readonly subjectLabel?: string;
  readonly violationCategory?: ViolationCategory;
  readonly actionExpiresAt?: Date;
  /** Never shown to the user. */
  readonly internalNote?: string;
}

export async function recordModerationAction(
  c: Client,
  input: ModerationActionInput,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO moderation_actions
       (actor_admin, action, post_id, comment_id, subject_user_id, subject_label,
        violation_category, action_expires_at, reason, internal_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.actorAdmin,
      input.action,
      input.postId ?? null,
      input.commentId ?? null,
      input.subjectUserId ?? null,
      input.subjectLabel ?? null,
      input.violationCategory ?? null,
      input.actionExpiresAt ?? null,
      input.reason,
      input.internalNote ?? null,
    ],
  );
  return rows[0]!.id;
}

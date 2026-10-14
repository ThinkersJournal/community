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

import type { ContractualGround, LegalGround } from "@thinkersjournal/shared";

export type ModerationActionKind =
  | "content_restore" | "content_keep_hidden" | "content_remove"
  | "user_warn" | "user_suspend" | "user_ban" | "user_terminate"
  | "appeal_granted" | "appeal_denied"
  // #61 — every privileged fetch of restricted/legally-held media, logged to
  // this SAME append-only table rather than a bespoke one (CireSnave's ruling).
  | "media_access"
  // #61 follow-up — an author hiding/unhiding their OWN post. See
  // src/moderation/author-hide.ts's header for why `actor_admin` holds the
  // author's own email here rather than an Access identity.
  | "author_hide" | "author_unhide"
  // Account legal holds (account-legal-hold spec §3 T3, migration 0022).
  | "account_hold" | "account_hold_release";

export type ViolationCategory =
  | "spam" | "harassment" | "hate" | "sexual" | "violence" | "ip_infringement" | "other";

/** What prompted a content decision (#57 Art. 17; migration 0029). Never sent to the author. */
export type ModerationSource = "dsa_notice" | "member_report" | "own_initiative";

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
  /**
   * The intended end of the action. ⚠️ For a CONTENT decision this only RECORDS
   * the expiry: no job un-hides at that time (#57). user_suspend uses it as before.
   */
  readonly actionExpiresAt?: Date;
  /** #57 — what prompted a content decision. Omit for every other kind of row. */
  readonly source?: ModerationSource;
  /** #57 — the DSA notice answered; only with `source: "dsa_notice"` (a CHECK enforces it). */
  readonly dsaNoticeId?: string;
  /** #57 Q5 - the legal ground cited (migration 0031; a CHECK enforces the list). */
  readonly legalGround?: LegalGround;
  /** #57 Q5 - the contractual (Terms / Guidelines) ground cited (migration 0031). */
  readonly contractualGround?: ContractualGround;
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
        violation_category, action_expires_at, reason, internal_note,
        source, dsa_notice_id, legal_ground, contractual_ground)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      input.source ?? null,
      input.dsaNoticeId ?? null,
      input.legalGround ?? null,
      input.contractualGround ?? null,
    ],
  );
  return rows[0]!.id;
}

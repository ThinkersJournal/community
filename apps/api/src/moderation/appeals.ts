import type { Client } from "pg";

import { releaseReservedEmail } from "../auth/reserved-email";
import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction } from "./actions";
import { applyDecisionInTx, type DecisionResult } from "./decide";

import {
  APPEAL_WINDOW_DAYS,
  APPEALABLE_ACTIONS,
  sameAdminHand,
  type AdminAppeal,
  type AppealTarget,
  type AppealableAction,
} from "@thinkersjournal/shared";

export type FileAppealOutcome =
  | { readonly kind: "filed"; readonly appealId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_appealable" }
  | { readonly kind: "window_closed" }
  | { readonly kind: "exists" };

interface ActionRow {
  id: string;
  action: string;
  reason: string;
  created_at: Date;
  subject_user_id: string | null;
  in_window: boolean;
  appealed: boolean;
}

async function loadAction(c: Client, actionId: string): Promise<ActionRow | null> {
  const { rows } = await c.query<ActionRow>(
    `SELECT ma.id, ma.action, ma.reason, ma.created_at, ma.subject_user_id,
            ma.created_at > now() - make_interval(days => $2::int) AS in_window,
            EXISTS (SELECT 1 FROM appeals a WHERE a.action_id = ma.id) AS appealed
       FROM moderation_actions ma WHERE ma.id = $1`,
    [actionId, APPEAL_WINDOW_DAYS],
  );
  return rows[0] ?? null;
}

const isAppealable = (a: string): a is AppealableAction => (APPEALABLE_ACTIONS as readonly string[]).includes(a);

/** For the appeal page. `null` when the action does not exist or is not appealable. */
export async function describeAppealTarget(c: Client, actionId: string): Promise<AppealTarget | null> {
  const a = await loadAction(c, actionId);
  if (a === null || !isAppealable(a.action)) return null;
  return {
    actionId: a.id,
    action: a.action,
    reason: a.reason,
    createdAt: a.created_at.toISOString(),
    alreadyAppealed: a.appealed,
    windowClosesAt: new Date(a.created_at.getTime() + APPEAL_WINDOW_DAYS * 24 * 3600_000).toISOString(),
  };
}

/**
 * ⚠️ `appellantId` MUST equal the action's subject. The token path proves that
 * by the token's own user_id, and the session path by the session. Either way
 * the check lives HERE, once.
 *
 * ⚠️ B3: the INSERT re-checks `anonymised_at IS NULL` against the appellant's
 * users row IN THE SAME STATEMENT, under `FOR KEY SHARE` (the createResetToken
 * shape), so an appeal is never filed for a deleted account, on either path.
 */
export async function fileAppeal(
  c: Client,
  input: { readonly actionId: string; readonly appellantId: string; readonly body: string },
): Promise<FileAppealOutcome> {
  const a = await loadAction(c, input.actionId);
  if (a === null || a.subject_user_id !== input.appellantId) return { kind: "not_found" };
  if (!isAppealable(a.action)) return { kind: "not_appealable" };
  if (!a.in_window) return { kind: "window_closed" };
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO appeals (appellant_id, action_id, body)
     SELECT u.id, $2::uuid, $3::text FROM users u
      WHERE u.id = $1 AND u.anonymised_at IS NULL
        FOR KEY SHARE
     ON CONFLICT ON CONSTRAINT appeals_one_per_action DO NOTHING
     RETURNING id`,
    [input.appellantId, input.actionId, input.body],
  );
  if (rows[0] !== undefined) return { kind: "filed", appealId: rows[0].id };
  // Nothing inserted: either the action already has an appeal, or the
  // appellant is anonymised. A NEW statement, so it sees a conflicting row
  // that committed while the INSERT waited on it.
  const { rows: existing } = await c.query(`SELECT 1 FROM appeals WHERE action_id = $1`, [input.actionId]);
  return existing.length > 0 ? { kind: "exists" } : { kind: "not_found" };
}

export type ResolveOutcome =
  | {
      readonly kind: "resolved";
      readonly outcome: "granted" | "denied";
      readonly resolutionActionId: string;
      readonly appellantId: string;
      readonly sameReviewer: boolean;
      readonly content: DecisionResult | null;
      readonly subject: "post" | "comment" | null;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_resolved" }
  | { readonly kind: "terminated" }
  | { readonly kind: "content_gone" }
  | { readonly kind: "superseded" };

interface AppealRow {
  appellant_id: string;
  resolved_at: Date | null;
  action_id: string;
  action: string;
  actor_admin: string;
  post_id: string | null;
  comment_id: string | null;
  subject_user_id: string | null;
  /** The subject's CURRENT handle. ⚠️ Never ma.subject_label: a content action's label is the author's email. */
  subject_handle: string | null;
}

export async function resolveAppeal(
  c: Client,
  input: { readonly appealId: string; readonly grant: boolean; readonly reason: string; readonly actorAdmin: string },
): Promise<ResolveOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<AppealRow>(
      `SELECT a.appellant_id, a.resolved_at, ma.id AS action_id, ma.action, ma.actor_admin,
              ma.post_id, ma.comment_id, ma.subject_user_id, p.username AS subject_handle
         FROM appeals a
         JOIN moderation_actions ma ON ma.id = a.action_id
         LEFT JOIN profiles p ON p.user_id = ma.subject_user_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [input.appealId],
    );
    const ap = rows[0];
    if (ap === undefined) return await rollback(c, { kind: "not_found" });
    if (ap.resolved_at !== null) return await rollback(c, { kind: "already_resolved" });

    let content: DecisionResult | null = null;
    let subject: "post" | "comment" | null = null;
    if (input.grant) {
      switch (ap.action) {
        case "content_keep_hidden":
        case "content_remove": {
          subject = ap.post_id !== null ? "post" : "comment";
          const targetId = (ap.post_id ?? ap.comment_id)!;
          // ⚠️ D1 — A STALE APPEAL NEVER OVERRIDES A NEWER DECISION. If a
          // later content_* decision on the same post/comment replaced the
          // appealed one (e.g. remove A → restore → keep_hidden B), granting
          // A must not restore over B: refuse, and roll back. A deny is still
          // allowed (it changes no state). LOCK, THEN CHECK (the F1 shape):
          // the target row is locked FOR UPDATE first, which is the lock
          // decide.ts's UPDATE takes, so a moderator decision committing
          // concurrently is seen by the check below, a NEW statement.
          await c.query(`SELECT 1 FROM ${subject === "post" ? "posts" : "comments"} WHERE id = $1 FOR UPDATE`, [targetId]);
          const { rowCount: newer } = await c.query(
            `SELECT 1 FROM moderation_actions n
               JOIN moderation_actions ma ON ma.id = $2
              WHERE n.${subject === "post" ? "post_id" : "comment_id"} = $1
                AND n.action LIKE 'content\\_%'
                AND (n.created_at, n.id) > (ma.created_at, ma.id)
              LIMIT 1`,
            [targetId, ap.action_id],
          );
          if ((newer ?? 0) > 0) return await rollback(c, { kind: "superseded" });
          // ⚠️ Task 4 carry: the restore writes a `content_restore` row
          // (decide.ts's ACTION_FOR), and that row is what closes the appealed
          // decision for GET /appeals/for-post: its "latest content_* row" is
          // now the restore, so a later re-hide with no new decision offers
          // nothing to appeal.
          content = await applyDecisionInTx(c, {
            subject,
            subjectId: targetId,
            decision: "restore",
            reason: input.reason,
            actorAdmin: input.actorAdmin,
            internalNote: `appeal ${input.appealId} granted`,
          });
          // The content no longer exists (e.g. its author deleted the post):
          // there is nothing to restore, so the grant cannot be applied.
          // applyDecisionInTx wrote nothing; roll back cleanly.
          if (content === null) return await rollback(c, { kind: "content_gone" });
          break;
        }
        case "user_warn":
          break;
        case "user_ban": {
          // ⚠️ Review Focus 5 — never lift a termination through a ban's appeal.
          const { rowCount } = await c.query(
            `UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1 AND disabled_reason IS DISTINCT FROM 'terminate'`,
            [ap.subject_user_id],
          );
          if ((rowCount ?? 0) === 0) return await rollback(c, { kind: "terminated" });
          // Board item 93 / PM ruling B (account-legal-hold spec §4a): a banned
          // account deleted while banned reserves its address by hash
          // (users.reserved_email_hmac, or the legacy reserved_email_sha256).
          // Now the ban is lifted, the reservation ends; releaseReservedEmail
          // clears both columns. A no-op for an account that was never
          // anonymised (nothing reserved).
          await releaseReservedEmail(c, ap.subject_user_id!);
          break;
        }
        case "user_suspend": {
          // ⚠️ Review Focus 4 — recompute from the suspensions still standing:
          // every OTHER user_suspend on this user whose appeal was not granted,
          // and whose OWN end (action_expires_at, ruling B2) is still in the
          // future. Never just NULL it, and never trust the old GREATEST.
          //
          // ⚠️ LOCK, THEN RECOMPUTE IN A NEW STATEMENT (F1) — the scrubOne
          // precedent (auth/anonymise-accounts.ts, "LOCK, THEN RE-CHECK").
          // A lone UPDATE takes its snapshot BEFORE it waits on the row lock,
          // and READ COMMITTED re-reads only the target row, not the
          // subquery: a suspension applied, or another appeal granted, while
          // it waited would be invisible, so the bar could be EXTENDED (two
          // concurrent grants) or a new suspension DROPPED. applyAccountAction
          // locks this row FOR UPDATE first too, so this serialises against
          // new suspensions as well as against other grants.
          //
          // ⚠️ The appeal under resolution is still UNRESOLVED here: it is
          // excluded by `ma.id <> $2`, not by its outcome. Do not move the
          // `UPDATE appeals` below above this branch.
          await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [ap.subject_user_id]);
          await c.query(
            `UPDATE users SET suspended_until = (
               SELECT max(ma.action_expires_at) FROM moderation_actions ma
                WHERE ma.subject_user_id = $1 AND ma.action = 'user_suspend' AND ma.id <> $2
                  AND ma.action_expires_at > now()
                  AND NOT EXISTS (SELECT 1 FROM appeals a2 WHERE a2.action_id = ma.id AND a2.outcome = 'granted'))
             WHERE id = $1`,
            [ap.subject_user_id, ap.action_id],
          );
          break;
        }
      }
    }

    const resolutionActionId = await recordModerationAction(c, {
      actorAdmin: input.actorAdmin,
      action: input.grant ? "appeal_granted" : "appeal_denied",
      reason: input.reason,
      postId: ap.post_id ?? undefined,
      commentId: ap.comment_id ?? undefined,
      subjectUserId: ap.subject_user_id ?? undefined,
      // The HANDLE, or nothing. Never ma.subject_label (an email for content actions).
      subjectLabel: ap.subject_handle ?? undefined,
      internalNote: `appeal ${input.appealId} of action ${ap.action_id}`,
    });
    await c.query(`UPDATE appeals SET resolved_at = now(), outcome = $2, resolution_action_id = $3 WHERE id = $1`, [
      input.appealId,
      input.grant ? "granted" : "denied",
      resolutionActionId,
    ]);
    await c.query("COMMIT");
    return {
      kind: "resolved",
      outcome: input.grant ? "granted" : "denied",
      resolutionActionId,
      appellantId: ap.appellant_id,
      // Spec decision #8's hedge, made checkable, with the one definition of
      // "the same moderator" (packages/shared). Reported, never refused.
      sameReviewer: sameAdminHand(ap.actor_admin, input.actorAdmin),
      content,
      subject,
    };
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // keep the root error
    }
    throw err;
  }
}

async function rollback<T>(c: Client, value: T): Promise<T> {
  try {
    await c.query("ROLLBACK");
  } catch {
    // nothing to keep
  }
  return value;
}

/**
 * At most this many open appeals per read, oldest first — the same bounded
 * read as queue.ts's QUEUE_PAGE_SIZE. Resolving one makes room for the next.
 */
export const APPEALS_PAGE_SIZE = 200;

/** For the admin list: every open appeal (up to APPEALS_PAGE_SIZE), oldest first, in its wire shape. */
export async function listOpenAppeals(c: Client): Promise<AdminAppeal[]> {
  const { rows } = await c.query<{
    id: string;
    body: string;
    created_at: Date;
    action_id: string;
    action: AppealableAction;
    action_reason: string;
    action_actor: string;
    appellant_handle: string | null;
    subject: "post" | "comment" | "account";
    target_id: string | null;
  }>(
    `SELECT a.id, a.body, a.created_at, ma.id AS action_id, ma.action, ma.reason AS action_reason,
            ma.actor_admin AS action_actor, p.username AS appellant_handle,
            CASE WHEN ma.post_id IS NOT NULL THEN 'post'
                 WHEN ma.comment_id IS NOT NULL THEN 'comment'
                 ELSE 'account' END AS subject,
            COALESCE(ma.post_id, ma.comment_id, ma.subject_user_id) AS target_id
       FROM appeals a
       JOIN moderation_actions ma ON ma.id = a.action_id
       LEFT JOIN profiles p ON p.user_id = a.appellant_id
      WHERE a.resolved_at IS NULL ORDER BY a.created_at, a.id
      LIMIT $1`,
    [APPEALS_PAGE_SIZE],
  );
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.created_at.toISOString(),
    actionId: r.action_id,
    action: r.action,
    actionReason: r.action_reason,
    actionActor: r.action_actor,
    appellantHandle: r.appellant_handle,
    subject: r.subject,
    targetId: r.target_id,
  }));
}

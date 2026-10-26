// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * A moderator's decision on a confirmed DMCA notice (ROADMAP R9; design note
 * docs/superpowers/specs/2026-10-25-dmca-flow-design.md): take the material down,
 * or reject the notice. Nothing here runs without a human: AC-1 holds, and a
 * notice that nobody decides hides nothing.
 *
 * A takedown is an ORDINARY content ruling (`content_remove`, via
 * `applyDecisionInTx`) that says what prompted it (`source = 'dmca_notice'`, the
 * notice id on the row). Reusing the ruling is deliberate: the visibility readers,
 * the appeal path, the cache purge and the media hook all key on `content_remove`
 * and need no change. What this module adds is the notice's own lifecycle, the
 * two emails, and the counter-notice credential, all in ONE transaction: a
 * takedown that cannot be announced rolls back, as a moderation decision does.
 *
 * The listing reads hidden rows on purpose (the same reasoning as
 * `listOpenDsaNotices`): it is reachable only through `requireAdmin`.
 */
import type { Client } from "pg";

import { base64urlEncode, sha256Hex } from "../auth/encoding";
import { BEGIN_BOUNDED_TX } from "../db/client";
import { applyDecisionInTx, type DecisionResult } from "./decide";
import { enqueueDmcaAuthorNotice, enqueueDmcaClaimantNotice } from "./notice-enqueue";
import { standingStrikeSql, strikesFrom } from "./dmca-strikes";
import { renderDmcaAuthorNotice, renderDmcaClaimantOutcome } from "./notify-dmca";

/** The restore wait named to the author, in business days. A placeholder for the attorney (policy: 10-14). */
export const DMCA_RESTORE_BUSINESS_DAYS = 10;

/** A row in `GET /admin/dmca-notices` (before the JSON round-trip). */
export interface OpenDmcaNotice {
  readonly id: string;
  readonly kind: "post" | "comment";
  readonly targetId: string | null;
  readonly excerpt: string;
  readonly contentDeleted: boolean;
  readonly workDescription: string;
  readonly complainantName: string;
  readonly complainantEmail: string;
  readonly complainantAddress: string;
  readonly complainantPhone: string;
  readonly signature: string;
  readonly createdAt: Date;
  readonly authorStrikes: number;
  readonly authorFlagged: boolean;
}

/**
 * Every CONFIRMED notice still `pending`, oldest first. LEFT JOIN: a notice whose
 * target was deleted still appears (a human may reject it). `authorStrikes` counts
 * the author's takedowns that stand inside the strike window (dmca-strikes.ts:
 * `taken_down` or `counter_received`; a restored, withdrawn or rejected one does
 * not count), and `authorFlagged` says that count has reached the threshold.
 */
export async function listOpenDmcaNotices(c: Client): Promise<OpenDmcaNotice[]> {
  const { rows } = await c.query<{
    id: string; kind: "post" | "comment"; target_id: string | null; excerpt: string; content_deleted: boolean;
    work_description: string; complainant_name: string; complainant_email: string; complainant_address: string;
    complainant_phone: string; signature: string; created_at: Date; author_strikes: string;
  }>(
    `SELECT n.id, n.target_kind AS kind,
            COALESCE(p.id, cm.id) AS target_id,
            CASE WHEN n.target_kind = 'post' THEN COALESCE(p.title, n.target_label)
                 ELSE COALESCE(NULLIF(left(cm.body_markdown, 120), ''), n.target_label) END AS excerpt,
            CASE WHEN n.target_kind = 'post' THEN (p.id IS NULL)
                 ELSE (cm.id IS NULL OR cm.deleted_at IS NOT NULL) END AS content_deleted,
            n.work_description, n.complainant_name, n.complainant_email, n.complainant_address,
            n.complainant_phone, n.signature, n.created_at,
            (SELECT count(*) FROM dmca_notices s
              WHERE s.subject_user_id = COALESCE(p.author_id, cm.author_id)
                AND ${standingStrikeSql("s")}) AS author_strikes
       FROM dmca_notices n
       LEFT JOIN posts p ON p.id = n.post_id
       LEFT JOIN comments cm ON cm.id = n.comment_id
      WHERE n.email_verified_at IS NOT NULL AND n.state = 'pending'
      ORDER BY n.created_at ASC, n.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    targetId: r.target_id,
    excerpt: r.excerpt,
    contentDeleted: r.content_deleted,
    workDescription: r.work_description,
    complainantName: r.complainant_name,
    complainantEmail: r.complainant_email,
    complainantAddress: r.complainant_address,
    complainantPhone: r.complainant_phone,
    signature: r.signature,
    createdAt: r.created_at,
    authorStrikes: Number(r.author_strikes),
    authorFlagged: strikesFrom(Number(r.author_strikes)).flagged,
  }));
}

export type DmcaRefusal =
  | { readonly kind: "not_found" }
  /** Unconfirmed, or already decided. */
  | { readonly kind: "not_pending" }
  /** Takedown only: the material is gone, so there is nothing to take down. Reject it instead. */
  | { readonly kind: "target_gone" };

export type DmcaDecisionOutcome<T> = { readonly kind: "ok"; readonly value: T } | DmcaRefusal;

interface LockedNotice {
  id: string;
  state: string;
  email_verified_at: Date | null;
  target_kind: "post" | "comment";
  post_id: string | null;
  comment_id: string | null;
  complainant_email: string;
  complainant_name: string;
  complainant_address: string;
  complainant_phone: string;
  work_description: string;
  signature: string;
  created_at: Date;
  target_label: string;
}

async function lockNotice(c: Client, noticeId: string): Promise<LockedNotice | undefined> {
  const { rows } = await c.query<LockedNotice>(
    `SELECT id, state, email_verified_at, target_kind, post_id, comment_id, complainant_email, complainant_name,
            complainant_address, complainant_phone, work_description, signature, created_at, target_label
       FROM dmca_notices WHERE id = $1 FOR UPDATE`,
    [noticeId],
  );
  return rows[0];
}

async function rollback(c: Client): Promise<void> {
  try {
    await c.query("ROLLBACK");
  } catch (err) {
    // The connection may already be dead (BEGIN_BOUNDED_TX's idle timeout), so this must
    // never replace the caller's root error, but it is LOGGED: a transaction left open by a
    // dying connection should leave a trace. The class only, never the message (it could
    // carry SQL text).
    console.error("DMCA decision: ROLLBACK failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}

/**
 * The two emails of a takedown, queued in the takedown's transaction: the author's (with a
 * copy of the notice and the counter-notice link; skipped when no one can receive it, in
 * which case the token hash stored on the notice is useless without the raw token) and the
 * claimant's, who is owed an answer whatever became of the author's account.
 */
async function queueTakedownNotices(
  c: Client,
  n: LockedNotice,
  result: DecisionResult,
  counterToken: string,
  origin: string,
): Promise<void> {
  if (result.noticeSkip === null) {
    await enqueueDmcaAuthorNotice(c, {
      actionId: result.actionId,
      authorId: result.authorId,
      rendered: renderDmcaAuthorNotice({
        subject: n.target_kind,
        postTitle: result.postTitle,
        notice: {
          complainantName: n.complainant_name,
          complainantEmail: n.complainant_email,
          complainantAddress: n.complainant_address,
          complainantPhone: n.complainant_phone,
          workDescription: n.work_description,
          signature: n.signature,
          sentAt: n.created_at,
        },
        counterUrl: `${origin}/dmca/counter?token=${encodeURIComponent(counterToken)}`,
        restoreBusinessDays: DMCA_RESTORE_BUSINESS_DAYS,
      }),
    });
  }
  // The claimant is owed an answer whatever became of the author's account.
  await enqueueDmcaClaimantNotice(c, {
    actionId: result.actionId,
    email: n.complainant_email,
    rendered: renderDmcaClaimantOutcome({ outcome: "taken_down", subject: n.target_kind, postTitle: result.postTitle }),
  });
}

export interface TakedownInput {
  readonly noticeId: string;
  /** Access identity (email) of the acting moderator. */
  readonly actorAdmin: string;
  /** The verification-link origin of the request (`verificationLinkOrigin`), for the counter-notice link. */
  readonly origin: string;
}

/**
 * Take the material down: the `content_remove` ruling, the notice's move to
 * `taken_down`, the author's notice (with the counter-notice link) and the
 * claimant's outcome, in ONE transaction. Returns the ruling's `DecisionResult`
 * so the caller runs `afterContentDecision` (cache purge, media move) after the
 * commit.
 */
export async function takedownDmcaNotice(
  c: Client,
  input: TakedownInput,
): Promise<DmcaDecisionOutcome<{ result: DecisionResult; subject: "post" | "comment" }>> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const n = await lockNotice(c, input.noticeId);
    if (n === undefined) return await done(c, { kind: "not_found" });
    if (n.email_verified_at === null || n.state !== "pending") return await done(c, { kind: "not_pending" });
    const subjectId = n.target_kind === "post" ? n.post_id : n.comment_id;
    if (subjectId === null) return await done(c, { kind: "target_gone" });

    const result = await applyDecisionInTx(c, {
      subject: n.target_kind,
      subjectId,
      decision: "remove",
      reason: "Removed after a copyright (DMCA) notice.",
      actorAdmin: input.actorAdmin,
      violationCategory: "ip_infringement",
      legalGround: "copyright_infringement",
      dmcaNoticeId: n.id,
    });
    // The material vanished between the lock and the ruling (a comment tombstoned, say).
    if (result === null) return await done(c, { kind: "target_gone" });

    const counterToken = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    await c.query(
      `UPDATE dmca_notices
          SET state = 'taken_down', decided_at = now(), decided_by = $2, takedown_action_id = $3,
              subject_user_id = $4, counter_token_hash = $5
        WHERE id = $1`,
      [n.id, input.actorAdmin, result.actionId, result.authorId, await sha256Hex(counterToken)],
    );

    await queueTakedownNotices(c, n, result, counterToken, input.origin);

    await c.query("COMMIT");
    return { kind: "ok", value: { result, subject: n.target_kind } };
  } catch (err) {
    await rollback(c);
    throw err;
  }
}

export interface RejectInput {
  readonly noticeId: string;
  readonly actorAdmin: string;
  /** Why the notice was not acted on; shown to the claimant. */
  readonly reason: string;
}

/**
 * Reject a notice (incomplete, not infringing, content already gone): the notice
 * moves to `rejected` and the claimant is told why. Hides nothing and writes no
 * ruling; `decided_by` / `decided_at` on the notice are the record.
 */
export async function rejectDmcaNotice(c: Client, input: RejectInput): Promise<DmcaDecisionOutcome<null>> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const n = await lockNotice(c, input.noticeId);
    if (n === undefined) return await done(c, { kind: "not_found" });
    if (n.email_verified_at === null || n.state !== "pending") return await done(c, { kind: "not_pending" });

    await c.query(`UPDATE dmca_notices SET state = 'rejected', decided_at = now(), decided_by = $2 WHERE id = $1`, [
      n.id,
      input.actorAdmin,
    ]);
    await enqueueDmcaClaimantNotice(c, {
      actionId: n.id,
      email: n.complainant_email,
      rendered: renderDmcaClaimantOutcome({
        outcome: "rejected",
        subject: n.target_kind,
        postTitle: n.target_label,
        reason: input.reason,
      }),
    });
    await c.query("COMMIT");
    return { kind: "ok", value: null };
  } catch (err) {
    await rollback(c);
    throw err;
  }
}

/** End the transaction without writing (a refusal) and return the outcome. */
async function done(c: Client, value: DmcaRefusal): Promise<DmcaRefusal> {
  await rollback(c);
  return value;
}

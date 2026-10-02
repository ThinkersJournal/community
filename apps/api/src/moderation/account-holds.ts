/**
 * Account legal holds (account-legal-hold spec, migration 0022).
 *
 * Deletion eligibility (both reapers, `anonymise-accounts.ts` and
 * `reap-unverified.ts`) is gated on an ACTIVE row in `account_legal_holds`,
 * and on nothing else (spec §4). Holds come from a legal-hold content
 * decision (T1), CSAM intake (T2, #114), and a manual two-admin admin action
 * (T3, impose/release wired in a later task).
 */
import { sameAdminHand, type AdminAccountHold } from "@thinkersjournal/shared";
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import type { LegalHoldCategory } from "../media/legal-hold";
import { recordModerationAction } from "./actions";

/**
 * The backfill statement (spec §5, AH-5): every account whose
 * `disabled_reason = 'terminate'` gets a `csam` hold, so a termination made
 * before holds existed stays undeletable. Idempotent via
 * `ON CONFLICT ... WHERE released_at IS NULL DO NOTHING`. Plain bans
 * (`disabled_reason = 'ban'`) are deliberately NOT backfilled — a ban is not
 * a legal hold (CireSnave's ruling, spec §5).
 *
 * ⚠️ Kept BYTE-IDENTICAL to the backfill statement in migration
 * 0022_account_legal_holds.sql. The schema test
 * (`test/account-legal-holds-schema.db.test.ts`) runs THIS constant directly
 * to prove the backfill's behaviour, and separately asserts the migration
 * file contains this exact string (stripped of `\r`, since the worktree is
 * CRLF under `core.autocrlf=true` while this source file is LF), so the two
 * copies can't drift apart.
 */
export const BACKFILL_TERMINATED_HOLDS_SQL = `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
SELECT id, 'csam', 'system', 'backfill: terminated before account holds existed'
  FROM users WHERE disabled_reason = 'terminate'
ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING;`;

/** An alias, not a re-spelling: account and media holds share one category set. */
export type AccountHoldCategory = LegalHoldCategory;

export interface ImposeHoldInput {
  readonly userId: string;
  readonly category: AccountHoldCategory;
  readonly imposedBy: string;
  readonly reason: string;
  readonly moderationActionId?: string;
}

/**
 * The caller owns the transaction. ⚠️ Locks the subject's `users` row first
 * (FOR NO KEY UPDATE). Every imposer and the anonymise reaper (which takes FOR
 * UPDATE on the same row before it scrubs) then serialise, so a hold that
 * commits while the reaper waits is visible to the reaper's next statement.
 * The lock is a no-op if the row is gone (the hold's user_id is bare).
 */
export async function imposeAccountHoldInTx(c: Client, input: ImposeHoldInput): Promise<{ readonly created: boolean }> {
  await c.query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [input.userId]);
  const { rowCount } = await c.query(
    `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason, moderation_action_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING
     RETURNING id`,
    [input.userId, input.category, input.imposedBy, input.reason, input.moderationActionId ?? null],
  );
  return { created: (rowCount ?? 0) > 0 };
}

export async function hasActiveAccountHold(c: Client, userId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    "SELECT 1 FROM account_legal_holds WHERE user_id = $1 AND released_at IS NULL LIMIT 1",
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

export type ManualImposeOutcome =
  | { readonly kind: "created"; readonly holdId: string; readonly actionId: string }
  | { readonly kind: "exists" }
  | { readonly kind: "not_found" };

/**
 * T3's manual impose. Owns its transaction: lock the user row, check for an
 * active hold of this category, and only then log and insert. A duplicate
 * therefore writes no log row, and two concurrent imposes serialise on the
 * lock (the second sees the first's hold and answers `exists`).
 * `subjectLabel` is the HANDLE (as plan A's account actions use), never the
 * email: the log is append-only, so an email written here outlives deletion.
 */
export async function imposeManualAccountHold(
  c: Client,
  input: {
    readonly userId: string;
    readonly subjectLabel: string;
    readonly category: "dmca" | "other";
    readonly imposedBy: string;
    readonly reason: string;
  },
): Promise<ManualImposeOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rowCount: found } = await c.query(
      "SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE",
      [input.userId],
    );
    if ((found ?? 0) === 0) {
      await rollbackQuietly(c);
      return { kind: "not_found" };
    }
    const { rowCount: active } = await c.query(
      "SELECT 1 FROM account_legal_holds WHERE user_id = $1 AND category = $2 AND released_at IS NULL",
      [input.userId, input.category],
    );
    if ((active ?? 0) > 0) {
      await rollbackQuietly(c);
      return { kind: "exists" };
    }
    const actionId = await recordModerationAction(c, {
      actorAdmin: input.imposedBy,
      action: "account_hold",
      reason: input.reason,
      subjectUserId: input.userId,
      subjectLabel: input.subjectLabel,
      internalNote: `category ${input.category}`,
    });
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason, moderation_action_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.userId, input.category, input.imposedBy, input.reason, actionId],
    );
    await c.query("COMMIT");
    return { kind: "created", holdId: rows[0]!.id, actionId };
  } catch (err) {
    await rollbackQuietly(c);
    throw err;
  }
}

export type ReleaseOutcome =
  | { readonly kind: "released"; readonly actionId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "csam" }
  | { readonly kind: "same_admin" }
  | { readonly kind: "already_released" };

/** `userId` is the `:handle` owner: another user's hold is `not_found`, decided under the row lock. */
export async function releaseAccountHold(
  c: Client,
  input: {
    readonly holdId: string;
    readonly userId: string;
    readonly releasedBy: string;
    readonly reason: string;
    readonly subjectLabel: string;
  },
): Promise<ReleaseOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{ category: AccountHoldCategory; imposed_by: string; released_at: Date | null }>(
      `SELECT category, imposed_by, released_at FROM account_legal_holds
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [input.holdId, input.userId],
    );
    const hold = rows[0];
    let refusal: ReleaseOutcome | null = null;
    if (hold === undefined) refusal = { kind: "not_found" };
    else if (hold.released_at !== null) refusal = { kind: "already_released" };
    else if (hold.category === "csam") refusal = { kind: "csam" };
    else if (sameAdminHand(hold.imposed_by, input.releasedBy)) refusal = { kind: "same_admin" };
    if (refusal !== null) {
      await rollbackQuietly(c);
      return refusal;
    }
    const actionId = await recordModerationAction(c, {
      actorAdmin: input.releasedBy,
      action: "account_hold_release",
      reason: input.reason,
      subjectUserId: input.userId,
      subjectLabel: input.subjectLabel,
      internalNote: input.holdId,
    });
    await c.query(
      `UPDATE account_legal_holds SET released_at = now(), released_by = $2, release_reason = $3 WHERE id = $1`,
      [input.holdId, input.releasedBy, input.reason],
    );
    await c.query("COMMIT");
    return { kind: "released", actionId };
  } catch (err) {
    await rollbackQuietly(c);
    throw err;
  }
}

/** Newest first, active and released. */
export async function listAccountHolds(c: Client, userId: string): Promise<AdminAccountHold[]> {
  const { rows } = await c.query<{
    id: string;
    category: AccountHoldCategory;
    reason: string;
    imposed_by: string;
    imposed_at: Date;
    released_at: Date | null;
    released_by: string | null;
    release_reason: string | null;
  }>(
    `SELECT id, category, reason, imposed_by, imposed_at, released_at, released_by, release_reason
       FROM account_legal_holds WHERE user_id = $1
      ORDER BY imposed_at DESC, id DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    reason: r.reason,
    imposedBy: r.imposed_by,
    imposedAt: r.imposed_at.toISOString(),
    releasedAt: r.released_at === null ? null : r.released_at.toISOString(),
    releasedBy: r.released_by,
    releaseReason: r.release_reason,
  }));
}

async function rollbackQuietly(c: Client): Promise<void> {
  try {
    await c.query("ROLLBACK");
  } catch {
    // Same reasoning as decide.ts: a failed ROLLBACK must not replace the root error.
  }
}

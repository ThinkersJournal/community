/**
 * THE ONE WAY an account action is applied (spec §5, #113 plan A).
 *
 * ⚠️ THE ACCOUNT-STATE WRITE AND THE AUDIT APPEND SHARE ONE TRANSACTION —
 * the same rule as decide.ts. A ban with no log row is unexplainable; a log
 * row with no ban is a lie.
 *
 * ⚠️ THIS DOES NOT BUMP THE SECURITY EPOCH. It takes a pg Client and cannot
 * reach the Durable Object; the route does it, before AND after this commits
 * (routes/admin-accounts.ts). A caller that skips the bump leaves the user's
 * live sessions reading (GETs check only the epoch).
 *
 * Takes the caller's `pg.Client` and never opens its own connection, matching
 * decide.ts / actions.ts.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction, type ModerationActionKind, type ViolationCategory } from "./actions";

import type { AdminAccountHistoryEntry, SuspensionHours } from "@thinkersjournal/shared";
import { ESCALATION_WINDOW_MONTHS } from "@thinkersjournal/shared";

export type AccountActionKind = "warn" | "suspend" | "ban" | "terminate";

export interface AccountActionInput {
  readonly userId: string;
  readonly kind: AccountActionKind;
  /** The statement of reasons (DSA). Shown to the user. */
  readonly reason: string;
  /** Access identity (email) of the acting human. */
  readonly actorAdmin: string;
  /** Denormalized identity for the log (the handle at action time). */
  readonly subjectLabel: string;
  /** Required for `suspend`; ignored otherwise. */
  readonly suspensionHours?: SuspensionHours;
  readonly violationCategory?: ViolationCategory;
  readonly internalNote?: string;
}

export type AccountActionOutcome =
  | { readonly kind: "applied"; readonly actionId: string; readonly email: string; readonly anonymised: boolean; readonly suspendedUntil: Date | null }
  | { readonly kind: "already_disabled" }
  | { readonly kind: "not_found" };

const LOG_ACTION: Readonly<Record<AccountActionKind, ModerationActionKind>> = {
  warn: "user_warn",
  suspend: "user_suspend",
  ban: "user_ban",
  terminate: "user_terminate",
};

/**
 * ⚠️ `GREATEST(...)` FOR suspend (Review Focus 1): a new suspension never
 * SHORTENS an existing one. ⚠️ `COALESCE(disabled_at, now())` for terminate:
 * terminating an already-banned account keeps the ORIGINAL ban time, which is
 * evidence of when the account was barred.
 */
const SET_SQL: Readonly<Record<AccountActionKind, string>> = {
  warn: "",
  suspend: "suspended_until = GREATEST(COALESCE(u.suspended_until, now()), now() + make_interval(hours => $2::int))",
  ban: "disabled_at = now(), disabled_reason = 'ban'",
  terminate: "disabled_at = COALESCE(u.disabled_at, now()), disabled_reason = 'terminate'",
};

export async function applyAccountAction(c: Client, input: AccountActionInput): Promise<AccountActionOutcome> {
  if (input.kind === "suspend" && input.suspensionHours === undefined) {
    throw new Error("applyAccountAction: suspend requires suspensionHours");
  }
  await c.query(BEGIN_BOUNDED_TX);
  try {
    // Lock the row so two moderators acting at once serialize.
    const { rows } = await c.query<{ email: string; disabled_at: Date | null; anonymised: boolean }>(
      `SELECT email, disabled_at, anonymised_at IS NOT NULL AS anonymised FROM users WHERE id = $1 FOR UPDATE`,
      [input.userId],
    );
    const user = rows[0];
    if (user === undefined) {
      await rollbackQuietly(c);
      return { kind: "not_found" };
    }
    if (user.disabled_at !== null && input.kind !== "terminate") {
      await rollbackQuietly(c);
      return { kind: "already_disabled" };
    }

    let suspendedUntil: Date | null = null;
    let ownEnd: Date | null = null;
    if (input.kind !== "warn") {
      const params: unknown[] = input.kind === "suspend" ? [input.userId, input.suspensionHours] : [input.userId];
      // ⚠️ TWO DIFFERENT ENDS (#113 plan B, pre-flight ruling B2).
      // `u.suspended_until` is the EFFECTIVE bar: the GREATEST of every
      // suspension in force (SET_SQL). `own_end` is THIS action's own end,
      // now() + hours, whatever else is in force. The log records own_end, so
      // an appeal grant can recompute the bar from the suspensions that remain
      // (moderation/appeals.ts). The notice still names the effective end.
      const { rows: updated } = await c.query<{ suspended_until: Date | null; own_end: Date | null }>(
        `UPDATE users AS u SET ${SET_SQL[input.kind]} WHERE u.id = $1
         RETURNING u.suspended_until,
                   ${input.kind === "suspend" ? "now() + make_interval(hours => $2::int)" : "NULL::timestamptz"} AS own_end`,
        params,
      );
      suspendedUntil = input.kind === "suspend" ? (updated[0]?.suspended_until ?? null) : null;
      ownEnd = input.kind === "suspend" ? (updated[0]?.own_end ?? null) : null;
    }

    const actionId = await recordModerationAction(c, {
      actorAdmin: input.actorAdmin,
      action: LOG_ACTION[input.kind],
      reason: input.reason,
      subjectUserId: input.userId,
      subjectLabel: input.subjectLabel,
      violationCategory: input.violationCategory,
      // The action's OWN end, never the effective one (ruling B2).
      actionExpiresAt: ownEnd ?? undefined,
      internalNote: input.internalNote,
    });

    await c.query("COMMIT");
    return { kind: "applied", actionId, email: user.email, anonymised: user.anonymised, suspendedUntil };
  } catch (err) {
    // Same reasoning as decide.ts: a failed ROLLBACK must not replace the root error.
    await rollbackQuietly(c);
    throw err;
  }
}

async function rollbackQuietly(c: Client): Promise<void> {
  try {
    await c.query("ROLLBACK");
  } catch {
    // Deliberately swallowed — see decide.ts.
  }
}

/**
 * Every account action against `userId`, newest first. Content actions are
 * excluded: the ladder is about the ACCOUNT (spec §5, decision #3).
 */
export async function loadAccountHistory(c: Client, userId: string): Promise<AdminAccountHistoryEntry[]> {
  const { rows } = await c.query<{
    id: string;
    action: AdminAccountHistoryEntry["action"];
    reason: string;
    violation_category: string | null;
    actor_admin: string;
    created_at: Date;
    action_expires_at: Date | null;
    counts: boolean;
  }>(
    `SELECT id, action, reason, violation_category, actor_admin, created_at, action_expires_at,
            created_at > now() - make_interval(months => $2::int) AS counts
       FROM moderation_actions
      WHERE subject_user_id = $1
        AND action IN ('user_warn','user_suspend','user_ban','user_terminate')
      ORDER BY created_at DESC`,
    [userId, ESCALATION_WINDOW_MONTHS],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    reason: r.reason,
    violationCategory: r.violation_category,
    actorAdmin: r.actor_admin,
    createdAt: r.created_at.toISOString(),
    actionExpiresAt: r.action_expires_at?.toISOString() ?? null,
    countsTowardEscalation: r.counts,
  }));
}

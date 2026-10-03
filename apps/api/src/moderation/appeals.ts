import type { Client } from "pg";

import { APPEAL_WINDOW_DAYS, APPEALABLE_ACTIONS, type AppealTarget, type AppealableAction } from "@thinkersjournal/shared";

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

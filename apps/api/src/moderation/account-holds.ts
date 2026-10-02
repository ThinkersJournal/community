/**
 * Account legal holds (account-legal-hold spec, migration 0022).
 *
 * Deletion eligibility (both reapers, `anonymise-accounts.ts` and
 * `reap-unverified.ts`) is gated on an ACTIVE row in `account_legal_holds`,
 * and on nothing else (spec §4). Holds come from a legal-hold content
 * decision (T1), CSAM intake (T2, #114), and a manual two-admin admin action
 * (T3, impose/release wired in a later task).
 */

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

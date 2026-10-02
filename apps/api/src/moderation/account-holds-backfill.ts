/**
 * The backfill statement (spec §5, AH-5), split into its own IMPORT-FREE leaf
 * module. `test/account-legal-holds-schema.db.test.ts` runs in the Node
 * project (`test/tsconfig.node.json`), which has no Worker ambient types
 * (`Hyperdrive`, `ExecutionContext`) — importing this constant from
 * `account-holds.ts` directly would pull `../db/client` (which uses those
 * types) into that project's program and fail `pnpm typecheck` with TS2304.
 * This module has zero imports, so it is safe for both the Node test project
 * and the pool/src project to import; `account-holds.ts` re-exports it so the
 * plan's interface (one module owning impose/release/list, importable from
 * `./account-holds`) still holds for every other caller.
 *
 * Every account whose `disabled_reason = 'terminate'` gets a `csam` hold, so a
 * termination made before holds existed stays undeletable. Idempotent via
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

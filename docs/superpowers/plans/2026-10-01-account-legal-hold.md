# Account Legal Hold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account deletion (both reapers) is blocked by an active account legal hold and by nothing else. A banned account deleted while banned loses its real email like any other, and a hash of that email reserves the address against a new signup while the ban stands (PM ruling B). Holds come from legal-hold content decisions, from CSAM intake (wired later by #114), and from a manual two-admin admin action.

**Architecture:** A new `account_legal_holds` table, guarded by a trigger that allows only a release, mirrors `media_legal_holds`. One module (`moderation/account-holds.ts`) owns impose, release and list. A second (`auth/reserved-email.ts`) owns the email hash, signup's reserved check and the release of a reservation. The reapers swap their ban/suspension predicates for a NOT-EXISTS-hold predicate, and the anonymise reaper locks and re-checks each row before it scrubs. `applyDecision` inserts the author's hold in its own transaction when the decision carries a legal hold.

**Tech Stack:** TypeScript on Cloudflare Workers, Postgres via Hyperdrive, Astro SSR admin page, vitest (pool + Node).

**Spec:** `docs/superpowers/specs/2026-10-01-account-legal-hold-design.md` (PR #133, approved by the PM; revised 2026-10-01 for PM ruling B and the pre-flight audit). §n below refers to it. **Read it.**

**Revised 2026-10-01:** PM ruling B (hashed email reservation, spec §4a) and the pre-flight audit's findings 1–11 and nits (`.superpowers/sdd/2026-10-01-account-legal-hold/preflight-audit.md`). Every new or changed TypeScript block below was typechecked with tsc 6.0.3 against the repo's real types, on a scratch copy outside the repo. Only the import paths differ from the scratch copy.

**Revision round 2 (2026-10-01), the re-audit:** B1 (per-row epoch bump, skip-and-continue, and a fail-closed `anonymised_at` gate in the pipeline), S1 (lock-wait poll by `pg_blocking_pids`, fixture isolation), S2 (the manual hold's log row labels the handle; the constraint and privacy copy now say what the moderation log keeps), N3 (zod 4.6.5).

## Preconditions

- ⚠️ **MERGE PRECONDITION (audit #4): #134 (migration 0020, `dsa_notices`) and #126 (0021, `moderation_snapshots`) are merged to `main` AND applied in production** (read `GET /health/schema` from #136) **before this PR merges.** Rebase this branch onto that `main` before Task 1. Why:
  - node-pg-migrate's `checkOrder` is positional (8.0.4 bundle :3712-3722), so a 0022 applied before 0020/0021 breaks every later run, in either direction;
  - the production gate (#136) treats the newest migration file as the expected schema;
  - #134 also edits `decide.ts` at Task 4's insertion point, plus `admin.ts`, `routes.ts`, `pipeline-exempt.ts` and `migrations.db.test.ts`, and #126 edits `migrations.db.test.ts` and `privacy-policy.md` (Task 6). Building on a `main` that has both avoids those conflicts.

  If either PR hasn't merged when you start, **stop and tell the controller.** Don't build around it.
- **#132 (plan A) merged** (it has: `ded56b6`). Task 5 extends `routes/admin-accounts.ts` and `pages/admin/accounts/[handle].astro`, and Task 1's backfill reads plan A's `disabled_reason = 'terminate'`.
- Migration number: **0022**.
- ⚠️ **Local test DB, EVERY vitest run (audit #4).** `apps/api/test/global-setup.ts:84-90` migrates the shared local `thinkersjournal_test` DB up on every vitest run, from any lane. Once this branch has applied 0022 there, a lane whose tree lacks 0022 fails its run. And if another lane has applied a migration this tree lacks, your run fails. If **any** vitest run in this plan fails with a migration-order error, do **not** modify, reset or roll back that DB. Stop, say so, and leave the check to CI.

## Global Constraints

- TypeScript **6.0.3**; `errorResponse` with the closed `ApiErrorCode` union; admin POSTs are `checkOrigin` → `requireAdmin` and are listed in `pipeline-exempt.ts`.
- **Deletion eligibility = no active hold. Nothing else** (spec §4). `disabled_at`/`suspended_until` must not appear in either reaper's eligibility predicate afterwards. The only `disabled_at` read left in `anonymise-accounts.ts` is the `CASE` that decides the hash.
- **`signup.ts`'s barred-row guard (the upsert's `WHERE`) is unchanged** (spec §1; AH-6). Signup's only change is the reserved-hash refusal after the upsert (spec §4a).
- **No mail or authentication path can reach a deleted account's address** (PM ruling B). Every anonymised row's `email` is the sentinel, and a banned one also gets `reserved_email_sha256`. ⚠️ The address is **not** gone everywhere: `moderation_actions.subject_label` keeps the author's email recorded at each content decision (`decide.ts:128`), as the append-only legal record, and nothing in this plan changes that (spec §4a). Don't write any new copy of it: label new log rows with the handle.
- **A deleted account can't authenticate** (spec §4, re-audit B1). The reaper bumps each row's epoch right after its own COMMIT, and the mutating pipeline refuses any session whose user has `anonymised_at` set.
- CSAM holds are never released by app code (DB CHECK and route refusal).
- A non-CSAM hold is released only by a **different** admin than the one who imposed it: compare with `sameAdminHand` (`@thinkersjournal/shared`, #98).
- T1's account hold is written **inside** the decision transaction (spec §3 T1), never post-commit.
- Every hold imposer locks the subject's `users` row first (`imposeAccountHoldInTx` and `imposeManualAccountHold` do). The anonymise reaper relies on that (spec §4).
- Every new `moderation_actions` row goes through `recordModerationAction`.
- Test rows in `account_legal_holds` **can't be deleted** (the trigger refuses it). Use fresh random ids, never assert table-wide counts, and scope every assertion to the ids the test seeded. The local test DB is shared with parallel files.
- PR body: say "Part of" the board items. No issue to close.

## Review Focus

1. **A banned, unheld account requests deletion.** After 30 days it is scrubbed like any other: `email` is the sentinel, `password_hash` is unusable, and `reserved_email_sha256` is set. Signing up again with the original address, in any letter case, gets `409 EMAIL_TAKEN`. Forgot-password for it sends nothing. After the ban is lifted and `releaseReservedEmail` runs, the address can sign up (AH-2, AH-7). Pinned in Task 3.
2. **A held account that is neither banned nor suspended.** Neither reaper touches it, which proves the hold alone gates deletion (AH-1). Pinned in Task 3.
3. **A legal-hold decision whose transaction fails after the hold insert.** Neither the decision nor the hold survives (AH-3). Pinned in Task 4 with a deferred constraint trigger, its SQL inlined there.
4. **An admin releasing a hold they imposed, with different email casing.** Refused (`sameAdminHand`) (AH-4). Pinned in Task 2.
5. **A second impose of the same category while one is active.** No duplicate and no error (`ON CONFLICT … WHERE released_at IS NULL DO NOTHING` through partial-index inference). The manual route writes no log row for it. Pinned in Task 2 and Task 5.
6. **The reaper's batch goes stale before it writes.** A hold imposed, a ban lifted or a request cancelled after the SELECT is honoured, because each scrub locks the row and re-checks inside its `UPDATE`. Pinned in Task 3.
7. **A row locked past the 5 s `lock_timeout` mid-batch** (re-audit B1). That row is skipped and logged, and the job doesn't throw. Every other row is scrubbed **and** its sessions revoked. A session that somehow survives anonymisation is refused by the pipeline (401). Pinned in Task 3, the gate with a mutation.

---

### Task 1: Schema, trigger, action kinds, reserved-email column, backfill

**Files:** create `apps/api/migrations/0022_account_legal_holds.sql`; modify `apps/api/src/moderation/actions.ts` (`ModerationActionKind` gains `"account_hold" | "account_hold_release"`), `apps/api/test/migrations.db.test.ts`; test `apps/api/test/account-legal-holds-schema.db.test.ts` (Node project, the `reports-schema.db.test.ts` harness).

```ts
  | "author_hide" | "author_unhide"
  // Account legal holds (account-legal-hold spec §3 T3, migration 0022).
  | "account_hold" | "account_hold_release";
```

- [ ] **Step 1: Failing schema test.** Write every case in full. Each case uses fresh random user ids (the hold's `user_id` is bare, so most cases need no `users` row), and asserts only over those ids:
  - an UPDATE that sets `released_at`, `released_by` and `release_reason` on an active `dmca` hold succeeds;
  - an UPDATE of `reason` (or any of the 7 non-release columns) is refused with "only released_at/released_by/release_reason may change";
  - an UPDATE of an already-released row is refused with "a released hold is final";
  - DELETE is refused, and TRUNCATE is refused;
  - releasing a `csam` hold is refused by `account_legal_holds_csam_never_released`;
  - setting only `released_at` without `released_by` and `release_reason` is refused by `account_legal_holds_release_consistent`;
  - two active holds of the same category for one user are refused by `account_legal_holds_active_idx`. **Control:** the same category succeeds again after the first is released;
  - `INSERT … ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING` on an active duplicate inserts 0 rows **without error** (this proves partial-index inference works);
  - `moderation_actions` accepts `account_hold` and `account_hold_release`;
  - **`users.reserved_email_sha256`** (seed real `users` rows):
    - a non-hex value is refused by `users_reserved_email_sha256_hex`;
    - a 64-hex value on a row with `anonymised_at IS NULL` is refused by `users_reserved_email_only_anonymised`; **control:** the same value on an anonymised row is accepted;
    - **two** anonymised rows may hold the **same** hash (the index is deliberately not unique, spec §4a);
  - **backfill (AH-5):** the migration is applied by vitest's global setup **before** the test seeds anything, so test the backfill **statement itself**, imported as `BACKFILL_TERMINATED_HOLDS_SQL` (Step 3). Seed a user with `disabled_reason = 'terminate'` and another with `'ban'`. Then, on **one** client, `BEGIN`, run the statement twice, and assert, **only over the two seeded ids**: exactly one `csam` hold, for the terminated user, with `imposed_by = 'system'`, after both runs. Then `ROLLBACK`. ⚠️ The statement runs over **every** `users` row in the shared DB, including terminate users that other files create in parallel (e.g. `account-actions.test.ts:116,127`). The ROLLBACK is what keeps it from leaving undeletable holds on their rows. Never assert a global count.
- [ ] **Step 2: Migration.** The table and trigger come verbatim from spec §2 (the CREATE TABLE, the partial unique index, and the full `account_legal_holds_guard()` function and its two triggers), and so does the `users` block (the `ALTER TABLE users … reserved_email_sha256` and its partial index). Then:

```sql
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    -- ⚠️ Copy the LATEST list from the newest migration that rebuilds this
    -- constraint (0017 at the time of writing; read 0020/0021 too, now that
    -- they have merged — the precondition — and #114's migration if it has
    -- merged, which adds csam_hold/csam_review), then append:
    'account_hold','account_hold_release'
  ));

-- Backfill (spec §5, AH-5): terminations made before holds existed must stay
-- undeletable. Idempotent. ⚠️ Keep this statement byte-identical to
-- BACKFILL_TERMINATED_HOLDS_SQL in src/moderation/account-holds.ts — the
-- schema test runs that constant to prove this statement.
INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
SELECT id, 'csam', 'system', 'backfill: terminated before account holds existed'
  FROM users WHERE disabled_reason = 'terminate'
ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING;
```

Write the Down migration in full. Drop the triggers, the function and the table. Drop `users_reserved_email_sha256_idx` and the `reserved_email_sha256` column (its CHECKs go with it). Restore the previous CHECK list.
- [ ] **Step 3:** `apps/api/src/moderation/account-holds.ts` exports `BACKFILL_TERMINATED_HOLDS_SQL` (the identical statement), and the schema test imports it. A Node test reads the migration file and asserts that it **contains** that exact string, so the two copies can't drift. ⚠️ **Strip `\r` first** (audit #5): this checkout has `core.autocrlf=true`, so the worktree file is CRLF while the constant is LF. Use `readFileSync(path, "utf8").replace(/\r/g, "")`, and strip the constant the same way.
- [ ] **Step 4:** run `cd apps/api && npx vitest run test/account-legal-holds-schema.db.test.ts` → PASS. Add the `tableExists("account_legal_holds")` and `columnExists("users", "reserved_email_sha256")` up/down assertions to `migrations.db.test.ts`. (The local-DB warning in Preconditions applies here and to every later vitest run.) Commit `feat(db): account legal holds — release-only trigger, reserved-email hash column, backfill of terminated accounts`.

---

### Task 2: The hold module and the reserved-email module

**Files:** create `apps/api/src/moderation/account-holds.ts` (extending Task 1's constant) and `apps/api/src/auth/reserved-email.ts`; modify `packages/shared/src/schemas.ts` (`normalizeEmail`) and `packages/shared/src/admin.ts` (**declare `AdminAccountHold` here**; Task 5 only adds it to `AdminAccountResponse`); tests `apps/api/test/account-holds.test.ts` and `apps/api/test/reserved-email.test.ts` (pool: both modules import `db/client`), `packages/shared/test/schemas.test.ts` (append, or create it if absent).

Declare in `packages/shared/src/admin.ts` (audit nit: alias the wire type, don't re-spell it):
```ts
/** One row of an account's legal-hold history (account-legal-hold spec §2). ISO strings. */
export interface AdminAccountHold {
  readonly id: string;
  readonly category: LegalHoldCategoryWire;
  readonly reason: string;
  readonly imposedBy: string;
  readonly imposedAt: string;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
  readonly releaseReason: string | null;
}
```

In `packages/shared/src/schemas.ts`, replace `const NormalizedEmail = z.email().toLowerCase();` (line 33) with the following. The behaviour is identical: in zod **4.6.5** (the version `packages/shared` resolves; `node_modules/.pnpm/zod@4.6.5/.../v4/core/api.js:714`), `toLowerCase()` is `_overwrite((input) => input.toLowerCase())`. In the same edit, correct the existing doc comment above it (line 29) from "Verified against the installed zod 4.4.3" to "zod 4.6.5", and make it describe `.overwrite(normalizeEmail)` rather than `toLowerCase()`.
```ts
/**
 * THE email normaliser. `NormalizedEmail` applies it (so signup, login and
 * forgot-password all store and look up its output), and the reserved-email
 * hash (apps/api/src/auth/reserved-email.ts, account-legal-hold spec §4a)
 * hashes its output. One function, so the two can never disagree about which
 * addresses are "the same". Identical to the zod 4.6.5 `toLowerCase()` it
 * replaces, which is `_overwrite((input) => input.toLowerCase())`.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

const NormalizedEmail = z.email().overwrite(normalizeEmail);
```

**Produces** (`apps/api/src/auth/reserved-email.ts`, in full):
```ts
/**
 * A banned account's email reservation (account-legal-hold spec §4a; PM ruling B, 2026-10-01).
 *
 * At deletion every account's email is replaced by the undeliverable sentinel
 * (anonymise-accounts.ts). For an account that is BANNED at that moment, the
 * reaper also stores `users.reserved_email_sha256` = the sha256 hex of the
 * normalised email, and signup refuses any address whose hash matches. The
 * real address is no longer on the account row, which is all any mail or
 * authentication path reads (the moderation log's subject_label keeps the
 * email recorded at a content decision, but nothing mails from it).
 * The reservation ends when the ban does (`releaseReservedEmail`, called by
 * plan B's ban-lift path).
 */
import { normalizeEmail } from "@thinkersjournal/shared";
import type { Client } from "pg";

import { sha256Hex } from "./encoding";

/** Lowercase-hex sha256 of signup's own normalisation (`normalizeEmail`, packages/shared/src/schemas.ts). */
export function reservedEmailSha256(email: string): Promise<string> {
  return sha256Hex(normalizeEmail(email));
}

/** True if a deleted, banned account still reserves this address. */
export async function isEmailReserved(c: Client, email: string): Promise<boolean> {
  const { rowCount } = await c.query(
    "SELECT 1 FROM users WHERE reserved_email_sha256 = $1 LIMIT 1",
    [await reservedEmailSha256(email)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Ends the reservation once the account is no longer banned. A no-op (false)
 * while `disabled_at` is still set, or when nothing is reserved. Call it in the
 * same transaction that clears `disabled_at`, after that UPDATE.
 */
export async function releaseReservedEmail(c: Client, userId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE users SET reserved_email_sha256 = NULL
      WHERE id = $1 AND disabled_at IS NULL AND reserved_email_sha256 IS NOT NULL`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}
```

**Produces** (`apps/api/src/moderation/account-holds.ts`, in full, after Task 1's `BACKFILL_TERMINATED_HOLDS_SQL`):
```ts
import { sameAdminHand, type AdminAccountHold } from "@thinkersjournal/shared";
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import type { LegalHoldCategory } from "../media/legal-hold";
import { recordModerationAction } from "./actions";

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
```

- [ ] **Step 1: Failing tests** (write each in full; seeded ids only):
  - `imposeAccountHoldInTx` (inside a `BEGIN`/`COMMIT` the test owns) creates a hold, and a second impose of the same category returns `created: false` with no new row (**RF5**);
  - `imposeManualAccountHold`: `created` with exactly one `account_hold` log row, whose `subject_label` is the handle passed in and **not** the user's email; the same category again → `exists`, with **still one** log row (**RF5**); an unknown user id → `not_found`; **concurrent:** two calls on two clients (`Promise.all`) → exactly one `created`, one `exists`, one hold, one log row (audit #8);
  - `hasActiveAccountHold` is true, then false after a release;
  - **release:** by a different admin → `released`, with a `moderation_actions` row of kind `account_hold_release`. **RF4:** release by the imposer in different case (`Mod@X` imposed, `mod@x ` releases) → `same_admin`, with no change and no log row. A `csam` hold → `csam`. An unknown id → `not_found`. **A real hold id passed with a different `userId` → `not_found`, and the hold is unchanged** (audit #7). A second release → `already_released`;
  - `listAccountHolds`: newest first, with released rows included;
  - `reserved-email.test.ts`:
    - `reservedEmailSha256("Ada@Example.COM")` equals `reservedEmailSha256("ada@example.com")`, and equals the 64-hex sha256 of `"ada@example.com"`;
    - `isEmailReserved` is true for an anonymised row holding that hash, and false for a different address (control);
    - `releaseReservedEmail`: an anonymised, **no longer banned** row → hash NULL, `true`; an anonymised row **still banned** → unchanged, `false`; a row with no hash → `false`;
  - `packages/shared` test: `SignupInput.shape.email.parse("Ada@Example.COM") === normalizeEmail("Ada@Example.COM")`, and both are `"ada@example.com"`.
- [ ] **Step 2: Implement** the blocks above as written.
- [ ] **Step 3:** run the three test files plus `signup`, `login` and `forgot-password` (they parse with `NormalizedEmail`) → PASS. Commit `feat(moderation): account-hold module (impose, release by a second admin, never csam, list) and the reserved-email hash`.

---

### Task 3: The reapers gate on the hold; a banned account's address is reserved by hash; signup refuses it

**Files:** modify `apps/api/src/auth/anonymise-accounts.ts`, `apps/api/src/auth/reap-unverified.ts`, `apps/api/src/routes/signup.ts`, `apps/api/src/auth/pipeline.ts` (re-audit B1b); append to `apps/api/test/pipeline-barred.test.ts` (it has the session harness and the `ROUTES` table of every pipeline route); **rewrite** the two named blocks in `apps/api/test/anonymise-accounts.test.ts` (`describe("anonymiseExpiredAccounts — a barred account is never scrubbed")`) and `apps/api/test/reap-unverified.test.ts` (`describe("reapUnverifiedAccounts — a barred account is never reaped (AC-3)")`); append to `apps/api/test/barred-reentry.test.ts` (it has the signup harness: `resignup`, `stubFetch`, `ALLOWED_ORIGIN`, from :140) and `apps/api/test/forgot-password.test.ts` (it has `stubFetch(true)`, which returns the Postmark calls).

⚠️ **Rewrite those two blocks for the NEW rule. Do NOT make them pass by putting the ban checks back** (spec §4).

- [ ] **Step 1: Rewritten and new tests** (write each in full; call `anonymiseExpiredAccounts(env, ctx)` with a fresh execution context and `waitOnExecutionContext`, as `anonymise-accounts.test.ts` does).

  ⚠️ **Cross-file flake, and how these tests avoid it (re-audit S1).** The reaper takes the oldest 500 eligible rows from the **shared** test DB, and several files (`anonymise-accounts`, `barred-reentry`, `forgot-password`) run it in parallel. So another file's run can scrub your fixture, and yours can scrub theirs. The module has no test-seam idiom (none of the reapers takes a filter, and `/__test/anonymise-accounts` calls it bare), so **don't add a candidate-id parameter.** Instead:
  - seed every fixture's `deletion_requested_at` at a **unique far-past** timestamp, e.g. `timestamptz '2000-01-01' + (random() * interval '1000 days')`, so it sorts into the head of every run's batch whatever else the DB holds;
  - assert on **each fixture row's final state**, never on the reaper's return value or on a log line: which run scrubbed a row is not deterministic, but its end state is;
  - only `anonymise-accounts.test.ts` holds row locks (RF6, RF7), and vitest runs one file's tests sequentially, so no other file blocks on them for long.
  - **anonymise, AH-2:** banned, suspended and lapsed-suspended accounts with **no** hold and a 31-day-old deletion request **are** anonymised.
  - **anonymise, AH-1 / RF2:** a held account (any category) that is not banned, a held **banned** account, and a held suspended account are **not** anonymised. After releasing a `dmca` hold, the next run anonymises that account.
  - **anonymise, AH-7 / RF1:**
    - a banned, unheld account is anonymised with `email` = `deleted-<id>@invalid.thinkersjournal.local`, `password_hash` = `!anonymised!`, `username`, `display_name` and `bio` scrubbed, and `reserved_email_sha256` = the sha256 hex of its original (lowercased) email;
    - a **non-banned** account is anonymised the same way with `reserved_email_sha256` **NULL** (control);
  - **anonymise, RF6 (audit #3), each a row the batch SELECT returns but the UPDATE must re-check.** Drive each with a lock held from a second client: `BEGIN; SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, then start the reaper (don't await it). ⚠️ **Before making the change, poll until the reaper is actually blocked on THIS lock** (re-audit S1). Read the locking client's backend pid first (`SELECT pg_backend_pid()`), then poll `SELECT 1 FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[$1::int]` with that pid, every 50 ms, for **at most 2 s** (well under the 5 s `lock_timeout`, after which the reaper would skip the row). If the poll times out, fail the test. Don't match on query text. Without the poll, the change can commit before the reaper's SELECT and the test passes vacuously. Then make the change on the locking client, `COMMIT`, and await the reaper:
    - a `dmca` hold inserted while the reaper waits → the row is **not** anonymised, and its profile is untouched;
    - `disabled_at` cleared while the reaper waits (it was banned at SELECT time) → anonymised with `reserved_email_sha256` **NULL**;
    - `disabled_at` set while the reaper waits (not banned at SELECT time) → anonymised with the hash **set**;
    - `deletion_requested_at` set to NULL while the reaper waits → not anonymised.
  - **signup, AH-7 (`barred-reentry.test.ts`):** seed a verified user with a known email, ban it (`disabled_at = now(), disabled_reason = 'ban'`), backdate `deletion_requested_at` 31 days, and run the reaper. Then:
    - `resignup(email)` → **409 `EMAIL_TAKEN`**, no `Set-Cookie`, and no `users` row with that email exists. This is the same status and body as the existing barred case at :171;
    - `resignup(email.toUpperCase())` → the same 409 (normalisation);
    - **control:** the same flow with an **unbanned** account → `resignup(email)` → 201 (track the new user's id for cleanup);
    - after `UPDATE users SET disabled_at = NULL, disabled_reason = NULL` plus `releaseReservedEmail(c, id)` → `resignup(email)` → 201.
  - **forgot-password, AH-7 structural (`forgot-password.test.ts`):** a banned account anonymised by the reaper; `forgotPassword(validBody(originalEmail))` → 202 with **0** Postmark calls and no `password_reset_tokens` row for that user. **Control:** the same request before the reaper runs → 1 Postmark call.
  - **anonymise, RF7 (re-audit B1a):** seed two eligible accounts, X and Y, and mint a session for Y (`createSession` with its current epoch). Lock X from a second client (`FOR UPDATE`) and **hold the lock for 7 s**, past the 5 s `lock_timeout`. Run the reaper (test timeout ≥ 20 s). It **resolves without throwing**; X is unscrubbed (`anonymised_at IS NULL`); Y is anonymised **and** its epoch has moved (`getEpoch()` ≠ the session's). Release X's lock, run the reaper again, and X is now anonymised. Control for the bump: Y's epoch before the run equals the session's.
  - **pipeline, RF7 (re-audit B1b, `pipeline-barred.test.ts`):** mint a session for a verified user, then set `anonymised_at = now()` **directly in SQL** (no reaper, so no epoch bump). Every route in `ROUTES` answers **401** with a cleared `tj_session` cookie, not `ACCOUNT_BARRED`. **Control:** the same session before the UPDATE passes the pipeline. **Mutation:** delete the step-5a block in `pipeline.ts` → the 401 assertions fail. Record that, then restore it.
  - **reap-unverified, AH-1/AH-2:** unverified, 8-day-old accounts that are banned or suspended **without** a hold are deleted; with a hold (banned or not) they survive.
  - **Mutation (AH-1):** remove the NOT-EXISTS clause from the anonymise `UPDATE` **and** the SELECT → the held-account test fails. Restore it.
  - **Mutation (AH-7):** change the `CASE` to `ELSE NULL` on both arms (store NULL always) → the signup 409 test and the hash assertion fail. Restore it.
  - **Mutation (RF6):** remove the `FOR UPDATE` lock statement → the "hold inserted while the reaper waits" test fails. (The blocked `UPDATE`'s `NOT EXISTS` uses its old snapshot.) Restore it. If it does not fail, say so in the report rather than weakening the test.
  - **Mutation (RF7a):** move the epoch bump back to after the loop and rethrow from the per-row `catch` → the RF7 reaper test fails (it throws, and Y's epoch hasn't moved). Restore it.
- [ ] **Step 2: Implement.**
  - **anonymise-accounts.ts.** Replace `anonymiseExpiredAccounts` with the following two functions. Change the import to `import { BEGIN_BOUNDED_TX, withClient } from "../db/client";`, and add `import type { Client } from "pg";` and `import { reservedEmailSha256 } from "./reserved-email";`. `scrubbedEmail`, `SCRUBBED_PASSWORD_HASH` and `scrubbedUsername` are unchanged.

```ts
export async function anonymiseExpiredAccounts(env: Env, ctx: ExecutionContext): Promise<number> {
  const candidates = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; email: string }>(
      `SELECT id, email FROM users
        WHERE deletion_requested_at < now() - interval '30 days'
          AND anonymised_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM account_legal_holds h
                           WHERE h.user_id = users.id AND h.released_at IS NULL)
        ORDER BY deletion_requested_at
        LIMIT $1`,
      [REAP_BATCH],
    );
    return rows;
  });
  if (candidates.length === 0) return 0;

  let scrubbed = 0;
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    for (const { id, email } of candidates) {
      // ⚠️ ONE ROW'S FAILURE NEVER STOPS THE BATCH (spec §4). A lock timeout
      // (BEGIN_BOUNDED_TX's 5s) or any other error leaves THAT row unscrubbed,
      // which is safe, and the next nightly run retries it. Rethrowing would
      // strand every row already committed in this run without its epoch
      // bump: main's reaper had exactly that shape (bumps after the loop).
      let changed: boolean;
      try {
        changed = await scrubOne(c, id, email);
      } catch (err) {
        console.error(`anonymise-accounts: skipped ${id} (retried next run)`, err);
        continue;
      }
      if (!changed) continue;
      scrubbed += 1;
      // Kill every live session RIGHT AFTER this row's COMMIT, not after the
      // loop. The scrub makes password_hash unable to authenticate a FUTURE
      // login, but does nothing about a session issued before it. Same
      // mechanism as logout-all (src/routes/logout.ts). If the bump itself
      // fails, the pipeline's anonymised_at gate (auth/pipeline.ts step 5a)
      // still refuses the session: fail closed.
      try {
        await env.USER_SECURITY.getByName(id).bumpEpoch();
      } catch (err) {
        console.error(`anonymise-accounts: epoch bump failed for ${id}; the pipeline gate still refuses it`, err);
      }
    }
  });

  console.log(`anonymise-accounts: anonymised ${scrubbed} of ${candidates.length} candidate(s)`);
  return scrubbed;
}

/**
 * One account, one transaction. Returns whether the row was scrubbed (false:
 * a re-check failed — a hold, a cancelled request, or an already-anonymised
 * or changed row). Throws on a DB error, after rolling back.
 */
async function scrubOne(c: Client, id: string, email: string): Promise<boolean> {
  // Computed for every candidate; the UPDATE's CASE decides whether to store it.
  const emailSha256 = await reservedEmailSha256(email);
  await c.query(BEGIN_BOUNDED_TX);
  try {
    // ⚠️ LOCK, THEN RE-CHECK (spec §4). The batch SELECT may be minutes old
    // by now: a hold may have been imposed (T1/T2/T3), a ban imposed or lifted
    // (plan A/B), or the request cancelled. Every hold imposer locks this row
    // first (imposeAccountHoldInTx), so after this lock the UPDATE below — a
    // NEW statement, hence a NEW snapshot — sees any hold that committed while
    // we waited. A NOT EXISTS evaluated inside a blocked UPDATE alone would
    // not: READ COMMITTED's re-check re-reads the target row, not the subquery.
    await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [id]);
    const { rowCount } = await c.query(
      `UPDATE users
          SET email = $2, password_hash = $3, anonymised_at = now(),
              -- PM ruling B (spec §4a): a BANNED account's address is
              -- reserved by hash; the address itself is replaced, as for
              -- every account.
              reserved_email_sha256 = CASE WHEN disabled_at IS NOT NULL THEN $4 ELSE NULL END
        WHERE id = $1
          AND email = $5
          AND anonymised_at IS NULL
          AND deletion_requested_at < now() - interval '30 days'
          AND NOT EXISTS (SELECT 1 FROM account_legal_holds h
                           WHERE h.user_id = users.id AND h.released_at IS NULL)`,
      [id, scrubbedEmail(id), SCRUBBED_PASSWORD_HASH, emailSha256, email],
    );
    const changed = (rowCount ?? 0) === 1;
    if (changed) {
      await c.query(
        `UPDATE profiles
            SET username = $2, display_name = NULL, bio = NULL
          WHERE user_id = $1`,
        [id, scrubbedUsername(id)],
      );
      await c.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [id]);
    }
    await c.query("COMMIT");
    return changed;
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // A failed ROLLBACK must not replace the root error (decide.ts).
    }
    throw err;
  }
}
```

  `AND email = $5` keeps the stored hash tied to the address actually replaced. No route changes `users.email` today (the only writer is this file), so it only matters if one is ever added. Rewrite the header comment: the hold, not a ban, is the gate (CireSnave's ruling, quoted verbatim from spec §0); a banned account's address is reserved by hash (PM ruling B, quoted from spec §0); each scrub locks and re-checks; and each row is revoked right after its own commit, with a failed row skipped and retried next run (spec §4; `main`'s reaper bumped after the loop, which this closes).
  - **pipeline.ts (re-audit B1b).** `AccountGateRow` gains `readonly anonymised_at: Date | null;`, and `readAccountGate`'s SELECT reads it: `"SELECT email_verified_at, suspended_until, disabled_at, disabled_reason, anonymised_at FROM users WHERE id = $1"`. In `runMutatingPipeline`, right after `const account = await readAccountGate(env, ctx, session.userId);` and **before** the barred check, insert:

```ts
  // ---- 5a. Deleted account — FAIL CLOSED (account-legal-hold spec §4) ------
  // The anonymise reaper bumps the epoch right after each row's scrub, which
  // step 4 then catches. This is the backstop for a missed bump: a session
  // whose user has been anonymised is UNAUTHENTICATED — the same 401 and
  // cleared cookie as step 4's revocation, deliberately not step 5's
  // ACCOUNT_BARRED (a deleted account has no one to tell why).
  if (account !== null && account.anonymised_at !== null) {
    const { cookie } = await destroySession(env, request);
    return unauthorized({ "Set-Cookie": cookie });
  }
```

  Update the step list in `runMutatingPipeline`'s header comment to add 5a.
  - **reap-unverified.ts:** in its inner SELECT, replace `AND disabled_at IS NULL AND suspended_until IS NULL` with the same NOT-EXISTS-hold clause, and rewrite the header comment to match the reworded AC-3. (It deletes in one statement, so it needs no lock: a deleted row has no hash and no profile left to scrub.)
  - **signup.ts:** add `import { isEmailReserved } from "../auth/reserved-email";`, and insert this right after the existing `if (row === null) { … return null; }` block, before the epoch bump:

```ts
        // ⚠️ A DELETED, BANNED ACCOUNT RESERVES ITS ADDRESS BY HASH (account-legal-hold
        // spec §4a, PM ruling B). Its `users.email` is the undeliverable sentinel,
        // so the upsert above found no conflict; this refuses it the same way the
        // barred-row WHERE does: ROLLBACK, null, the same 409 EMAIL_TAKEN.
        // ⚠️ AFTER the upsert, not before: until the reaper's scrub commits, its
        // row still holds this email and the upsert conflicts with it (barred:
        // 0 rows). Once the upsert succeeds without that conflict, the scrub has
        // committed, and this later statement's snapshot sees its hash. A check
        // run BEFORE the upsert could miss a scrub that commits between the two.
        if (await isEmailReserved(c, email)) {
          await c.query("ROLLBACK");
          return null;
        }
```

  Update the comment above `if (upserted === null)` to read "a VERIFIED or BARRED account owns this address, or a deleted banned account reserves it". The upsert and its `WHERE` don't change (AH-6).
- [ ] **Step 3:** run `anonymise-accounts`, `reap-unverified`, `signup`, `barred-reentry` (**AH-6**: the barred-row guard's existing tests at :171 still pass), `forgot-password` and `pipeline-barred` → PASS. Run the five mutations and record each result. Commit `feat(auth): deletion gated on an account legal hold, not on ban/suspension; a banned account's address reserved by hash`.

---

### Task 4: T1, the legal-hold decision holds the author's account in-transaction

**Files:** modify `apps/api/src/moderation/decide.ts` (`DecisionInput.accountHold?`; the insert goes after `recordModerationAction` **and after #134's DSA block**), `apps/api/src/routes/admin.ts` (pass `accountHold` into `applyDecision`); test `apps/api/test/admin-decision-route.test.ts` (append; it has `seedUser`, `seedPost`, `ctxRun`, `adminEmail`).

- [ ] **Step 1: Failing tests** (write each in full):
  - `remove` with `legalHold: true, legalHoldCategory: "dmca"` → the author has an active `dmca` account hold whose `moderation_action_id` is the decision's `actionId`;
  - a decision without a legal hold → no account hold;
  - **AH-3 / RF3:** a deferred constraint trigger fires at COMMIT, after the hold INSERT has run. This is #134's technique (`admin-dsa-notices.test.ts`, "atomicity (failure AFTER the resolve step)", read at `9f11cc3`), inlined here for `account_legal_holds`:

```ts
it("AH-3: a commit-time failure after the account-hold insert leaves neither the decision nor the hold", async () => {
  const authorId = await seedUser();
  const post = await seedPost(authorId);
  // Unique names: the test DB is shared across files, and the WHEN clause
  // scopes the trigger to THIS author, so no other file's holds are affected.
  const suffix = crypto.randomUUID().replace(/-/g, "");
  const fnName = `test_fail_on_account_hold_${suffix}`;
  const trgName = `test_fail_account_hold_${suffix}`;
  await ctxRun(async (c) => {
    await c.query(
      `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'forced failure after account hold';
       END;
       $$ LANGUAGE plpgsql`,
    );
    // DEFERRED: fires at COMMIT, strictly after decide.ts's hold INSERT (and
    // every other write) has run in the still-open transaction.
    await c.query(
      `CREATE CONSTRAINT TRIGGER ${trgName}
         AFTER INSERT ON account_legal_holds
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW
         WHEN (NEW.user_id = '${authorId}'::uuid)
         EXECUTE FUNCTION ${fnName}()`,
    );
  });
  try {
    await expect(
      ctxRun((c) =>
        applyDecision(c, {
          subject: "post",
          subjectId: post.id,
          decision: "remove",
          reason: "x",
          actorAdmin: adminEmail,
          accountHold: { category: "dmca" },
        }),
      ),
    ).rejects.toThrow(/forced failure after account hold/);

    const after = await ctxRun(async (c) => {
      const hidden = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM posts WHERE id = $1`, [post.id]);
      const actions = await c.query(`SELECT 1 FROM moderation_actions WHERE post_id = $1`, [post.id]);
      const holds = await c.query(`SELECT 1 FROM account_legal_holds WHERE user_id = $1`, [authorId]);
      return { hiddenAt: hidden.rows[0]!.hidden_at, actions: actions.rowCount, holds: holds.rowCount };
    });
    expect(after).toEqual({ hiddenAt: null, actions: 0, holds: 0 });
  } finally {
    await ctxRun(async (c) => {
      await c.query(`DROP TRIGGER IF EXISTS ${trgName} ON account_legal_holds`);
      await c.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
    });
  }
});
```

  Import `applyDecision` from `../src/moderation/decide` in that file. **Control:** the same call with the trigger's `WHEN` scoped to a different (random) uuid succeeds and leaves a hold, which shows the failure came from the trigger.
- [ ] **Step 2: Implement.** In `decide.ts`, `DecisionInput` gains `readonly accountHold?: { readonly category: LegalHoldCategory };`. Import the type from `../media/legal-hold`, and `imposeAccountHoldInTx` from `./account-holds`. ⚠️ **Insertion point:** #134 (the precondition) inserts its DSA-resolution block (`const { rows: dsaRows } = await c.query(… UPDATE dsa_notices …)`) right after `recordModerationAction(...)`. Put this **after that DSA block and before `const purge: PurgeTarget`**:

```ts
    if (input.accountHold !== undefined) {
      // Spec §3 T1: the author's account is held in THE SAME transaction as the
      // decision — unlike the image hold, which stays post-commit and best-effort.
      await imposeAccountHoldInTx(c, {
        userId: row.author_id,
        category: input.accountHold.category,
        imposedBy: input.actorAdmin,
        reason: input.reason,
        moderationActionId: actionId,
      });
    }
```

  If plan B has merged and split out `applyDecisionInTx`, put it in the same spot there. In `routes/admin.ts`, add this to the `applyDecision` call's input. ⚠️ `legalHoldCategory` is `unknown` at :118, validated but not narrowed (audit #2), so cast it as :172 already does:

```ts
      accountHold: legalHold === true ? { category: legalHoldCategory as LegalHoldCategory } : undefined,
```
- [ ] **Step 3:** run `admin-decision-route`, `moderation-actions.db` and `admin-dsa-notices` (its in-tx DSA block shares this function) → PASS. Commit `feat(moderation): a legal-hold decision holds the author's account in the decision's transaction`.

---

### Task 5: T3, manual impose/release, and the admin page

**Files:** modify `apps/api/src/routes/admin-accounts.ts`, `apps/api/src/routes.ts`, `apps/api/test/helpers/pipeline-exempt.ts`, `packages/shared/src/admin.ts` (`AdminAccountResponse` gains `holds: readonly AdminAccountHold[]`; the type itself is declared in Task 2), `apps/web/src/pages/admin/accounts/[handle].astro`; tests `apps/api/test/admin-account-holds-route.test.ts` (copy the harness of `admin-accounts-route.test.ts` lines 1-104 (through `act`) **by symbol**: imports, `TEAM`/`AUD`/`KID`, **`ALLOWED_ORIGIN`**, `b64url`, `b64urlJson`, the module-scope `let`s, `makeJwt`, `ctxRun`, `call`, the module-level `beforeEach`/`afterEach`, and `seedHandle`), `apps/web/test/admin-account-page.test.ts` (append).

**Routes:**
- `POST /admin/accounts/:handle/holds` `{ category: "dmca" | "other", reason }`. `csam` → `400 INVALID_INPUT`; a blank reason → 400. Resolve `:handle` with `findByHandle`, then call `imposeManualAccountHold` with `subjectLabel: account.username` (Task 2: one transaction, lock, check, log, insert). `created` → `200 { created: true, holdId }`; `exists` → `200 { created: false }`, with **no** log row; `not_found` → 404.
- `POST /admin/accounts/:handle/holds/:id/release` `{ reason }`. A non-UUID `:id` → 404 before any query. Resolve `:handle`, then call `releaseAccountHold` with **`userId` = the handle's account id** and `subjectLabel` = the handle. The handle check is enforced inside the transaction (audit #7). Mapping:
  - `same_admin` → 403 `FORBIDDEN` with message "a different admin must release this hold";
  - `csam` → 409 with a new code `HOLD_NOT_RELEASABLE` (added to the closed union with a comment);
  - `already_released` → 409 `HOLD_NOT_RELEASABLE`;
  - `not_found` (unknown id, **or a hold of a different user than `:handle`**) → 404.
- `GET /admin/accounts/:handle` gains `holds: readonly AdminAccountHold[]` (`listAccountHolds`, newest first).

- [ ] **Step 1: Failing tests:**
  - the gate on both POSTs (cross-site 403, no JWT 401);
  - impose dmca → 200 and an active hold;
  - impose csam → 400;
  - duplicate → `created: false`, with exactly one `account_hold` log row;
  - release by a second admin (mint a second JWT with another `adminEmail`) → 200;
  - release by the imposer → 403;
  - release of a csam hold (seeded) → 409;
  - a hold of another user under this handle → 404, and that hold is still active;
  - GET shows the holds.

  Web source pins:
  - the page renders the holds list;
  - an impose form whose category select **excludes** csam, and a release form per active non-csam hold;
  - **every form posts a hidden `intent` field** (`account_action` | `hold_impose` | `hold_release`), and the POST handler branches on it;
  - **the hold section is rendered outside the `account.disabledAt ? … : <form>` branch**, so a banned account's page still shows it (render the page's source for a banned fixture and assert the impose form is present);
  - the guard is still first.
- [ ] **Step 2: Implement**, following the existing handler shapes in `admin-accounts.ts`. On the page (audit #9):
  - `[handle].astro:46-62` today has **one** POST handler that always posts to `/actions`. Read `form.get("intent")` first. `hold_impose` posts `{ category, reason }` to `/admin/accounts/:handle/holds`, `hold_release` posts `{ reason }` to `/admin/accounts/:handle/holds/:holdId/release` (`holdId` from a hidden field), and `account_action` keeps today's body and `/actions` path exactly. Add `<input type="hidden" name="intent" value="account_action" />` to the existing action form.
  - Add a "Legal holds" section **after** the `account.disabledAt ? (<p class="banned">…) : (<form …>)` expression (:132-133 onward), not inside either branch. It shows category, reason, imposed by/at and released by/at, plus the two forms. A csam hold shows "(cannot be released in the app)".
- [ ] **Step 3:** run the new route test, `admin-accounts-route`, `route-protection`, `error-envelope` and the web test; `pnpm typecheck`. Commit `feat(admin): impose and release account legal holds (two admins; csam never)`.

---

### Task 6: Docs, and the #114 and plan-B dependencies

**Files:** modify `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` (§12 AC-3 and the §3.2 reaper bullet, exact text from spec §6), `docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md` (§3.3: add step **7a**, exact text from the account-hold spec §3 T2), `docs/superpowers/plans/2026-10-01-csam-ncmec-pipeline.md` (Task 6, plus the two `#126 … 0020` references → `0021`), and `docs/legal/privacy-policy.md` §5 (#126 also edits it, and has merged by the precondition, so edit on top of its text).

- [ ] In the #114 plan's Task 6, add **step 7a**: `for EVERY uploader in step 3's set, in id order (lock order): imposeAccountHoldInTx(c, { userId, category: "csam", imposedBy: actorAdmin, reason: <case text>, moderationActionId: holdActionId })`, plus a test that an **unbarred** uploader (`cloudflare_match`, flag false) is held. Its Interfaces line now consumes `imposeAccountHoldInTx` from this work.
- [ ] **Plan B's dependency is already wired** (spec §4a): `docs/superpowers/plans/2026-10-01-m4-2c-appeals.md` Task 6 calls `releaseReservedEmail` after lifting a ban, and its Interfaces line cites `apps/api/src/auth/reserved-email.ts`. Both were revised in the spec/plan revision commit, per PM ruling B. Confirm they still read that way, and correct them if not.
- [ ] Privacy §5, account-deletion bullet (⚠️ **draft for attorney review**: mark it so in the PR body, and don't present it as final): add *"A deletion request is delayed, not refused, while the account is subject to a legal hold (for example, during a legal or safety investigation). If an account was banned when its deletion took effect, we keep a one-way hash of its email address while the ban stands, so the address can't be used to create a new account. Our moderation log, which is append-only and kept as the legal record of moderation decisions, keeps the email address recorded at the time of any moderation decision about that account's content; it is not used to contact you."*
- [ ] Grep check: `grep -n "disabled_at\|suspended_until" apps/api/src/auth/anonymise-accounts.ts apps/api/src/auth/reap-unverified.ts` returns only the `CASE WHEN disabled_at IS NOT NULL` hash decision in anonymise (comments excepted). **Control:** the same grep on `login.ts` still finds its bar read.
- [ ] Commit `docs: AC-3 reworded to the hold; #114 gains step 7a; privacy discloses hold-delayed deletion and the hashed email reservation`.

## Whole-branch checks

- [ ] `pnpm typecheck`; the full suites green except the known local `media-backfill` timeouts; e2e green in CI.
- [ ] The PR body lists AH-1…AH-7, each with the test that shows it, plus the five Task 3 mutations' results.
- [ ] Deploy note: the migration (0022, applied after 0020 and 0021 in production, per the precondition) runs before the code.

# Account Legal Hold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account deletion (both reapers) is blocked by an active account legal hold and by nothing else. A banned account deleted while banned keeps its email reserved. Holds come from legal-hold content decisions, from CSAM intake (wired later by #114), and from a manual two-admin admin action.

**Architecture:** A new `account_legal_holds` table, guarded by a trigger that allows only a release, mirrors `media_legal_holds`. One module (`moderation/account-holds.ts`) owns impose, release, list and the reserved-email scrub helper. The reapers swap their ban/suspension predicates for a NOT-EXISTS-hold predicate. `applyDecision` inserts the author's hold in its own transaction when the decision carries a legal hold.

**Tech Stack:** TypeScript on Cloudflare Workers, Postgres via Hyperdrive, Astro SSR admin page, vitest (pool + Node).

**Spec:** `docs/superpowers/specs/2026-10-01-account-legal-hold-design.md` (PR #133, approved by the PM). §n below refers to it. **Read it.**

## Preconditions

- **#132 (plan A) merged.** Task 5 extends `routes/admin-accounts.ts` and `pages/admin/accounts/[handle].astro`, and Task 1's backfill reads plan A's `disabled_reason = 'terminate'`.
- Migration number: the next free number at execution time. **0020 is plan C's (`dsa_notices`) and 0021 is #126's (`moderation_snapshots`)**, so this is 0022 if both have merged. If either hasn't, still take **0022**, and tell the PM the production order is 0020 → 0021 → 0022.

## Global Constraints

- TypeScript **6.0.3**; `errorResponse` with the closed `ApiErrorCode` union; admin POSTs are `checkOrigin` → `requireAdmin` and are listed in `pipeline-exempt.ts`.
- **Deletion eligibility = no active hold. Nothing else** (spec §4). `disabled_at`/`suspended_until` must not appear in either reaper's eligibility predicate afterwards.
- **`signup.ts` is unchanged** (spec §1; AH-6).
- CSAM holds are never released by app code (DB CHECK and route refusal).
- A non-CSAM hold is released only by a **different** admin than the one who imposed it: compare with `sameAdminHand` (`@thinkersjournal/shared`, #98).
- T1's account hold is written **inside** the decision transaction (spec §3 T1), never post-commit.
- Every new `moderation_actions` row goes through `recordModerationAction`.
- PR body: say "Part of" the board items. No issue to close.

## Review Focus

1. **A banned, unheld account requests deletion.** It is scrubbed after 30 days; its email stays; signing up again with that email gets `EMAIL_TAKEN` (AH-2, AH-7). Pinned in Task 3.
2. **A held account that is neither banned nor suspended.** Neither reaper touches it, which proves the hold alone gates deletion (AH-1). Pinned in Task 3.
3. **A legal-hold decision whose transaction fails after the hold insert.** Neither the decision nor the hold survives (AH-3). Pinned in Task 4 with the deferred-constraint-trigger technique plan C proved.
4. **An admin releasing a hold they imposed, with different email casing.** Refused (`sameAdminHand`) (AH-4). Pinned in Task 2.
5. **A second impose of the same category while one is active.** No duplicate and no error (`ON CONFLICT … WHERE released_at IS NULL DO NOTHING` through partial-index inference). Pinned in Task 2.

---

### Task 1: Schema, trigger, action kinds, backfill

**Files:** create `apps/api/migrations/0022_account_legal_holds.sql`; modify `apps/api/src/moderation/actions.ts` (`ModerationActionKind` gains `"account_hold" | "account_hold_release"`), `apps/api/test/migrations.db.test.ts`; test `apps/api/test/account-legal-holds-schema.db.test.ts` (Node project, the `reports-schema.db.test.ts` harness).

- [ ] **Step 1: Failing schema test.** Write every case in full:
  - an UPDATE that sets `released_at`, `released_by` and `release_reason` on an active `dmca` hold succeeds;
  - an UPDATE of `reason` (or any of the 7 non-release columns) is refused with "only released_at/released_by/release_reason may change";
  - an UPDATE of an already-released row is refused with "a released hold is final";
  - DELETE is refused, and TRUNCATE is refused;
  - releasing a `csam` hold is refused by `account_legal_holds_csam_never_released`;
  - setting only `released_at` without `released_by` and `release_reason` is refused by `account_legal_holds_release_consistent`;
  - two active holds of the same category for one user are refused by `account_legal_holds_active_idx`. **Control:** the same category succeeds again after the first is released;
  - `INSERT … ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING` on an active duplicate inserts 0 rows **without error** (proves partial-index inference works);
  - `moderation_actions` accepts `account_hold` and `account_hold_release`;
  - **backfill (AH-5):** the migration is applied by vitest's global setup **before** the test seeds anything, so test the backfill **statement itself**. Export it from the migration as a separately executable SQL block (see Step 2), seed a user with `disabled_reason = 'terminate'` and another with `'ban'`, run the block, and assert exactly one `csam` hold, for the terminated user, `imposed_by = 'system'`. Running it again adds nothing.
- [ ] **Step 2: Migration.** The table and trigger come verbatim from spec §2 (the CREATE TABLE, the partial unique index, and the full `account_legal_holds_guard()` function and its two triggers). Then:

```sql
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    -- ⚠️ Copy the LATEST list from the newest migration that rebuilds this
    -- constraint (0017 at the time of writing; plan C/#126 do not touch it, but
    -- #114's migration adds csam_hold/csam_review — if that has merged, include
    -- them), then append:
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

Write the Down migration in full: drop the triggers, the function and the table, and restore the previous CHECK list.
- [ ] **Step 3:** `apps/api/src/moderation/account-holds.ts` exports `BACKFILL_TERMINATED_HOLDS_SQL` (the identical statement), and the schema test imports it. A Node test reads the migration file and asserts that it **contains** that exact string, so the two copies can't drift.
- [ ] **Step 4:** run `cd apps/api && npx vitest run test/account-legal-holds-schema.db.test.ts` → PASS, and add the `tableExists` up/down assertions to `migrations.db.test.ts`. ⚠️ If the shared local migrations-test DB refuses that file for an unrelated ordering reason, do **not** modify that DB; say so, and leave it to CI. Commit `feat(db): account legal holds — release-only trigger, backfill of terminated accounts`.

---

### Task 2: The hold module

**Files:** create/extend `apps/api/src/moderation/account-holds.ts`; modify `packages/shared/src/admin.ts` (**declare `AdminAccountHold` here**; Task 5 only adds it to `AdminAccountResponse`); test `apps/api/test/account-holds.test.ts` (pool: the module imports `db/client`).

Declare in `packages/shared/src/admin.ts`:
```ts
/** One row of an account's legal-hold history (account-legal-hold spec §2). ISO strings. */
export interface AdminAccountHold {
  readonly id: string;
  readonly category: "csam" | "dmca" | "other";
  readonly reason: string;
  readonly imposedBy: string;
  readonly imposedAt: string;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
  readonly releaseReason: string | null;
}
```

**Produces:**
```ts
export type AccountHoldCategory = "csam" | "dmca" | "other"; // = LegalHoldCategory
export interface ImposeHoldInput { readonly userId: string; readonly category: AccountHoldCategory; readonly imposedBy: string; readonly reason: string; readonly moderationActionId?: string }
export function imposeAccountHoldInTx(c: Client, input: ImposeHoldInput): Promise<{ readonly created: boolean }>;
export function hasActiveAccountHold(c: Client, userId: string): Promise<boolean>;
export type ReleaseOutcome = { kind: "released"; actionId: string } | { kind: "not_found" } | { kind: "csam" } | { kind: "same_admin" } | { kind: "already_released" };
export function releaseAccountHold(c: Client, input: { holdId: string; releasedBy: string; reason: string; subjectLabel: string }): Promise<ReleaseOutcome>;
export function listAccountHolds(c: Client, userId: string): Promise<AdminAccountHold[]>; // newest first, active and released
export function scrubReservedEmailIfUnbanned(c: Client, userId: string): Promise<boolean>; // true if it scrubbed
```

- [ ] **Step 1: Failing tests** (write each in full):
  - impose creates a hold, and a second impose of the same category returns `created: false` with no new row (**RF5**);
  - `hasActiveAccountHold` is true, then false after a release;
  - **release:** by a different admin → `released`, with a `moderation_actions` row of kind `account_hold_release`. **RF4:** release by the imposer in different case (`Mod@X` imposed, `mod@x ` releases) → `same_admin`, with no change and no log row. A `csam` hold → `csam`. An unknown id → `not_found`. A second release → `already_released`;
  - `scrubReservedEmailIfUnbanned`:
    - an anonymised account that is no longer banned → the email is scrubbed (to `scrubbedEmail(id)`, from `anonymise-accounts.ts`; export it if it isn't exported) → `true`;
    - a non-anonymised account → unchanged, `false`;
    - an anonymised account **still banned** → unchanged, `false`.
- [ ] **Step 2: Implement.**
  - `imposeAccountHoldInTx`: one `INSERT … ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING RETURNING id`; `created` is whether a row was returned.
  - `releaseAccountHold`: owns a `BEGIN_BOUNDED_TX`, with the rollback-quietly discipline from `decide.ts`. It runs `SELECT … FOR UPDATE`, refuses as specified (`sameAdminHand(row.imposed_by, releasedBy)` → `same_admin`), records `account_hold_release` with `recordModerationAction` (`subjectUserId`, `subjectLabel`, the reason, and `internalNote` = hold id), then `UPDATE … SET released_at = now(), released_by = $2, release_reason = $3 WHERE id = $1`.
  - `scrubReservedEmailIfUnbanned`: `UPDATE users SET email = $2 WHERE id = $1 AND anonymised_at IS NOT NULL AND disabled_at IS NULL AND email <> $2`, using `scrubbedEmail(id)` as `$2`.
- [ ] **Step 3:** run → PASS; commit `feat(moderation): account-hold module — impose, release (two admins, never csam), list, reserved-email scrub`.

---

### Task 3: The reapers gate on the hold; a banned account's email is kept

**Files:** modify `apps/api/src/auth/anonymise-accounts.ts`, `apps/api/src/auth/reap-unverified.ts`; **rewrite** the two named blocks in `apps/api/test/anonymise-accounts.test.ts` (`describe("anonymiseExpiredAccounts — a barred account is never scrubbed")`) and `apps/api/test/reap-unverified.test.ts` (`describe("reapUnverifiedAccounts — a barred account is never reaped (AC-3)")`); add re-signup tests to `apps/api/test/signup.test.ts` (or the file holding signup's conflict tests: grep for `EMAIL_TAKEN`).

⚠️ **Rewrite those two blocks for the NEW rule. Do NOT make them pass by putting the ban checks back** (spec §4).

- [ ] **Step 1: Rewritten and new tests** (write each in full):
  - **anonymise, AH-2:** banned, suspended and lapsed-suspended accounts with **no** hold and a 31-day-old deletion request **are** anonymised.
  - **anonymise, AH-1 / RF2:** a held account (any category) that is not banned, a held **banned** account, and a held suspended account are **not** anonymised. After releasing a `dmca` hold, the next run anonymises that account.
  - **anonymise, AH-7 / RF1:**
    - a banned, unheld account is anonymised **with `users.email` unchanged**, while `password_hash`, `username`, `display_name` and `bio` are all scrubbed;
    - a **non-banned** account's email is scrubbed (control);
    - signing up again with the banned account's retained email → **409 `EMAIL_TAKEN`**, the same body a taken email gets, through the real `POST /auth/signup` (copy that suite's harness);
    - after `UPDATE users SET disabled_at = NULL` plus `scrubReservedEmailIfUnbanned`, the email is scrubbed.
  - **reap-unverified, AH-1/AH-2:** unverified, 8-day-old accounts that are banned or suspended **without** a hold are deleted; with a hold (banned or not) they survive.
  - **Mutation (AH-1):** remove the NOT-EXISTS clause from `anonymise-accounts.ts` → the held-account test fails. Restore it.
  - **Mutation (AH-7):** make the email always scrub → the retained-email test fails. Restore it.
- [ ] **Step 2: Implement.**
  - **anonymise-accounts.ts:**
    - The SELECT replaces `AND disabled_at IS NULL AND suspended_until IS NULL` with `AND NOT EXISTS (SELECT 1 FROM account_legal_holds h WHERE h.user_id = users.id AND h.released_at IS NULL)`, and also selects `disabled_at IS NOT NULL AS banned`.
    - In the scrub loop, `email = CASE WHEN $4 THEN email ELSE $2 END`, with `$4 = banned`. Keep the `password_hash`, `profiles` and `password_reset_tokens` scrubs exactly as they are.
    - Rewrite the header comment: the hold, not a ban, is the gate (CireSnave's ruling, quoted); a banned account's email stays reserved (board item 93).
  - **reap-unverified.ts:** the same swap in its inner SELECT, with the header comment rewritten to match the reworded AC-3.
- [ ] **Step 3:** run `anonymise-accounts`, `reap-unverified`, the signup suite and `signup-barred`/`barred-reentry` (**AH-6**: signup's guard is unchanged and its tests still pass) → PASS. Run both mutations. Commit `feat(auth): deletion gated on an account legal hold, not on ban/suspension; a banned account keeps its email reserved`.

---

### Task 4: T1, the legal-hold decision holds the author's account in-transaction

**Files:** modify `apps/api/src/moderation/decide.ts` (`DecisionInput.accountHold?`; insert after `recordModerationAction`), `apps/api/src/routes/admin.ts` (pass `accountHold: legalHold === true ? { category: legalHoldCategory } : undefined` into `applyDecision`); test `apps/api/test/admin-decision-route.test.ts` (append).

- [ ] **Step 1: Failing tests** (write each in full):
  - `remove` with `legalHold: true, legalHoldCategory: "dmca"` → the author has an active `dmca` account hold whose `moderation_action_id` is the decision's `actionId`;
  - a decision without a legal hold → no account hold;
  - **AH-3 / RF3:** add a **deferred constraint trigger** on `account_legal_holds`, scoped by `WHEN (NEW.user_id = '<author>')`, that raises at COMMIT (the exact technique of plan C's `admin-dsa-notices.test.ts` "atomicity (failure AFTER the resolve step)": unique names, dropped in `finally`). Call `applyDecision` directly with `accountHold`. It rejects, and afterwards the content's `hidden_at` is unchanged, no new `moderation_actions` row exists, and **no hold exists**.
- [ ] **Step 2: Implement.** In `decide.ts`, immediately after `const actionId = await recordModerationAction(...)`:

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

`DecisionInput` gains `readonly accountHold?: { readonly category: LegalHoldCategory }` (import the type from `../media/legal-hold`). If plan B has merged and split `applyDecisionInTx`, place it in the same spot there.
- [ ] **Step 3:** run `admin-decision-route`, `moderation-actions.db`, `admin-dsa-notices` (if plan C has merged: its in-tx DSA block shares this function) → PASS. Commit `feat(moderation): a legal-hold decision holds the author's account in the decision's transaction`.

---

### Task 5: T3, manual impose/release, and the admin page

**Files:** modify `apps/api/src/routes/admin-accounts.ts`, `apps/api/src/routes.ts`, `apps/api/test/helpers/pipeline-exempt.ts`, `packages/shared/src/admin.ts` (`AdminAccountResponse` gains `holds: readonly AdminAccountHold[]`; the type itself is declared in Task 2), `apps/web/src/pages/admin/accounts/[handle].astro`; tests `apps/api/test/admin-account-holds-route.test.ts` (the admin JWT harness copied **by symbol** from `admin-decision-route.test.ts`: imports, `TEAM`/`AUD`/`KID`, `b64url`, `b64urlJson`, all five module-scope `let`s, `makeJwt`, `ctxRun`, `call`, and the module-level `beforeEach`/`afterEach`), `apps/web/test/admin-account-page.test.ts` (append).

**Routes:**
- `POST /admin/accounts/:handle/holds` `{ category: "dmca" | "other", reason }`. `csam` → `400 INVALID_INPUT`; a blank reason → 400. In one transaction: `recordModerationAction(account_hold)`, then `imposeAccountHoldInTx`. A duplicate active category → `200 { created: false }`, with **no** log row (check first, inside the transaction).
- `POST /admin/accounts/:handle/holds/:id/release` `{ reason }` → `releaseAccountHold`. Mapping:
  - `same_admin` → 403 `FORBIDDEN` with message "a different admin must release this hold";
  - `csam` → 409 with a new code `HOLD_NOT_RELEASABLE` (added to the closed union with a comment);
  - `already_released` → 409 `HOLD_NOT_RELEASABLE`;
  - `not_found`, or a hold belonging to a different user than `:handle` → 404.
- `GET /admin/accounts/:handle` gains `holds: readonly AdminAccountHold[]` (newest first).

- [ ] **Step 1: Failing tests:**
  - the gate on both POSTs (cross-site 403, no JWT 401);
  - impose dmca → 200 and an active hold;
  - impose csam → 400;
  - duplicate → `created: false`, with exactly one `account_hold` log row;
  - release by a second admin (mint a second JWT with another `adminEmail`) → 200;
  - release by the imposer → 403;
  - release of a csam hold (seeded) → 409;
  - a hold of another user under this handle → 404;
  - GET shows the holds.

  Web source pins: the page renders the holds list, an impose form whose category select **excludes** csam, and a release form per active non-csam hold. The guard is still first.
- [ ] **Step 2: Implement**, following the existing handler shapes in `admin-accounts.ts`. The page shows "Legal holds" with category, reason, imposed by/at, released by/at, plus the two forms. A csam hold shows "(cannot be released in the app)".
- [ ] **Step 3:** run the new route test, `admin-accounts-route`, `route-protection`, `error-envelope` and the web test; `pnpm typecheck`. Commit `feat(admin): impose and release account legal holds (two admins; csam never)`.

---

### Task 6: Docs, and the #114 and plan-B dependencies

**Files:** modify `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` (§12 AC-3 and the §3.2 reaper bullet, exact text from spec §6), `docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md` (§3.3: add step **7a**, exact text from the account-hold spec §3 T2), `docs/superpowers/plans/2026-10-01-csam-ncmec-pipeline.md` (Task 6, plus the two `#126 … 0020` references → `0021`), and `docs/legal/privacy-policy.md` §5.

- [ ] In the #114 plan's Task 6, add **step 7a**: `for EVERY uploader in step 3's set: imposeAccountHoldInTx(c, { userId, category: "csam", imposedBy: actorAdmin, reason: <case text>, moderationActionId: holdActionId })`, plus a test that an **unbarred** uploader (`cloudflare_match`, flag false) is held. Its Interfaces line now consumes `imposeAccountHoldInTx` from this work.
- [ ] **Plan B's dependency is already wired** (spec §4a): `docs/superpowers/plans/2026-10-01-m4-2c-appeals.md` Task 6 calls `scrubReservedEmailIfUnbanned` after lifting a ban (PR #128). Confirm its Interfaces line cites `apps/api/src/moderation/account-holds.ts`; correct it there if it doesn't.
- [ ] Privacy §5, account-deletion bullet: add *"A deletion request is delayed, not refused, while the account is subject to a legal hold (for example, during a legal or safety investigation). If an account was banned when its deletion took effect, its email address stays reserved while the ban stands, so it can't be used to create a new account."*
- [ ] Grep check: `grep -n "disabled_at\|suspended_until" apps/api/src/auth/anonymise-accounts.ts apps/api/src/auth/reap-unverified.ts` returns only the email-keep `banned` read in anonymise (comments excepted). **Control:** the same grep on `login.ts` still finds its bar read.
- [ ] Commit `docs: AC-3 reworded to the hold; #114 gains step 7a; privacy discloses hold-delayed deletion and the reserved email`.

## Whole-branch checks

- [ ] `pnpm typecheck`; the full suites green except the known local `media-backfill` timeouts; e2e green in CI.
- [ ] The PR body lists AH-1…AH-7, each with the test that shows it, plus both Task 3 mutations' results.
- [ ] Deploy note: the migration (0022, after 0020 and 0021 in production) runs before the code.

# Account Legal Hold — Design

**Status:** Approved in sections by the PM, 2026-10-01 (design note + rulings below), and written here for audit, then plan.
**Revised 2026-10-01** after the pre-flight audit: PM ruling B replaces §4a's "keep the real email" with a hashed
reservation, and the audit's mechanical findings are folded into §3, §4, §5 and §6. **Revision round 2 (2026-10-01):**
the re-audit's B1 (per-row revocation and a fail-closed pipeline gate, §4), S2 (what the moderation log keeps, §4a),
S3, N1 and N3. **Round 3:** the reaper also revokes BEFORE each scrub, which covers the GET path (§4).
**Author:** Community controller agent, 2026-10-01. Board item 91 (superseded by this).

## 0. Rulings

- **CireSnave** (relayed by the PM, verbatim): *"A legal hold should block deletion. A legal hold is not the same as a simple
  suspension. Do we need to separate the two?"* The PM answered yes: build an account-level legal hold that mirrors
  `media_legal_holds`.
- **PM:**
  - `disabled_at`/`suspended_until` become **pure access-control** fields.
  - **Deletion eligibility checks only the account hold.**
  - Applies to both reapers:
    - `anonymise-accounts` (user-requested deletion);
    - `reap-unverified` (the 7-day unverified reaper). For this one the PM ruled himself: *"applying the SAME principle he just
      decided ... to a second reaper with the identical underlying concern"*. **Spec AC-3 is reworded to reference the hold.**
  - Trigger points T1–T3 (§3) approved.
  - #132 keeps no deletion change; this lands as its own PR.
- **Board item 93 (F1), RULED by CireSnave, option 2** (relayed by the PM): *scrub everything else about a banned account on
  deletion as normal, but leave the EMAIL reserved/unscrubbed while the ban stands — not deleted, not released for a new
  signup.* The **outcome** (the address can't be used for a new signup while the ban stands) is built here, in §4a. The
  **mechanism** was replaced by the next ruling.
- **PM ruling B (2026-10-01), replacing "keep the real email"**, after the audit found three mail paths that would reach a
  deleted user. The PM's words, verbatim: *"Approve B … B structurally can't mail a deleted user because the real address
  no longer exists anywhere to send to. It's also a real data-minimization win … Go with the SHA256-of-normalized-email
  approach for barred-re-entry matching."* So the email is replaced at deletion like any other account's, a banned
  account's address is reserved by a hash column on `users`, and signup compares against it (§4a).

## 1. What changes for a user

| Account state | Can log in? | Deletion request scrubs it after 30 days? | Unverified reaper deletes it after 7 days? |
|---|---|---|---|
| Ordinary | yes | yes | yes (if unverified) |
| Suspended, or a lapsed suspension | per `isBarred` (unchanged) | **yes**, unless held | **yes**, unless held |
| Banned (not held) | no (unchanged) | **yes**, email included; a **hash** of the email reserves the address while the ban stands (§4a) | **yes** (see §4a's note) |
| **Any state + an active account legal hold** | per `isBarred` | **no**: the request is recorded and waits | **no** |

`signup.ts`'s upsert guard (it refuses to overwrite a **barred** unverified row) is access control and **stays unchanged**
(PM confirmed). Otherwise a stranger could take over a barred account by re-signing up (#50 Q3b). Signup gains exactly
one refusal, the reserved-hash check of §4a, which gives the same response.

## 2. Data

```sql
CREATE TABLE account_legal_holds (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id              uuid NOT NULL,          -- bare: evidence outlives its subject (same reasoning as 0013)
  category             text NOT NULL CHECK (category IN ('csam', 'dmca', 'other')),
  imposed_by           text NOT NULL,          -- Access identity, or 'system' for an automatic hold
  moderation_action_id uuid,                   -- bare: the action that triggered it
  reason               text NOT NULL,
  imposed_at           timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz,
  released_by          text,
  release_reason       text,
  CONSTRAINT account_legal_holds_release_consistent CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL)),
  -- ⚠️ CSAM holds are never released by the app (legal-hold.ts's rule, mirrored).
  CONSTRAINT account_legal_holds_csam_never_released CHECK (category <> 'csam' OR released_at IS NULL)
);
-- At most one ACTIVE hold per (user, category); history is kept.
CREATE UNIQUE INDEX account_legal_holds_active_idx ON account_legal_holds (user_id, category) WHERE released_at IS NULL;
```

And on `users` (§4a, PM ruling B):

```sql
ALTER TABLE users
  ADD COLUMN reserved_email_sha256 text NULL,
  -- lowercase hex, exactly what sha256Hex (src/auth/encoding.ts) emits
  ADD CONSTRAINT users_reserved_email_sha256_hex
    CHECK (reserved_email_sha256 ~ '^[0-9a-f]{64}$'),
  -- only a deleted account reserves anything; a live row's own email does that job
  ADD CONSTRAINT users_reserved_email_only_anonymised
    CHECK (reserved_email_sha256 IS NULL OR anonymised_at IS NOT NULL);
-- NOT unique (§4a says why).
CREATE INDEX users_reserved_email_sha256_idx ON users (reserved_email_sha256)
  WHERE reserved_email_sha256 IS NOT NULL;
```

Unlike `media_legal_holds`, which is permanent per key, this table keeps released rows as history, because a DMCA or
other hold on an account may legitimately end. A release is an UPDATE. Everything else is refused:

```sql
CREATE FUNCTION account_legal_holds_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'account_legal_holds is append-only (release by UPDATE of the release columns)';
  END IF;
  -- UPDATE: only a release of a currently-active hold, and only the three release columns change.
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_legal_holds: a released hold is final';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.category IS DISTINCT FROM OLD.category OR NEW.imposed_by IS DISTINCT FROM OLD.imposed_by
     OR NEW.moderation_action_id IS DISTINCT FROM OLD.moderation_action_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.imposed_at IS DISTINCT FROM OLD.imposed_at THEN
    RAISE EXCEPTION 'account_legal_holds: only released_at/released_by/release_reason may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_legal_holds_row_guard BEFORE UPDATE OR DELETE ON account_legal_holds
  FOR EACH ROW EXECUTE FUNCTION account_legal_holds_guard();
CREATE TRIGGER account_legal_holds_no_truncate BEFORE TRUNCATE ON account_legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION account_legal_holds_guard();
```

(For TRUNCATE, `OLD` is unavailable, which is why that branch **raises** first, before anything reads `OLD`.) The release-consistency and
CSAM-never-released CHECKs apply on top.

## 3. Trigger points

- **T1: content decision with a legal hold.** `POST /admin/decision` with `legalHold: true` already holds the content's
  images. ⚠️ That image hold runs **after** the decision commits, as a best-effort side effect
  (`applyMediaVisibilityChange`, `visibility-hook.ts`; `legalHold`/`legalHoldCategory` are parsed in `routes/admin.ts`
  and never reach `DecisionInput`). The account hold is **new in-transaction behaviour**, not a copy of that pattern:
  - thread the category from the route into `DecisionInput` as `accountHold?: { readonly category: LegalHoldCategory }`;
  - the route casts it the way it already does for the image hold (`legalHoldCategory as LegalHoldCategory`,
    `admin.ts:172`): at `admin.ts:118` the value is `unknown`, validated but not narrowed;
  - `applyDecision` (`applyDecisionInTx` once plan B lands) inserts the author's hold (`row.author_id` is in scope)
    after `recordModerationAction` **and after #134's DSA-resolution block**, which #134 inserts at that same spot. It
    uses the decision's action id and `ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING`.

  A failure anywhere in the decision then leaves neither a decision nor a hold (AH-3). The image hold stays post-commit,
  as it is.
- **T2: CSAM intake (#114).** Every uploader in a case gets a `csam` account hold in the intake transaction, **whether or
  not R1 bars them** (a hold blocks deletion, not access). ⚠️ This is a **new step 7a over the FULL uploader set** that
  step 3 resolves. It is **not** a line inside step 7: step 7 loops only over the uploaders §3.4 bars, so adding it
  there would leave every unbarred uploader deletable. 7a runs for every uploader, before or after step 7, with the
  case's `csam_hold` action id. The #114 spec (§3.3) and plan (Task 6) are updated in this PR to add 7a, with a test
  that an **unbarred** uploader (`CSAM_BAR_UNREVIEWED_MATCH = false`, `cloudflare_match`) is held. While there, the #114
  plan's two references to `#126 … migration 0020` become `0021` (#126 was renumbered).
- **T3: manual.**
  - **Impose:** `POST /admin/accounts/:handle/holds` `{ category: "dmca" | "other", reason }`. `csam` is excluded here:
    CSAM holds come only from T1/T2, where there is evidence of the case. One transaction locks the `users` row, checks
    for an active hold of that category, and only then writes the log row and the hold. A duplicate writes nothing, and
    two concurrent imposes serialise on the lock.
  - **Release:** `POST /admin/accounts/:handle/holds/:id/release` `{ reason }`. It is refused for `csam`, and **refused
    when the releasing admin is the one who imposed it** (`sameAdminHand`, #98: the two-person pattern from #61).
  - Both write a `moderation_actions` row. New kinds: `account_hold`, `account_hold_release`.
- The **admin account page** shows active holds and their history, with impose and release forms.

## 4. Deletion eligibility

Both reapers replace their `disabled_at`/`suspended_until` predicates with:

```sql
AND NOT EXISTS (SELECT 1 FROM account_legal_holds h WHERE h.user_id = users.id AND h.released_at IS NULL)
```

- `anonymise-accounts.ts`: the hold check is the **only** deletion-eligibility gate besides its existing
  deletion-requested-30-days condition.
- `reap-unverified.ts`: the same.
- Their header comments are rewritten to say why a hold, not a ban, is the gate.
- A held account's deletion request stays recorded. Once the hold is released, the next nightly run proceeds.
- **Re-checked at the write, under a lock.** `anonymise-accounts` selects its batch first and scrubs each row later. In
  that gap a hold can be imposed (T1–T3), a ban imposed or lifted (plan A, plan B), or the request cancelled. So each
  scrub runs in its own transaction. It locks the `users` row (`FOR UPDATE`), then runs an `UPDATE` that re-checks the
  hold (`NOT EXISTS`), the 30-day request and `anonymised_at IS NULL`, and decides the hash with
  `CASE WHEN disabled_at IS NOT NULL`. The profile and reset-token scrubs run only if that `UPDATE` changed the row.
  Every hold imposer locks the same row first, so a hold that commits while the reaper waits is visible to the reaper's
  next statement. (A `NOT EXISTS` inside a blocked `UPDATE` alone isn't enough: READ COMMITTED's re-check re-reads the
  target row, not the subquery.)
- **Revoked per row, and one row's failure never stops the batch (re-audit B1).** Each scrub's `BEGIN_BOUNDED_TX` has
  a 5 s `lock_timeout` (`db/client.ts:51-53`), so a scrub can fail on a locked row. The reaper:
  - bumps each row's security epoch **before** its scrub transaction. If that bump fails, it logs the user id and
    skips the row: nothing is scrubbed, so this fails closed, and the next nightly run retries it. If the scrub then
    fails or its re-check says no, the user has merely been logged out, which is harmless: they asked for deletion 30
    or more days ago, or a hold has just landed;
  - bumps it **again** right after **that row's** COMMIT, which closes the window for a login that lands between the
    two bumps;
  - on any per-row scrub failure (a lock timeout or any other error), logs the user id, skips the row and continues.
    A failed row is still unscrubbed, so skipping it is safe, and the next nightly run retries it;
  - counts the outcomes and logs `anonymised S, skipped (re-check) K, failed F of N` after the loop (`console.error`
    when F > 0). When some row failed and none was scrubbed (`failed > 0 && scrubbed === 0`), it **throws** after the
    loop: that is a dead connection or a down Durable Object, not a bad row, so the cron fails visibly. Keyed on
    nothing scrubbed rather than F = N, so rows the re-check merely skipped (held, cancelled) can't mask a dead
    connection (ruling M5). A partial failure, with at least one row scrubbed, doesn't throw.

  ⚠️ `main`'s current reaper has the same latent shape: it bumps epochs only **after** the loop, so an error mid-batch
  leaves every already-scrubbed account with its sessions live. This task closes that.
- **Defence in depth, fail closed (re-audit B1).** The mutating session pipeline (`runMutatingPipeline`,
  `auth/pipeline.ts`) already reads the session user's `users` row (`readAccountGate`, ~:83). It also reads
  `anonymised_at`, and treats `anonymised_at IS NOT NULL` as unauthenticated: the same 401 and cleared cookie a revoked
  session gets, before the barred check. So a missed epoch bump can never **act** as a deleted account.
- ⚠️ **Accepted residual: the GET path.** `readCurrentSession` (the GET-side session check, `pipeline.ts:157`, 16 call
  sites) checks only the epoch and reads no row, so step 5a doesn't cover it. The pre-scrub bump does: any session
  issued before the scrub dies at bump #1, and one issued between the bumps dies at bump #2. What remains is a session
  created inside that window **and** a failed bump #2. A lost COMMIT acknowledgement has the same effect: the scrub
  committed, but `scrubOne` threw, so the row counts as failed and bump #2 is skipped. Step 5a still refuses that
  session's writes, and the next run doesn't retry the row (it's already anonymised). Either way the residual is
  GET-only, read-only, and sees an account already scrubbed. Mutating routes fail closed through step 5a regardless. Accepted (controller ruling, 2026-10-01) rather
  than threading `ctx` through 16 call sites for a DB read.
- **`GET /verify-email`** reads the session itself (`readSession` plus the epoch). The only thing a deleted account's
  session could do there is set `email_verified_at` on its own anonymised row, and only with a live 24 h verify token,
  which can't be mailed to the sentinel. The plan still adds `AND anonymised_at IS NULL` to that route's `UPDATE`, so
  it writes nothing to a deleted account.
- ⚠️ **Two existing test blocks assert the OLD rule and must be REWRITTEN, not made to pass by putting the ban checks
  back:**
  - `apps/api/test/reap-unverified.test.ts`, `describe("reapUnverifiedAccounts — a barred account is never reaped (AC-3)")`;
  - `apps/api/test/anonymise-accounts.test.ts`, `describe("anonymiseExpiredAccounts — a barred account is never scrubbed")`.

  Their banned/suspended fixtures with **no** hold now **are** reaped or scrubbed (AH-2). New fixtures that **insert an
  `account_legal_holds` row** survive (AH-1), including one that is held but neither banned nor suspended, which proves
  the hold alone gates it.

## 4a. A banned account's email stays reserved, by a keyed fingerprint (board item 93; PM ruling B; amended 2026-10-02)

> **Amended 2026-10-02 (migration `0023_reserved_email_hmac`, PM-approved design).** 0022's unsalted SHA-256 could be
> reversed by hashing candidate addresses. The reservation is now `users.reserved_email_hmac`, the lowercase-hex
> HMAC-SHA-256 of the normalised email keyed by the `api` Worker secret `RESERVED_EMAIL_KEY`. The reaper writes only that
> column. 0022's `reserved_email_sha256` was dropped in 0025 (2026-10-03), once production confirmed 0 such rows; signup
> and `releaseReservedEmail` now touch only `reserved_email_hmac`. Without the key the code fails closed: signup
> answers `503 SERVICE_UNAVAILABLE`, and the reaper does not scrub a banned row (a counted, logged, retried per-row
> failure) while it scrubs the others. §2's SQL and AH-7 below describe 0022 as built; this section describes HEAD.

- **At deletion, every account loses its real email, banned or not.** `anonymise-accounts.ts` replaces `users.email`
  with the undeliverable sentinel `deleted-<id>@invalid.thinkersjournal.local` and `password_hash` with the unusable
  sentinel `!anonymised!`, exactly as today, along with the rest of its scrub. If the account is banned at that moment
  (`disabled_at IS NOT NULL`; in steady state, once #114 lands, that means a ban, because a termination is always
  held by T2/7a or the backfill and never reaches the reaper), the same `UPDATE` also stores `users.reserved_email_hmac`, the
  lowercase-hex HMAC-SHA-256 of the normalised email under `RESERVED_EMAIL_KEY` (0023). A suspended account reserves nothing.
- **The normalisation is signup's own.** `packages/shared/src/schemas.ts:33` is
  `const NormalizedEmail = z.email().toLowerCase();`, and signup, login and forgot-password all parse `email` with it.
  zod 4.6.5's `toLowerCase()` (the version `packages/shared` resolves) is `_overwrite((input) => input.toLowerCase())`. The plan exports that transform as
  `normalizeEmail` and has `NormalizedEmail` apply it with `.overwrite(normalizeEmail)`, so the hash and signup run the
  same function and can't disagree. The fingerprint is `reservedEmailHmac` (`apps/api/src/auth/reserved-email.ts`,
  WebCrypto HMAC); 0022 used `sha256Hex` (`apps/api/src/auth/encoding.ts`), which survives only to find legacy rows.
- **Signup refuses a reserved address with the response it already gives a barred one.** Today a barred row's address is
  refused by the upsert's `WHERE` (`signup.ts` ~L264): it updates 0 rows, so the answer is `409 EMAIL_TAKEN`. That
  clause is unchanged. A deleted account's row no longer holds the address, so the upsert succeeds. Signup then checks,
  in the same transaction, whether the address's HMAC matches any `reserved_email_hmac` (the legacy `reserved_email_sha256`
  check was removed with the column, 0025). If it does, signup rolls
  back and answers the same `409 EMAIL_TAKEN`. The check runs **after** the upsert, not before. Until the reaper's
  scrub commits, its row still holds the address, so the upsert conflicts with that row and the barred clause refuses
  it. Once the upsert gets through without that conflict, the scrub has committed, and the next statement's snapshot
  sees its hash. A check run before the upsert could miss a scrub that commits between the two.
- **The mail paths.** The audit found three paths that would have mailed a deleted, banned user if the real email had
  been kept:
  - the notification email drain (`runEmailDrain`'s `SELECT_ELIGIBLE`, `email-drain.ts`);
  - forgot-password → reset-password (`handleForgotPassword` → `createResetToken` → `handleResetPassword`, which would
    also have written a working password);
  - the decision notice (`sendModerationNotice(env, result.authorEmail, …)` in `admin.ts`, fed by `applyDecision`).

  Under ruling B the real address is no longer on the account row, and those paths read only `users.email`, so each of
  them can only address the sentinel, whose domain is never registered. Pinned structurally (AH-7): after a banned
  account is anonymised, its `email` is the sentinel, its `password_hash` is unusable, and forgot-password for the
  original address sends nothing. The first two paths are **also guarded** against an anonymised row (rulings I2 and
  M7, Task 3 fix round 1), because a scrub can commit between a path's read and its write:
  - the drain's `SELECT_ELIGIBLE` filters `u.anonymised_at IS NULL`, so nothing is ever sent to the sentinel;
  - `createResetToken` inserts with `INSERT … SELECT … FROM users WHERE id = $1 AND anonymised_at IS NULL FOR KEY
    SHARE` and returns `null` when it inserted nothing; forgot-password then mails nothing and answers the same `202`.
    `FOR KEY SHARE` makes the insert wait for an in-flight scrub's `FOR UPDATE` and re-check the committed row;
  - `handleResetPassword`'s password `UPDATE` requires `anonymised_at IS NULL`; on 0 rows it rolls back and answers
    the generic `400 INVALID_RESET_TOKEN`, with no epoch bump and no session.

  The decision notice is not guarded here; it can only address the sentinel, and a guard is a filed follow-up.
- **"While the ban stands":** lifting the ban ends the reservation. `releaseReservedEmail(c, userId)`
  (`apps/api/src/auth/reserved-email.ts`) sets `reserved_email_hmac` to NULL once `disabled_at` is NULL, and does
  nothing otherwise. There's nothing to scrub, because the address is already gone from the account row, so after the
  release it's simply free for a new signup. The app has no unban path until plan B lands. This PR builds and tests the helper, and amends
  plan B's plan (`2026-10-01-m4-2c-appeals.md`, Task 6, `resolveAppeal`'s `user_ban` branch) to call it right after the
  ban is lifted, so the obligation travels with the plan its implementer reads.
- **The index is not unique.** `users.email` is `citext UNIQUE` (0001), so only one live row holds an address at a
  time, and the signup refusal makes a second reservation of the same hash unreachable today. The lookup is an
  `EXISTS`, which needs no uniqueness. A UNIQUE index would protect nothing anything reads. And if a future path (an
  email-change route, say) ever reserved a hash twice, every such row's scrub would fail on the violation, night after
  night. The reaper would skip only that row (a per-row error is logged, the row is retried nightly, and the failure
  count is visible, §4), but the account would never be deleted.
- ⚠️ **What still holds the address (re-audit S2, final review).** The moderation log keeps it, in two columns:
  - `moderation_actions.subject_label` records the author's email at the time of each content decision about their
    posts or comments (`applyDecision`, `decide.ts`: `subjectLabel: row.email`);
  - `moderation_actions.actor_admin` records the author's **own** email on every author hide and unhide of their own
    post (`hidePost` and `unhidePost`, `moderation/author-hide.ts`: `actorAdmin: row.email`, #61).

  Plan A's account actions label with the handle (`handleAdminAccountAction`, `admin-accounts.ts`:
  `subjectLabel: account.username`). That table is append-only and is kept as the legal record, so anonymisation
  doesn't touch either column. No mail or authentication path reads it. The guarantee this design makes is
  therefore that **no mail or authentication path can reach a deleted account's address**, not that the address
  exists nowhere. A manual hold (T3) labels its log row with the handle, not the email, so it adds no new copy. The
  privacy policy says this (best safe guesses, 2026-10-02).
- **Privacy.** A plain SHA-256 of an email isn't anonymous: anyone holding the table can test a guessed address. That
  is why 0023 keys it: without `RESERVED_EMAIL_KEY`, which lives only as a Workers secret, a guessed address can't be
  tested against `reserved_email_hmac`. Someone holding both the table and the key still can. It's kept only for a banned
  account, only while the ban stands, and in place of the address itself. Rotating the key releases every reservation
  (an old fingerprint never matches a new key's), so it is not rotated casually (docs/runbooks/deploy.md). The privacy
  policy discloses it (§5).
- **A hold on an already-anonymised account is invisible to the admin UI.** The account admin routes resolve
  `:handle` with `findByHandle` (`admin-accounts.ts`), which filters `anonymised_at IS NULL`, so such a hold can't be
  viewed or released there. That is harmless, because the scrub has already happened and the hold blocks nothing; an
  operator can release it with SQL if ever needed.
- **The unverified reaper** hard-DELETEs rows, so a banned unverified account with no hold is deleted outright, and no
  hash is stored. That reopens the evasion only for an account that **never verified its email**, which couldn't post.
  It's accepted and stated, and it's consistent with the PM's AC-3 ruling (a hold, not a ban, protects).

## 5. Migration and backfill

- Migration: the table, the trigger, the two new `moderation_actions` action kinds (rebuild the CHECK from the
  **latest** list), and `users.reserved_email_sha256` with its CHECKs and partial index (§2).
- ⚠️ **Order:** this is 0022. #134 (0020, `dsa_notices`) and #126 (0021, `moderation_snapshots`) must merge, and be
  applied in production, before this PR merges. node-pg-migrate checks order by position, and the production gate takes
  the newest file as the expected schema.
- **Backfill (in the same migration):** every account whose `disabled_reason = 'terminate'` gets a `csam` hold
  (`imposed_by = 'system'`, `reason = 'backfill: terminated before account holds existed'`). Without it, the switch would
  make previously-protected terminated accounts deletable.
- ⚠️ **The backfill's signal only exists once plan A's code is live.** On `main`, nothing writes
  `disabled_reason = 'terminate'` yet (plan A's `account-actions.ts`, PR #132, is the only writer). Merge order then
  doesn't matter: the backfill is idempotent (`ON CONFLICT … DO NOTHING`), and every terminate made **after** this lands
  is held by T2/7a at the moment of termination. The backfill covers only terminations that happened before this
  migration, by hand or by plan A's code.
- **Plain bans** (`disabled_reason = 'ban'`) are **not** backfilled. That's the decision CireSnave made: a ban is not a
  legal hold. Accounts that were only suspended aren't either. As of 2026-10-01 production has no barred accounts
  (pre-launch), so in practice the backfill is a no-op. The SQL still exists because the code must not depend on that.

## 6. Acceptance conditions

| # | Condition |
|---|---|
| AH-1 | An account with an active hold is **not** anonymised and **not** reaped, whatever its ban or suspension state. Shown to fail without the hold check. |
| AH-2 | An account with **no** hold is anonymised or reaped normally **even if banned or suspended**. This is the decoupling, and AC-3 is reworded to match. |
| AH-3 | T1: a `legalHold` decision creates the author's account hold in the same transaction (a forced failure leaves neither). |
| AH-4 | A CSAM hold cannot be released: the route refuses, and the DB CHECK refuses. A non-CSAM hold cannot be released by its imposer. |
| AH-5 | The backfill holds every terminated account and no plain-banned one. |
| AH-6 | `signup.ts`'s barred-row guard (the upsert's `WHERE`) is unchanged, and its existing tests in `barred-reentry.test.ts` still pass. Signup's only addition is the reserved-hash refusal (§4a). |
| AH-7 | Deleting a banned account scrubs it like any other (`email` is the sentinel, `password_hash` is unusable) and stores `reserved_email_sha256`. Signing up again with that address, in any letter case, gets the barred case's `409 EMAIL_TAKEN`. Forgot-password for it sends nothing. Deleting a non-banned account stores no hash. Once the ban is lifted, `releaseReservedEmail` clears the hash and the address can sign up. Shown to fail when the `CASE` always stores NULL. |

**Spec edit (AC-3):** in `2026-09-06-m4-moderation-queue-design.md` §12, AC-3 becomes *"A **legally held** unverified
account survives `reapUnverifiedAccounts`. Otherwise the evidence a hold protects is silently deleted after 7 days.
(Reworded 2026-10-01: a ban alone is access control, not a hold, per CireSnave.)"* §3.2's reaper bullet changes to
match.

## 7. Out of scope

- A hold's effect on the user's ability to log in. There's none: holds and access are separate on purpose.

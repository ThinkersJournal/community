# Account Legal Hold — Design

**Status:** Approved in sections by the PM, 2026-10-01 (design note + rulings below), and written here for audit, then plan.
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
  signup.* No hash table and no signup-side comparison. Built here, in §4a.

## 1. What changes for a user

| Account state | Can log in? | Deletion request scrubs it after 30 days? | Unverified reaper deletes it after 7 days? |
|---|---|---|---|
| Ordinary | yes | yes | yes (if unverified) |
| Suspended, or a lapsed suspension | per `isBarred` (unchanged) | **yes**, unless held | **yes**, unless held |
| Banned (not held) | no (unchanged) | **yes**, but the **email stays reserved** (§4a) | **yes** (see §4a's note) |
| **Any state + an active account legal hold** | per `isBarred` | **no**: the request is recorded and waits | **no** |

`signup.ts`'s upsert guard (it refuses to overwrite a **barred** unverified row) is access control and **stays unchanged**
(PM confirmed). Otherwise a stranger could take over a barred account by re-signing up (#50 Q3b).

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

Unlike `media_legal_holds`, which is permanent per key, this table keeps released rows as history, because a DMCA or
other hold on an account may legitimately end. A release is an UPDATE. A trigger refuses DELETE, and refuses any UPDATE
other than setting the three release columns on an unreleased row. That keeps the table append-only in spirit and gives
the same protection as `moderation_actions`.

## 3. Trigger points

- **T1: content decision with a legal hold.** `POST /admin/decision` with `legalHold: true` already holds the content's
  images. It now **also** holds the content author's account, with the same category and the decision's action id,
  **inside the decision's transaction**. `DecisionInput` gains `accountHold?: { category }`, and `applyDecision`
  (`applyDecisionInTx` once plan B lands) inserts the hold right after `recordModerationAction`, using
  `ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING`.
- **T2: CSAM intake (#114).** Every uploader in a case gets a `csam` account hold in the intake transaction, **whether or
  not R1 bars them** (a hold blocks deletion, not access). This adds a line to #114's intake step 7 (the #114 plan is
  updated in the same PR).
- **T3: manual.**
  - **Impose:** `POST /admin/accounts/:handle/holds` `{ category: "dmca" | "other", reason }`. `csam` is excluded here:
    CSAM holds come only from T1/T2, where there is evidence of the case.
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

## 4a. A banned account's email stays reserved (board item 93, option 2)

- In `anonymise-accounts.ts`, when the account being scrubbed has `disabled_at IS NOT NULL` (a ban or a termination),
  **keep `users.email` as it is**. Everything else is scrubbed exactly as today: password hash, display name, bio, the
  handle (released), and the other personal fields the function already clears. `anonymised_at` is set as usual.
- Re-signup with that email is then refused by what already exists: `users.email` is `citext UNIQUE`, and the signup
  upsert refuses to overwrite a barred row (`signup.ts`'s guard, unchanged). **Pin both with a test:** a deleted,
  banned account's email cannot be used to sign up again, and gets the same response a taken email gets today.
- **"While the ban stands":** if the ban is later lifted on an already-anonymised account (plan B's appeal grant, or
  any future unban), the email must be scrubbed **then**. Plan B's ban-lift path gains one statement: if `anonymised_at`
  is set, scrub `email` with the same sentinel `anonymise-accounts` uses. Until plan B lands there is no unban path in
  the app, so this is recorded here for the plan-B implementer and pinned in this PR by a test of a helper
  `scrubReservedEmailIfUnbanned(c, userId)`, which plan B calls.
- The unverified reaper hard-DELETEs rows, so a banned unverified account with no hold is deleted outright, email
  included. That reopens the evasion only for an account that **never verified its email**, which couldn't post. It's
  accepted and stated, and it's consistent with the PM's AC-3 ruling (a hold, not a ban, protects).

## 5. Migration and backfill

- Migration: the table, the trigger, and the two new `moderation_actions` action kinds (rebuild the CHECK from the
  **latest** list).
- **Backfill (in the same migration):** every account whose `disabled_reason = 'terminate'` gets a `csam` hold
  (`imposed_by = 'system'`, `reason = 'backfill: terminated before account holds existed'`). Without it, the switch would
  make previously-protected terminated accounts deletable.
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
| AH-6 | `signup.ts`'s barred-row guard is unchanged; its existing test still passes. |
| AH-7 | Deleting a banned account scrubs everything **except** the email; signing up again with that email is refused. Lifting the ban afterwards (`scrubReservedEmailIfUnbanned`) scrubs it. Shown to fail when the email-keeping branch is removed. |

**Spec edit (AC-3):** in `2026-09-06-m4-moderation-queue-design.md` §12, AC-3 becomes *"A **legally held** unverified
account survives `reapUnverifiedAccounts`. Otherwise the evidence a hold protects is silently deleted after 7 days.
(Reworded 2026-10-01: a ban alone is access control, not a hold, per CireSnave.)"* §3.2's reaper bullet changes to
match.

## 7. Out of scope

- A hold's effect on the user's ability to log in. There's none: holds and access are separate on purpose.

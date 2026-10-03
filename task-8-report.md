# Task 8 — Legal text (plus the controller's final-review fix wave)

## Task 8 (commit 624cd79)

- `docs/legal/community-guidelines.md`: filled `[[APPEAL_CHANNEL]]` with the
  real channel (the notice's appeal link, or the post's editor for a hidden
  post, within 30 days); `Appeals: #113 plan B.` → `Appeals exist (#113 plan
  B).`. "A different reviewer, where practical" kept unchanged (spec #8).
- `docs/legal/privacy-policy.md`: added a bullet describing a barred user's
  deletion request as the code works — link only valid while barred, only
  records the request, 30-day anonymisation unless under legal hold, banned
  accounts keep an email fingerprint while banned — and a second bullet on
  appeal/token retention. No `[[Attorney: …]]` markers, per the controller's
  ruling that PR #141 already removed every attorney marker from these docs.
- `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` §6: added
  `**Status (2026-10-02):** BUILT — #113 plan B (…)`.
- `docs/superpowers/plans/2026-10-01-m4-2c-appeals.md`: corrected Task 6's
  mutation-(c) rationale (at the time, only one of its two bad occurrences).

Verified against the code: `apps/api/src/moderation/appeals.ts` (fileAppeal,
resolveAppeal), `routes/appeals.ts`, `routes/admin-appeals.ts`,
`routes/delete-request.ts`, `moderation/action-tokens.ts`,
`moderation/notice-links.ts`, `auth/anonymise-accounts.ts`, and
`migrations/0024_appeals.sql`.

Grep done-check: `APPEAL_CHANNEL` in `docs/legal apps` → 0 hits; control
`[[LEGAL_ENTITY]]` → 8 hits (unchanged, as expected). `pnpm typecheck`: exit 0.

## Final-review fix wave (this commit)

**1. Mutation-(c) rationale, all occurrences.** Grepped the whole plan for
`aborted` and `inner ROLLBACK` before fixing:
- `aborted`: 2 hits (lines ~1601, ~1946) → 0 after.
- `inner ROLLBACK` (literal): 1 hit (~1946; the already-fixed ~2377 instance
  used `inner \`ROLLBACK\`` with a backtick, so it didn't match) → 2 after (my
  corrected wording at ~1601 and ~1946 both use the phrase correctly).

Both corrected to: an inner `ROLLBACK` inside `applyDecisionInTx` does not
abort the caller's transaction or make its later queries throw — it ENDS the
transaction, so `resolveAppeal`'s later writes would autocommit outside it.
The `content_gone` test (~:1946's scenario) can still pass under the mutation;
what actually pins it is the caller-tx-id test,
`apps/api/test/appeal-resolve.test.ts:471`, which compares
`pg_current_xact_id()` before the call to `pg_current_xact_id_if_assigned()`
after.

**2. Minor 1 — privacy-policy.md Appeals bullet.** Added an exception: an
account that never verified its email is hard-deleted (not anonymised) after
7 days by `reap-unverified.ts`, and its appeals/tokens cascade with it
(`0024_appeals.sql`'s `ON DELETE CASCADE` on `appellant_id`/`user_id`).

**3. Minor 2 — community-guidelines.md.** "on the post itself" →
"in the post's editor" (matches `new-post.astro`'s banner link, not the post
body); added "(except a termination, which can't be appealed)" — true per
`APPEALABLE_ACTIONS` excluding `user_terminate` (#114, open legal question).

**4. Minor 3 — plan Task 8 Step 2.** Rewrote to drop the `[[Attorney: …]]`
marker instruction and explain why (PR #141 / CireSnave's "no attorney"
ruling), replacing it with the plain wording actually shipped.

**5. Minor 4 — `.replace("_", " ")` → `.replaceAll("_", " ")`** in
`apps/web/src/pages/appeal.astro:167` and
`apps/web/src/pages/admin/appeals.astro:125` (both actions are single-word
today, e.g. `content_remove`, so this was latent, not yet observably wrong).

**6. Minor 5 — admin/appeals.astro.** Wrapped the `appealId` path segment in
`encodeURIComponent(String(appealId ?? ""))` before building the resolve URL.

**7. Minor 6 — notify-account.ts.** `deleteRequestTextLine` now starts with a
single `\n` (was `\n\n`) and ends right after the URL with no trailing `.`;
`DELETE_REQUEST_SENTENCE_AFTER` now follows on its own `\n`-separated line,
matching the appeal line's shape. Existing tests use `.toContain`, so none
needed updating (confirmed by re-running `notify-account.test.ts`, 100%
green).

**8. Minor 7 — appeal.astro, signed-in path.** Added a `windowClosed` check
(`target.windowClosesAt` vs. `Date.now()`), computed on every render. When
true, the form is not rendered; instead: "The 30-day window to appeal this
decision has closed." `windowClosesAt` is now shown via
`toLocaleDateString(undefined, { year: "numeric", month: "long", day:
"numeric" })` instead of the raw ISO string. (The token path's own window
check is structural — its token's TTL equals the window — so this mainly
bites the per-post signed-in path, where `describeAppealTarget` doesn't check
the window itself.)

**9. Minor 8 — appeals.ts `resolveAppeal`.** The grant `switch` now narrows
`ap.action` to `AppealableAction` and ends with `default: { const unreachable:
never = action; throw … }`, so adding a new appealable action without a grant
branch fails to compile.

## Verification

- `pnpm typecheck`: **exit 0** (clean; only pre-existing `apps/web`
  deprecation hints in `test/xml.test.ts`, unrelated).
- `apps/web/test/appeal-pages.test.ts` (TEST_DATABASE_URL = appeals DB):
  **26/26 passed**.
- `apps/api/test/notify-account.test.ts`, `appeal-resolve.test.ts`,
  `appeals-route.test.ts`, `moderation-notify.test.ts` (same DB): **69/69
  passed**, combined.
- The earlier migration-order error seen against the default local test DB
  (`0023_appeals` vs `0023_reserved_email_hmac`) does not occur against
  `thinkersjournal_test_appeals`; not investigated further since it is a
  different, already-correctly-ordered database.

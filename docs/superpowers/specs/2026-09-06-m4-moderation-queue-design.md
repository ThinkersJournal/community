# M4 Module 2 — Moderation Queue, Enforcement Ladder & Appeals — Design

**Status:** Design for founder/PM review, then implementation plan → subagent build.
**Author:** Community controller agent, 2026-09-06. Second M4 code module; consumes
the report/auto-hide signals shipped in module 1 (PR #30/#31) and **adjudicates** them.

**Grounding:** every file:line below came from a codebase surface-map pass, not memory.
Module 1 deliberately "records + auto-hides + enforces; it does not adjudicate"
(`docs/superpowers/plans/2026-09-02-m4-report-block.md:134`). This module adjudicates.

---

## 0. Decisions already fixed — do not re-litigate

Founder, 2026-09-06:

1. **Unreviewed hidden content does NOT expire.** It stays hidden until a human reviews it;
   auto-restore would risk re-publishing genuinely bad content. The queue flags aging items.
2. **The author is told immediately on auto-hide** — "hidden pending review" + the appeal path.
3. **Content decision and account action are SEPARATE steps.** A review decides content only;
   warn→suspend→ban is a separate deliberate action. Severe violations (CSAM, credible
   threats) skip the ladder.
4. **Build for ONE operator, but record WHO acted** from day one, so adding moderators later
   is not a migration.
5. **Severity order:** `sexual` → `violence` → `hate` → `harassment` → `ip_infringement` →
   `spam` → `other`.
6. **DSA unauthenticated notices are accepted, with the reporter's email validated.**
7. **Appeals are an IN-APP FORM**, not email — easier to onboard moderators and keeps
   moderation site-integrated. This fills `[[APPEAL_CHANNEL]]`.
8. **Community Guidelines appeals wording stays as-is** — "a different reviewer, *where
   practical*". The hedge is deliberate: more moderators are hoped for, but a different
   reviewer is not promised.

Earlier fixed decisions this must honour: **#14** auto-hide at 3 distinct reporters/24h +
warn→suspend→ban + appeals; **#19** moderation notices are in the *instant email* tier;
**#16** GDPR + DSA from day one; admin surface **behind Cloudflare Access** (stated in three
independent places — settled, not a choice).

---

## 1. Scope and decomposition

Module 2 is too large for one spec. It splits into three slices, built in order:

- **2a — Shared admin foundation.** Cloudflare Access gate + admin identity + the append-only
  `moderation_actions` audit log. **The CSAM operator surface sits on this same foundation**
  (see `2026-09-06-csam-reporting-pipeline-design.md` when written) — build once.
- **2b — Review queue.** Ranked queue over reports; decisions: **restore / keep hidden /
  remove**; the author-facing "hidden pending review" state.
- **2c — Enforcement ladder + appeals.** warn → suspend → ban on a unified account-status
  primitive; the in-app appeals form.

**Out of scope:** pre-publish moderation scoring and spam heuristics (later modules); the DMCA
takedown/counter-notice flow (separate); the CSAM pipeline (separate design).

---

## 2. The four published-promise gaps this module closes

Found by surface-map. Each is a **live promise in a published document with no code behind it**:

1. **Restore does not exist.** `docs/legal/community-guidelines.md:54` promises a reviewer
   "confirms or **restores**" auto-hidden content. In code `hidden_at` is only ever SET — the
   sole write is `SET hidden_at = now()` (`apps/api/src/moderation/auto-hide.ts:39`). There is
   no un-hide path anywhere.
2. **No system→user notification path.** `notifications.actor_id` is `NOT NULL REFERENCES
   users(id)`, a `CHECK (recipient_id <> actor_id)` forbids self-addressing
   (`0005_notifications.sql:12,22`), and `notify()` suppresses blocked pairs
   (`notifications/create.ts:92-94`). Worse, `notification_prefs.master_enabled` lets a user
   disable **all** email, so a suspension notice would be user-suppressible — yet decision #19
   commits moderation to the instant-email tier.
3. **Suspension cannot block re-login.** `UserSecurityDO.bumpEpoch()` invalidates *existing*
   sessions (checked at `auth/pipeline.ts:138,242`), but `users` has no status column
   (`0001_users_and_profiles.sql:4-10`), so a suspended user simply logs back in.
4. **DSA notice-and-action requires no account**; as-built `POST /reports` requires a verified
   session (`routes/reports.ts:26`).

---

## 3. Data model — migration `0013_moderation_queue.sql`

Conventions mirror `0012_moderation.sql`: `uuidv7()` PKs, `-- Up Migration` / `-- Down
Migration` markers, and the house idiom of **nullable-timestamp watermarks** rather than enum
status columns (`emailed_at`, `read_at`, `hidden_at`, `deleted_at`).

### 3.1 `moderation_actions` — the append-only audit log

The compliance record. Satisfies the DSA statement-of-reasons obligation and is the evidence
base for appeals. **Append-only enforced at the database**, not by convention:

```sql
CREATE TABLE moderation_actions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_admin    text NOT NULL,          -- Access identity (email) of who acted; 'system' for automated
  action         text NOT NULL CHECK (action IN (
                   'content_restore','content_keep_hidden','content_remove',
                   'user_warn','user_suspend','user_ban','user_terminate',
                   'appeal_granted','appeal_denied')),
  -- ⚠️ BARE uuids, DELIBERATELY NO FOREIGN KEYS — see the note below.
  post_id        uuid,
  comment_id     uuid,
  subject_user_id uuid,
  -- Denormalized identity, captured at action time. The log must stay readable
  -- after its subject is deleted, and a bare uuid is not readable.
  subject_label  text,                   -- e.g. the handle at the time of action
  violation_category text CHECK (violation_category IN
                   ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  action_expires_at timestamptz,         -- a suspension's intended end, recorded ON the action
  reason         text NOT NULL,          -- the statement of reasons (DSA); shown to the user
  internal_note  text,                   -- never shown to the user
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_post_idx    ON moderation_actions (post_id, created_at)    WHERE post_id IS NOT NULL;
CREATE INDEX moderation_actions_comment_idx ON moderation_actions (comment_id, created_at) WHERE comment_id IS NOT NULL;
CREATE INDEX moderation_actions_subject_idx ON moderation_actions (subject_user_id, created_at);
CREATE INDEX moderation_actions_category_idx ON moderation_actions (violation_category, created_at);

-- APPEND-ONLY, enforced in the DB: the app role has DML, so discipline alone is not a guard.
CREATE FUNCTION moderation_actions_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'moderation_actions is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER moderation_actions_no_update BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_immutable();
```

### ⚠️ Why this table has NO foreign keys — a defect found in review

An earlier draft declared `post_id`/`comment_id`/`subject_user_id` as FKs with
`ON DELETE SET NULL`. **That design was broken.** `ON DELETE SET NULL` performs an **UPDATE**
on `moderation_actions`, which the immutability trigger above refuses — so deleting any post or
user would have **failed outright**, making content and accounts undeletable and breaking GDPR
erasure. The trigger and the FKs were mutually exclusive and the draft shipped both.

The tempting fix is to carve an exception into the trigger for FK-nulling updates. **Rejected:
an exception in a guard is a permanent hole shaped like the first thing that needed one.**
Instead the FKs are removed entirely. An **append-only log must outlive its subjects** — that is
the entire point of an audit record — so referential actions on it are not merely inconvenient,
they are semantically wrong. Removing them **deletes the mutation path** rather than weakening
the guard, and the trigger stays absolute.

The cost is no referential integrity on the log, which is accepted: a dangling `post_id` after a
post is deleted is *correct* for an audit record, and `subject_label` preserves human readability
that a bare uuid loses. `actor_admin` is text for the same reason — moderators are Access
principals and need not be platform users.

⚠️ **Flagged, not asserted:** retaining a deleted user's uuid in the log is a
retention-vs-erasure question (DSA statement-of-reasons retention pulls one way, GDPR erasure the
other). It is a legal judgement, not an engineering one, and belongs in the attorney pass.

`violation_category` exists because DSA Art. 15/24 transparency reporting needs **categorical
counts**, and a free-text `reason` alone would force text-mining to produce them.
`action_expires_at` records a suspension's intended duration **on the action**, so the log stays
truthful after `users.suspended_until` has moved on — an audit log must record what was *done*,
never depend on current state to explain itself.

### 3.2 Account status on `users`

⚠️ **This gap is filed separately as issue #35** — a defect described only inside a design doc
for future work is discoverable solely by someone reading that doc for an unrelated reason. It is
*latent*, not exploitable today (no suspend feature exists to bypass), but it becomes live the
instant anything assumes suspension works — **including the CSAM termination hook, which shares
this primitive.**

One primitive serving **both** the ladder and the CSAM pipeline's termination hook:

```sql
ALTER TABLE users ADD COLUMN suspended_until  timestamptz;  -- temporary; login refused while now() < this
ALTER TABLE users ADD COLUMN disabled_at      timestamptz;  -- permanent (ban or CSAM termination)
ALTER TABLE users ADD COLUMN disabled_reason  text;
```

Soft-disable, never a row delete — the row and its content are evidence. Two consequences:

- **Login and the mutating pipeline refuse** a user with `disabled_at IS NOT NULL` or
  `suspended_until > now()`, and the action **bumps the security epoch** to kill live sessions.
  Existing-session kill + login refusal together are what actually make a ban stick.
- ⚠️ **The unverified-account reaper must skip these.** `auth/reap-unverified.ts:46-55` hard
  `DELETE`s unverified accounts older than 7 days; a banned or CSAM-terminated account could be
  unverified. It gains `AND disabled_at IS NULL AND suspended_until IS NULL`.

**Warnings need no column** — a warning is a `moderation_actions` row, and "history" for the
proportionality ladder is a count of prior actions against that user.

### 3.3 `dsa_notices` — unauthenticated notice-and-action intake

Separate table, deliberately: `reports.reporter_id` is `NOT NULL REFERENCES users(id)` and the
auto-hide distinct-reporter count depends on it (`auto-hide.ts:31-37`), so anonymous notices
cannot live there without breaking that counting.

```sql
CREATE TABLE dsa_notices (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  reporter_email    citext NOT NULL,
  email_verified_at timestamptz,          -- NULL = unverified; the notice is INERT until set
  verify_token_hash text NOT NULL,        -- SHA-256 of the emailed token; never store the token
  post_id           uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id        uuid REFERENCES comments(id) ON DELETE CASCADE,
  reason            text NOT NULL CHECK (reason IN
                      ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  statement         text NOT NULL,        -- the notice body / explanation (DSA requires reasons)
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  CONSTRAINT dsa_notices_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL))
);
CREATE INDEX dsa_notices_open_idx ON dsa_notices (created_at)
  WHERE email_verified_at IS NOT NULL AND resolved_at IS NULL;
```

### 3.4 `appeals`

```sql
CREATE TABLE appeals (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  appellant_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id     uuid NOT NULL REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  CONSTRAINT appeals_one_per_action UNIQUE (appellant_id, action_id)
);
CREATE INDEX appeals_open_idx ON appeals (created_at) WHERE resolved_at IS NULL;
```

`ON DELETE RESTRICT` on `action_id`: you cannot delete the action an appeal is about.

---

## 4. 2b — The review queue

### 4.1 The queue is a QUERY, not a table

The unit of review is the **target** (a post or comment), not the report: three reports on one
post are **one** queue item with three reports attached, and one decision. The queue is derived,
with `moderation_actions` as the single source of truth for "handled":

> A target is **OPEN** if it has ≥1 report (or verified DSA notice) and **no** `content_*`
> action recorded in `moderation_actions` after the newest report on that target.

This is deliberately derived rather than a denormalized `status` column: it cannot drift out of
sync with the audit log, and a *new* report arriving after a decision correctly reopens the item.

⚠️ **DO NOT DENORMALIZE THIS INTO A `status` COLUMN.** The rationale is recorded here so that a
future performance argument has to argue against a stated reason rather than a silence. A status
column is a *second* copy of a fact the audit log already holds, and the failure mode is silent:
the column and the log disagree, the queue shows the column, and the log — the thing that has to
be true for appeals and for DSA statements of reasons — is the copy nobody is looking at. If
volume ever makes the derivation genuinely too slow, the answer is an index or a materialized
view derived *from* the log, never a hand-maintained duplicate of it.

### 4.2 Ranking

`reports` has no index supporting a global queue ordering (only partial
`(post_id, created_at)` / `(comment_id, created_at)`), so `0013` adds `reports (created_at)`.

Order by: **severity DESC** (decision #5's order, as a `CASE` rank over `reason`), then
**report count DESC**, then **oldest first**. Counts and severity are computed at query time
rather than denormalized — at launch volume the join is cheap, and denormalization would be a
drift hazard for no gain. If volume ever demands it, denormalize then.

⚠️ **No `reporter_trust` and no AI score in v1.** The research doc's "score × report-count ×
reporter-trust" presumes a pre-publish scorer that does not exist yet (a later module) and a
trust metric that has never been defined. Ranking stays explainable.

**Aging** is surfaced, not acted on: each item shows the age of its oldest unactioned report, so
an item cannot quietly rot (decision #1 means nothing auto-restores).

### 4.3 Decisions

Exactly three content outcomes, each writing one `moderation_actions` row with a `reason`:

| Decision | Effect |
|---|---|
| **Restore** | `hidden_at = NULL` — **the first un-hide path in the codebase**. Author notified. |
| **Keep hidden** | `hidden_at` stays set; author notified with the statement of reasons. |
| **Remove** | `hidden_at` set permanently **plus** a `content_remove` action in the log. No new column — see below. |

Account actions are **not** available from this screen (decision #3).

### ⚠️ Why "Remove" is not a `deleted_at` tombstone — corrected in review

An earlier draft said removal was a tombstone "mirroring the `comments.deleted_at` tombstone."
**Measured, and that was wrong on the facts:** `comments` has `deleted_at`
(`0004_engagement.sql:22`) but **`posts` does not** — the only `ALTER TABLE posts` in the whole
migration set is `0012`'s `hidden_at` — and author post-deletion is a **real hard
`DELETE FROM posts`** (`routes/posts.ts:456`), documented there as explicitly *not* a tombstone.
There was no posts tombstone to mirror.

The obvious repair — add `posts.deleted_at` — is **rejected**, and the reason generalizes:

> ⚠️ **A fix that adds a SECOND instance of the thing a guard protects ONE instance of widens the
> hole while looking like a repair.**

The `hidden-at-read-guard` structural test enforces exactly one visibility predicate:
`hidden_at IS NULL`. Introducing `deleted_at` on `posts` would create a second predicate that
**every public read must independently remember**, unguarded — silently widening the very leak
surface the guard exists to close.

So removal reuses the predicate that is already guarded: `hidden_at` set permanently, with the
`content_remove` action in the log carrying the distinction between "hidden pending review" and
"removed, final." The state machine lives in the audit log, not in a second column. Evidence is
preserved for appeals and DSA; a true purge remains a separate, deliberate operation, and CSAM
keeps its own preservation path.

⚠️ **Automation never decides.** The Guidelines state moderation "is human-reviewed; automated
signals only *prioritize* review, they do not decide it." Auto-hide is provisional and
reversible; only a human writes a `content_*` action.

### 4.4 Author-facing hidden state (decision #2)

Today an auto-hidden post 404s publicly and the author sees no difference beyond "my post
disappeared." Two changes:

- `handleGetPost` (`routes/posts.ts:512-517`, the author's own read) selects `hidden_at` and the
  editor shows a **"Hidden pending review"** banner with the appeal link.
- On auto-hide, the author is emailed (§7).

⚠️ This read is **already allowlisted** in the structural guard
(`test/hidden-at-read-guard.node.test.ts:70-78`) as the author's own post, so surfacing
hidden state there is compatible with the guard. **Any new admin/queue route that reads
`posts`/`comments` will trip that guard and needs its own allowlist entry with a written
justification** — that is the guard working as designed, not an obstacle to route around.

---

## 5. 2c — The enforcement ladder

`warn → temporary suspension → permanent ban`, proportionate to severity and history, with
**severe violations skipping the ladder** (Guidelines). Each rung is a separate deliberate
action (decision #3) writing a `moderation_actions` row:

- **Warn** — a row + an email. No account state changes.
- **Suspend** — sets `suspended_until`, bumps the security epoch (kills live sessions), emails
  the user the reason and the end date. *Proposed durations: 24h / 7d / 30d, reviewer-selectable,
  defaulting to 7d.*
- **Ban** — sets `disabled_at` + `disabled_reason`, bumps the epoch, emails the user.
- **Terminate** — the CSAM path: ban semantics plus evidence preservation, owned by the CSAM
  pipeline design, reusing this same primitive.

**History** for proportionality = prior `moderation_actions` rows against that user.
*Proposed: actions older than 12 months no longer escalate the ladder* (they remain in the log
permanently — expiry affects escalation, never the record).

---

## 6. Appeals — an in-app form (decision #7)

- The appellant opens an appeal against a specific `moderation_actions` row, from the
  notification email's link or their own content page. One appeal per action.
- Appeals land in the same admin surface as a separate list. Resolution writes
  `appeal_granted` / `appeal_denied` to the audit log; granting an appeal performs the inverse
  content or account action.
- **The Guidelines wording is unchanged** (decision #8). The system records *who* resolved each
  appeal (decision #4), so once more moderators exist, "a different reviewer where practical"
  becomes checkable — and until then it is honestly hedged, not falsely promised.
- *Proposed appeal window: 30 days from the action.*

---

## 7. Telling users — a safety channel that bypasses preferences

Gap #2 means moderation notices **cannot** ride the `notifications` table: it demands a human
actor, forbids self-addressing, is suppressed by blocks, and is silenceable via prefs.

**Therefore moderation notices do not use the notification system at all.** They send as
**direct transactional email on the `"outbound"` Postmark stream**, exactly like the
verification email (`auth/email-verify.ts:218-231`) — the codebase's one existing
prefs-bypassing, non-unsubscribable path. This satisfies decision #19's instant-email tier
without inventing a new transport or weakening the engagement-email preferences.

Users cannot opt out of being told they were actioned. That is correct: it is a safety and
due-process notice, not marketing. In-app, the author additionally sees the banner from §4.4.

---

## 8. DSA notice-and-action intake (decision #6)

A public, unauthenticated `POST /dsa-notice` accepting a notice with the reporter's email.

**Flow:** submit (Turnstile + rate limited) → row written with `email_verified_at IS NULL` and a
hashed token → confirmation email → the reporter clicks → `email_verified_at` set → **only then**
does the notice enter the review queue. An unconfirmed notice is inert and reaped.

### ⚠️ ACCEPTANCE CONDITION AC-1 — binding, not descriptive

> **A DSA notice NEVER counts toward the auto-hide threshold.** Auto-hide requires 3 *distinct
> verified members*. An email-validated anonymous notice is a far weaker signal, and counting one
> would let **three throwaway addresses hide any post on the site**. DSA notices are queue input
> for human review only; they never hide anything automatically.
>
> **The implementing PR does not merge without a test that fails when this is violated** — a test
> that seeds three verified DSA notices against one post and asserts `hidden_at IS NULL`, shown to
> **fail** against an implementation that counts them.

This is stated as an **acceptance condition on the implementation PR**, not as a line in the test
plan below, and the distinction is deliberate. **A test plan is a proposal: it has no artifact and
no clock.** This portfolio has already watched a normative clause cite conformance vectors that
had been "optional hardening" weeks earlier and were never written — the citation survived, the
tests never existed, and nothing failed to reveal it. Written here as a merge condition, **the
document is what refuses**, rather than a reviewer having to remember.

**Anti-abuse:** Turnstile on the form, a new `DSA_LIMITER` rate-limit binding, and the
email-confirmation step itself (which costs an attacker a working inbox per notice).

The validated email also lets us send the **statement of reasons** the DSA expects the reporter
to receive once the notice is decided.

---

## 9. 2a — Admin surface and Cloudflare Access

**Settled:** the admin surface is behind Cloudflare Access (stated in three independent places).
Admin identity comes from the Access JWT (`Cf-Access-Jwt-Assertion`), verified against the team's
public keys — **independent of member sessions**. The `roles` field on `SessionData` is *not*
used: it exists but is always `[]` and is never read for authorization anywhere, and member
sessions are the wrong trust domain for moderator authority.

The Access principal's email is what lands in `moderation_actions.actor_admin` (decision #4).

✅ **RULED (portfolio PM, 2026-09-08): API-FIRST, with a thin server-rendered admin on top.
No SPA.** This closes the design's last open item. It was the PM's call to make rather than the
founder's — it carries no product or legal consequence, and holding it for him would have
converted a technical decision into a founder one.

The same ruling settles the **CSAM operator surface**, which sits on this identical foundation —
which is precisely why 2a is built once, first, and shared.

---

## 10. Testing

Mirrors the repo's existing patterns (`*.db.test.ts` in the Node project for schema,
`cloudflare:test` for routes):

- **Schema** — every new table/column/constraint, and the append-only trigger proven to
  **reject** an UPDATE and a DELETE (a guard that has never been shown to fire is not a guard).
- **Reaper regression** — a disabled/suspended unverified account **survives**
  `reapUnverifiedAccounts`. This is the highest-value test here: without it, a banned user is
  silently deleted seven days later.
- **Restore** — an auto-hidden post, once restored, reappears in public reads; asserted through
  the real public endpoints, not by reading the column.
- **Queue derivation** — a target with a decision is closed; a *new* report after that decision
  **reopens** it; ranking honours the severity order.
- **Ban/suspend enforcement** — a suspended user is refused at login *and* on mutations, and
  their live sessions die (epoch bump).
- **DSA** — an unconfirmed notice is inert and never queued; a confirmed one queues; and
  **three DSA notices do NOT auto-hide a post**. ⚠️ That last one is **AC-1 (§8/§12), a merge
  condition, not a test-plan aspiration** — it must be shown to FAIL against an implementation
  that counts them, or it proves nothing.
- **Access gate** — admin endpoints reject a request with no/invalid Access JWT, and a valid
  *member session* grants no admin authority.
- **Structural guard** — new admin routes reading `posts`/`comments` carry justified allowlist
  entries.

---

## 11. Open items

1. ~~Admin surface home~~ — **CLOSED** (§9): API-first + thin server-rendered admin, no SPA.
   Ruled by the portfolio PM 2026-09-08.
2. **Proposed defaults awaiting the founder's review**, all flagged inline above: suspension
   durations (24h/7d/30d, default 7d); ladder history stops escalating after 12 months (the log
   retains everything permanently); appeal window (30 days).
3. **`[[APPEAL_CHANNEL]]`** in `docs/legal/community-guidelines.md` should be updated to name the
   in-app appeals form once built.
4. **Slice sequencing** — 2a first (shared with the CSAM operator surface), then 2b, then 2c.
5. **Legal, not engineering:** retaining a deleted user's uuid in the append-only log — DSA
   statement-of-reasons retention versus GDPR erasure (§3.1). Flagged for the attorney pass.

## 12. Binding acceptance conditions

Collected so the implementation PR is checked against a list rather than a reader's memory.

| # | Condition | Why it is binding rather than a test-plan line |
|---|---|---|
| **AC-1** | A DSA notice never counts toward auto-hide (§8) | Three throwaway addresses could otherwise hide any post |
| **AC-2** | The append-only trigger is proven to **reject** an UPDATE *and* a DELETE | A guard never shown to fire is a claim, not a guard |
| **AC-3** | A disabled/suspended unverified account **survives** `reapUnverifiedAccounts` | Otherwise a banned user, and the evidence, is silently deleted after 7 days (issue #35) |
| **AC-4** | A suspended user is refused at **login** as well as on mutations | Killing live sessions alone does not stop re-entry (issue #35) |
| **AC-5** | No second visibility predicate is introduced on `posts`/`comments` | The structural guard enforces `hidden_at` only; a second column widens the leak surface unguarded (§4.3) |

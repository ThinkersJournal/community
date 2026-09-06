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
  post_id        uuid REFERENCES posts(id)    ON DELETE SET NULL,
  comment_id     uuid REFERENCES comments(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES users(id)   ON DELETE SET NULL,
  reason         text NOT NULL,          -- the statement of reasons (DSA); shown to the user
  internal_note  text,                   -- never shown to the user
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_post_idx    ON moderation_actions (post_id, created_at)    WHERE post_id IS NOT NULL;
CREATE INDEX moderation_actions_comment_idx ON moderation_actions (comment_id, created_at) WHERE comment_id IS NOT NULL;
CREATE INDEX moderation_actions_subject_idx ON moderation_actions (subject_user_id, created_at);

-- APPEND-ONLY, enforced in the DB: the app role has DML, so discipline alone is not a guard.
CREATE FUNCTION moderation_actions_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'moderation_actions is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER moderation_actions_no_update BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_immutable();
```

⚠️ FKs are `ON DELETE SET NULL`, **not CASCADE** — deleting a post must never erase the record
that it was moderated. `actor_admin` is text (the Access identity), not a FK, because
moderators are Access principals and need not be platform users.

### 3.2 Account status on `users`

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
| **Remove** | Tombstone, not a hard delete (mirrors the `comments.deleted_at` tombstone at `0004_engagement.sql:22`), preserving the audit trail. |

Account actions are **not** available from this screen (decision #3).

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

⚠️ **A DSA notice NEVER counts toward the auto-hide threshold.** Auto-hide requires 3 *distinct
verified members*; an email-validated anonymous notice is a far weaker signal, and counting them
would let three throwaway addresses hide any post on the site. DSA notices are **queue input for
human review only** — they never hide anything automatically. This is the single most important
safety property of this section.

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

⚠️ **OPEN ITEM — the one thing this design does not settle:** whether the surface is served by
the **web** Worker (Astro SSR, where Access naturally fronts a hostname) or as **API-only**
endpoints. Recommendation: **web**. This is with the PM, is shared with the CSAM operator
surface, and affects only where pages are rendered — no data-model consequence.

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
  **three DSA notices do NOT auto-hide a post** (the §8 safety property, tested explicitly).
- **Access gate** — admin endpoints reject a request with no/invalid Access JWT, and a valid
  *member session* grants no admin authority.
- **Structural guard** — new admin routes reading `posts`/`comments` carry justified allowlist
  entries.

---

## 11. Open items

1. **Admin surface home: web vs API-only** (§9) — with the PM; recommendation web.
2. **Proposed defaults awaiting the founder's review**, all flagged inline above: suspension
   durations (24h/7d/30d, default 7d); ladder history expiry (12 months); appeal window
   (30 days); "remove" = tombstone rather than hard delete.
3. **`[[APPEAL_CHANNEL]]`** in `docs/legal/community-guidelines.md` should be updated to name the
   in-app appeals form once built.
4. **Slice sequencing** — 2a first (shared with the CSAM operator surface), then 2b, then 2c.

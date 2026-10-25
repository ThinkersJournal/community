# Glossary

This glossary defines the domain terms used across Thinker's Journal Community: a two-Cloudflare-Worker publishing platform (`apps/api`, `apps/web`, `packages/shared`, `packages/markdown`). Each entry is one to three sentences and points at the document that defines or uses the term; the document is the authority, so link to it rather than restating it here. To keep this file current, add a term when a spec, plan or runbook introduces one, keep the list alphabetical, and define each term once. Terms for which the docs are unclear are left out rather than guessed at. The scanning provider is only ever called "hash-matching service A" (env prefix `HMS_A_*`) in this public repository.

**Account action token**: A single-use, hashed, per-purpose token (`appeal` or `delete_request`) placed in a moderation notice email so that even a barred user with no session can act. Opening the link does not consume it; only a confirming POST does, because mail scanners prefetch links. (see docs/superpowers/plans/2026-10-01-m4-2c-appeals.md)

**Account legal hold**: A row in `account_legal_holds` (category `csam`, `dmca` or `other`) that blocks the account's deletion, whether user-requested anonymisation or the unverified-account reaper. It is separate from suspension or ban, which are pure access control, and a `csam` hold is never released by the app. (see docs/superpowers/specs/2026-10-01-account-legal-hold-design.md)

**Anonymised account**: An account whose personal data was scrubbed after a deletion request: `anonymised_at` is set and the email is replaced by a `deleted-<id>@invalid...` sentinel address. Its content is shown as tombstones and no notices are sent to it. (see docs/superpowers/specs/2026-10-14-moderation-author-notices-design.md)

**Appeal**: A request, made through an in-app form (not email), to contest a moderation action. Granting an appeal writes `appeal_granted` to the audit log and applies the inverse action in the same transaction; denying writes `appeal_denied`. (see docs/superpowers/plans/2026-10-01-m4-2c-appeals.md)

**Appeal window**: The 30 days from the day the decision notice is delivered during which a decision can be appealed (`APPEAL_WINDOW_DAYS = 30`, started at delivery by #214; a decision with no notice row counts from the decision). (see docs/superpowers/plans/2026-10-01-m4-2c-appeals.md)

**Auto-hide**: The automatic hiding of a post or comment when it draws reports from at least 3 distinct reporters within 24 hours; it sets `hidden_at` and is global, not per viewer. Hidden content does not expire and stays hidden until a human reviews it. (see docs/superpowers/specs/2026-09-02-m4-report-block-design.md)

**Barred**: The state of an account that is disabled or currently suspended, evaluated by `isBarred`; a barred user gets `403 ACCOUNT_BARRED` on sign-in. (see docs/superpowers/plans/2026-10-01-m4-2c-enforcement-ladder.md)

**Block**: A member's action that stops another member from following, commenting on, reacting to or notifying them, and removes the blocked member's posts from the blocker's feed. It is interaction control, not invisibility: public posts stay public, and block copy must say so. (see docs/superpowers/specs/2026-09-02-m4-report-block-design.md)

**Cloudflare Access**: The gate in front of the admin surface; the admin identity comes from the Access JWT (`Cf-Access-Jwt-Assertion`), and the same identity is recorded as `actor_admin` in the audit log. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**Decision**: A moderator's ruling on reported or auto-hidden content: `restore`, `keep_hidden` or `remove`. A decision concerns the content only; a warning, suspension or ban is a separate step. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**Delete request**: A barred user's request, made through a `delete_request` token, to have their account deleted. It only stamps `deletion_requested_at`; the deletion itself is gated only by an active account legal hold. (see docs/superpowers/plans/2026-10-01-m4-2c-appeals.md)

**Discover**: The community front page (`/`): an anonymous, edge-cached, newest-first list of published posts site-wide, keyset-paginated by `id DESC` and served by `GET /public/discover`. It is distinct from the personalised `/feed`. (see docs/superpowers/specs/2026-08-05-m2-4b-discover-feed-design.md)

**DSA notice**: A report that a post or comment is illegal, which anyone can file without an account and confirms from their email. It is stored in `dsa_notices`, never counts toward auto-hide, and is resolved by the same decision that rules on the target. (see docs/superpowers/plans/2026-10-01-m4-dsa-notice-intake.md)

**Enforcement ladder**: The account-level sequence warn, suspend, ban, applied by `applyAccountAction` as a separate deliberate step after a content decision. Suspension durations are 24h, 7d and 30d with 7d the default, actions older than 12 months stop escalating, and severe violations skip the ladder. (see docs/superpowers/plans/2026-10-01-m4-2c-enforcement-ladder.md)

**Feed**: The personalised, per-viewer, never-cached home feed at `/feed`, built from the posts of the accounts a member follows. (see docs/superpowers/specs/2026-08-08-m2-kv-followee-cache-design.md)

**Followee cache**: A KV namespace (`FOLLOWEES`) holding each viewer's followee-id list under `followees:<userId>`, read cache-aside behind `getFolloweeIds`, deleted on follow and unfollow, with a 300-second TTL backstop. Only the id list is cached, not feed posts. (see docs/superpowers/specs/2026-08-08-m2-kv-followee-cache-design.md)

**Handle**: A member's permanent `@username`, chosen on the signup form (3 to 30 characters of `a-z0-9_`) and immutable once the email is verified. Before verification a re-signup of the same unverified email may correct it. (see docs/superpowers/specs/2026-08-13-handle-at-signup-design.md)

**Hash-matching service A**: The neutral name (also HMS-A, env prefix `HMS_A_*`) for the external hash-matching provider used for CSAM detection; its credentials live only on `thinkersjournal-api` and are never logged. (see docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md)

**hidden_at**: The nullable timestamp column on `posts` and `comments` that marks content as hidden pending review; public read paths filter on `hidden_at IS NULL`. It follows the house idiom of nullable-timestamp watermarks rather than status enums. (see docs/superpowers/specs/2026-09-02-m4-report-block-design.md)

**Hyperdrive FRESH and CACHED**: The two Hyperdrive bindings to Postgres. `HYPERDRIVE_FRESH` (cache-disabled) must serve all auth, session and permission reads and any read right after a write, while `HYPERDRIVE_CACHED` is for cache-tolerant public reads. (see docs/superpowers/plans/2026-07-13-m0-foundations.md)

**Idempotency key**: An optional `Idempotency-Key` header (16 to 64 characters of `A-Za-z0-9_-`) on `POST /posts`, scoped to (author, key) and stored on the post row. A replay of the same request returns `200` with the original body; a different request under the same key gets `422 IDEMPOTENCY_KEY_REUSED`. (see docs/superpowers/specs/2026-10-13-post-idempotency-key-design.md)

**Legal hold (media)**: A row in `media_legal_holds`, keyed by the media object's R2 key, that excludes the object from garbage collection and prevents its deletion. Deleting a `csam` row for an evidence key is refused. (see docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md)

**Listing tag**: The reserved cache purge tag `listing`, set on edge-cached listing pages (Discover, the tag index) and purged when a post is published or edited. Other tags include `post:<id>`, `author:<id>` and `tag:<slug>`. (see docs/superpowers/specs/2026-08-05-m2-4b-discover-feed-design.md)

**Media GC**: The daily cron that reclaims media referenced by no post, found by scanning `posts.markdown_source` for image references, after a grace period and with dedup-safe deletion of R2 objects. It covers both post-deletion orphans and abandoned uploads. (see docs/superpowers/specs/2026-08-13-content-deletion-media-reclamation-design.md)

**Migration numbering**: SQL migrations in `apps/api/migrations` are sequentially numbered `NNNN_name.sql` with `-- Up Migration` and `-- Down Migration` markers and run by node-pg-migrate. A pending migration must be applied to production before the PR that needs it merges, and `GET /health/schema` shows what is applied. (see docs/superpowers/specs/2026-10-14-moderation-notice-outbox-design.md)

**Moderation action (audit log)**: A row in the append-only `moderation_actions` table recording who acted (`actor_admin`, or `system`), what (for example `content_remove`, `user_ban`, `appeal_denied`), the statement of reasons and an internal note. Append-only is enforced by a database trigger, and the table has no foreign keys so it outlives its subjects. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**Moderation queue**: The ranked admin list of reported or auto-hidden content awaiting a decision, ordered by the severity order and flagging aging items. Confirmed DSA notices appear in their own admin list, not in this queue. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**NCMEC report**: A report to the National Center for Missing and Exploited Children, queued in `ncmec_reports` when a known-hash match occurs. Preservation of the evidence never ends earlier than one year after submission. (see docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md)

**noticeSkip**: A field on the decision result, `"author_anonymised" | "comment_deleted" | null`, that tells the route to skip the author notice (and the appeal-link mint). The decision itself is still applied and recorded, and DSA reporters are still sent their outcome. (see docs/superpowers/specs/2026-10-14-moderation-author-notices-design.md)

**Notification**: A row in `notifications`, the source of record for in-app engagement events (comment, reply, reaction, new follower). It is written idempotently once per (actor, target, tone) and collapsed at read time. (see docs/superpowers/specs/2026-07-23-m2-3a-notification-core-design.md)

**Outbox (moderation notices)**: The `moderation_notice_outbox` table for durable delivery of due-process notices, written in the same transaction as the decision it announces and drained once immediately and then by the `*/2` cron. Rows end as `sent`, `skipped` or `dead`, and delivery is at-least-once. (see docs/superpowers/specs/2026-10-14-moderation-notice-outbox-design.md)

**Outbox dedupe key**: The unique `dedupe_key` on an outbox row (for example `decision:<actionId>:author`) that makes the insert idempotent with `ON CONFLICT DO NOTHING`. (see docs/superpowers/specs/2026-10-14-moderation-notice-outbox-design.md)

**Pending review**: The author-facing state of auto-hidden content: the author is told immediately that it is hidden pending review, and the auto-hide notice carries no appeal link because no decision exists yet. (see docs/superpowers/specs/2026-10-14-moderation-author-notices-design.md)

**PhotoDNA scan step**: The name used in this public repository for the scanning step in the upload-scan design; the underlying provider is never named here. (see docs/superpowers/specs/2026-10-07-upload-scan-design.md)

**Postmark Broadcast stream**: The dedicated Postmark stream on which notification digests are sent, one coalesced send per recipient, with `emailed_at` stamped only on a confirmed send. (see docs/superpowers/specs/2026-07-31-m2-3c-email-notifications-design.md)

**Postmark outbound stream**: The Postmark transactional stream (`"outbound"`, no unsubscribe link) used for moderation notices, appeal and account-action emails, and DSA confirmations. (see docs/superpowers/plans/2026-10-01-m4-2c-enforcement-ladder.md)

**Quarantine**: The block on sharing content that matched a hash, applied at once on a match while the uploader's account stays active until a human reviews the case. A CLEAR lifts it and a CONFIRM terminates the uploader. (see docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md)

**Reaper (unverified-account)**: A daily cron that hard-deletes accounts with `email_verified_at IS NULL` older than 7 days, freeing the handle and the email so pre-verification handle claims cannot be squatted. It also removes unconfirmed DSA notices and is gated by account legal holds. (see docs/superpowers/specs/2026-08-13-handle-at-signup-design.md)

**Report**: A signed-in, verified member's flag on a post or comment, with one of the reasons `spam`, `harassment`, `hate`, `sexual`, `violence`, `ip_infringement` or `other`; one report per reporter per target. (see docs/superpowers/specs/2026-09-02-m4-report-block-design.md)

**Reporter**: The person who files a report or a DSA notice. A member reporter counts toward the auto-hide threshold as a distinct reporter; a DSA notice reporter need not have an account and is emailed the outcome. (see docs/superpowers/plans/2026-10-01-m4-dsa-notice-intake.md)

**Reporter outcome notice**: The email telling a DSA notice reporter how their notice was resolved (DSA Art. 16(5)), sent for any decision on the target regardless of what happened to the content. (see docs/superpowers/specs/2026-10-14-moderation-notice-outbox-design.md)

**Reserved email hash**: A SHA-256 of the normalised email stored in `users.reserved_email_sha256` for an anonymised banned account, so the address cannot be used for a new signup while the ban stands even though the real address is gone. (see docs/superpowers/specs/2026-10-01-account-legal-hold-design.md)

**Search**: A single anonymous `GET /public/search` endpoint doing pg_trgm fuzzy matching over posts and profiles, ranked by `word_similarity`, offset-paginated, with a Posts and People tabbed `/search` page. (see docs/superpowers/specs/2026-08-01-m2-4a-search-design.md)

**Severity order**: The ranking of violation categories in the review queue: `sexual`, `violence`, `hate`, `harassment`, `ip_infringement`, `spam`, `other`. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**Statement of reasons**: The DSA-required explanation of a moderation decision, stored as `reason` on the audit-log row and shown to the affected user. It is required and may not be empty; the `internal_note` is never shown. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**Tag**: A freeform, author-created topic label (maximum 5 per post), stored as a lowercase `citext` slug with the original text kept as the label. Browsing is at `/tag/<slug>` and the popularity-ordered `/tags` index. (see docs/superpowers/specs/2026-08-06-m2-4c-tags-design.md)

**Terminate**: The account action reserved for the CSAM and severe path: a moderator route and a separate confirmed form (not a ladder button) queue a fixed notice that names no reason (the reason is internal only); whether a terminated user may be told why is an open legal question. (see docs/superpowers/plans/2026-10-01-m4-2c-enforcement-ladder.md)

**Tombstone**: A deleted comment that remains as a row with `deleted_at` set and its body emptied, rendered with `deleted: true` and a null author. A deleted post, by contrast, is hard-deleted; and an anonymised account's content is also shown as tombstones. (see docs/superpowers/specs/2026-10-14-moderation-author-notices-design.md)

**Turnstile**: Cloudflare's bot challenge, used on signup, on unauthenticated DSA notice intake and on login (built in #203 and flag-gated: `LOGIN_CHALLENGE` ships `"0"`), to throttle automated abuse. (see docs/superpowers/specs/2026-10-11-login-turnstile-challenge-design.md)

**UserSecurityDO**: The per-user Durable Object whose `bumpEpoch()` invalidates a user's existing sessions; it does not by itself stop a suspended user logging back in, which the account status check does. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

**Violation category**: The `violation_category` recorded on a moderation action (`spam`, `harassment`, `hate`, `sexual`, `violence`, `ip_infringement`, `other`), kept so DSA transparency reporting can produce categorical counts. (see docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md)

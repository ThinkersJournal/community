# M2.3a — Notification core, poll-delivered (design)

**Date:** 2026-07-23
**Status:** approved design; feeds into an implementation plan (`docs/superpowers/plans/`).
**Milestone context:** M2.3 (Notifications) was found to span four subsystems carrying three brand-new infrastructure risks at once (Hibernation WebSockets, Cloudflare Queues, Cron-driven digest batching) plus a second email tier. Per the founder's decision it is **decomposed** the same way M2 was:

- **M2.3a — Notification core, poll-delivered** ← *this doc*. Zero new infrastructure.
- **M2.3b — Realtime push**: `NotifyDO` (one per user) + WebSocket Hibernation API, upgrading poll → live. Queue only if measurement justifies it.
- **M2.3c — Email notifications**: instant high-signal + Cron-batched digests, per-user preferences, unsubscribe, the `notify.` sending subdomain.

Standing decision #10 explicitly permits this ordering: *"DO + WebSocket (Hibernation) push + poll fallback; **polling-only is an acceptable schedule-saver**."* M2.3a ships complete, usable notifications even if realtime slips.

---

## 1. Goal

Tell a user when someone engages with their work — comments, replies, reactions, follows — delivered in-app via a nav bell and a full notifications page. Establish the `notifications` row as the **source of record** (architecture §9) and the single write seam that M2.3b and M2.3c will consume.

## 2. Scope (what ships in M2.3a)

1. **`notifications` table** (migration 0005) — the source of record, with idempotent writes.
2. **Event generation** off the existing M2.1/M2.2 rows: comment on your post, reply to your comment, reaction on your post, reaction on your comment, new follower.
3. **Read API**: keyset list, cheap unread count, mark-read (per-item and all).
4. **Web**: nav bell island with unread badge + dropdown; `/notifications` page with the full keyset history.
5. **Read-time collapsing** of chatty events ("X and 4 others reacted") in one shared helper.

Explicitly **out of scope** (see §10): realtime WebSocket push, Queues, any email, notification preferences, `@`-mentions, KV-cached counts, retention/pruning, moderation notifications.

## 3. Locked decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| 1 | **Decompose M2.3** into a (core) → b (realtime) → c (email) | Four subsystems, three new infra risks. Poll-only is explicitly sanctioned (#10), so the core ships value without betting on WebSockets. Mirrors the M2 decomposition. |
| 2 | Notify on **all five** events | Standing decision #14: "instant in-app for all". Reactions are the most common engagement — omitting them would hide most of an author's signal. |
| 3 | **One row per event; collapse at READ time** | Simplest write path; the collapse rule becomes a pure display concern that can change with **no migration**. Read cost is irrelevant at pre-launch scale. |
| 4 | **Per-item `read_at`** + mark-all-read on open | GitHub-style and familiar; lets one item stay actionable while the rest are cleared. A single "last seen" stamp would lose per-item state. |
| 5 | **Bell dropdown + full page** | The dropdown covers the common glance; the page covers depth (and keeps old notifications reachable). |
| 6 | **Idempotent writes via a UNIQUE natural key** + `ON CONFLICT DO NOTHING` | Each (actor, target, tone) notifies **at most once ever**: react/unreact/re-react and follow/unfollow/re-follow cannot spam a bell (anti-harassment), and the write is safe under the at-least-once Queue M2.3b may add. |
| 7 | A **reply** notifies only the parent comment's author | Notifying the post author on every deep reply would spam them. If parent author == post author they get exactly one notification. |
| 8 | `notify()` is the **single write seam** | One place notification rows are born — the hook M2.3b's DO push attaches to. Same discipline as M2.1's `getFolloweeIds`. |
| 9 | The notification write **never throws** | A failed notification must not lose the user's comment. Same rule as `purgeTags` (M1). |
| 10 | Mark-read runs the pipeline **without** `requireVerifiedEmail` | An unverified user must still be able to clear their own bell; this is not content mutation. Precedent: logout / resend-verification. |

Inherited invariants still in force: the nav renders on **edge-cached** pages, so per-viewer state (the unread badge) must be island-fetched `no-store` and never SSR'd into cached HTML (the nav-auth rule); every `src/pages` file calls exactly one cache helper; all mutations run origin → session → CSRF → epoch.

## 4. Data model — Postgres migration `0005`

```sql
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),   -- time-ordered → keyset cursor
  recipient_id  uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  actor_id      uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN
                  ('post_comment','comment_reply','post_reaction','comment_reaction','follow')),
  post_id       uuid REFERENCES posts(id)    ON DELETE CASCADE,  -- NULL for 'follow'
  comment_id    uuid REFERENCES comments(id) ON DELETE CASCADE,  -- NULL unless comment-targeted
  reaction_kind text,                                            -- NULL unless a *_reaction kind
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  -- Self-notification is impossible at the DB, not merely suppressed in app code.
  CONSTRAINT notifications_no_self CHECK (recipient_id <> actor_id),
  -- THE ANTI-SPAM / IDEMPOTENCY ANCHOR (decision 6). NULLS NOT DISTINCT is
  -- load-bearing: without it the NULL columns make every row distinct.
  CONSTRAINT notifications_event_unique
    UNIQUE NULLS NOT DISTINCT (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind)
);

-- The keyset list ("my notifications, newest first").
CREATE INDEX notifications_recipient_id_desc_idx ON notifications (recipient_id, id DESC);
-- The polled badge: a partial index keeps COUNT(*) of unread cheap.
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;
```

Notes:
- `reaction_kind` is plain `text` (no CHECK against the four tones) **deliberately**: it is display metadata copied from `reactions.kind`, which already has its own CHECK. Duplicating the tone list here would create a second place to edit when a tone is added.
- **Hard-deleting** a post/comment/user cascades the notification away. **Tombstoned** comments (M2.2 soft delete) keep their notifications — the link still resolves and the comment renders "[deleted]", which is the honest result.
- v4/v7 invariant holds: `users` ids stay v4; `notifications` uses uuidv7 because it is keyset-paginated.

## 5. The write seam (`apps/api/src/notifications/create.ts`)

```ts
notify(client, {
  recipientId, actorId, kind,
  postId?, commentId?, reactionKind?,
}): Promise<void>
```

The **only** place a notification row is created. Behavior:
- Returns immediately (no-op) when `recipientId === actorId` — self-suppression in app code, backed by the DB CHECK.
- `INSERT … ON CONFLICT ON CONSTRAINT notifications_event_unique DO NOTHING`.
- **Never throws**: wraps its own failure in a `try/catch` that logs, so a notification problem can never fail (or roll back) the engagement write that triggered it.

Call sites — each runs **after** its primary write has committed, on the same client:

| Trigger | Recipient | kind | Payload |
|---|---|---|---|
| `handleCreateComment`, top-level | the post's author | `post_comment` | `postId`, `commentId` = **the new comment's id** |
| `handleCreateComment`, reply | the **parent comment's** author | `comment_reply` | `postId`, `commentId` = **the new reply's id** |
| `handleAddReaction` on a post | the post's author | `post_reaction` | `postId`, `reactionKind` |
| `handleAddReaction` on a comment | the comment's author | `comment_reaction` | `postId`, `commentId` = the reacted-to comment's id, `reactionKind` |
| `handleFollow` | the followee | `follow` | — |

⚠️ **`commentId` is always the newly-created row for the two comment kinds** (never the parent's). This makes every distinct comment/reply its own event under the unique key — two replies by the same actor to the same parent are two notifications (correct: two events) and each links to its own comment. For `comment_reaction`, `commentId` is the reacted-to comment (the thing whose author is notified).

Draft posts and tombstoned comments already 404/409 upstream (M2.2), so they never reach a notify call.

## 6. API surface (`apps/api`)

| Route | Auth | Notes |
|---|---|---|
| `GET /notifications?cursor=` | session (`readCurrentSession`) | Keyset `id DESC`, page 30. **`WHERE recipient_id = $viewer` is in the query** — the IDOR surface, closed there. Enriched with actor `username`/`displayName` and, where applicable, post `title`/`slug` for linking. `no-store`. |
| `GET /notifications/unread-count` | session | `SELECT count(*) … WHERE recipient_id = $viewer AND read_at IS NULL` over the partial index. Separate from the list so the bell can poll it cheaply. `no-store`. |
| `POST /notifications/read` `{ids}` \| `{all:true}` | mutating pipeline, **no** verified-email gate | Exactly one of `ids` / `all`. `UPDATE … SET read_at = now() WHERE recipient_id = $viewer AND read_at IS NULL AND (…)` — recipient scoping atomic in the WHERE, so it cannot touch another user's rows. Idempotent. |

Both GETs need an explicit `CASES` entry in `error-envelope.test.ts` (standing rule). No new error codes are required — `LOGIN_REQUIRED`, `INVALID_INPUT`, and `INVALID_JSON` cover every failure. No rate limiter: these are session-scoped, cheap, and carry no external cost (unlike mail or purges).

## 7. Web + rendering (`apps/web`)

- **Nav bell island** (`src/scripts/notify-bell.ts`, bundled import — CSP-safe): fetches the count from a `no-store` proxy and renders the badge (capped display at `9+`); clicking opens a dropdown that loads recent items and issues mark-all-read. ⚠️ The nav renders on **edge-cached** pages, so the count is **never** SSR'd — exactly the nav-auth discipline; the page-cache-inventory guard extends to pin it.
- **`/notifications` page**: authed, `markPrivate`, SSR'd keyset list with an "older" cursor link — mirrors `/feed`'s structure, including the manual-302 cookie-carrying redirect on 401 (never `Astro.redirect`).
- **Web proxies** (each `markPrivate`, authed hop forwarding cookie+origin+CSRF + `applyCookies`): `/api/notifications`, `/api/notifications-count`, `/api/notifications-read`.
- **Collapsing helper** in `packages/shared` — groups a page's rows by `(kind, post_id, comment_id)` (order preserved by each group's first occurrence) into one display item, counting **distinct actors**: "«lead actor» and «N−1 others» reacted to «Title»". It is a pure function over the ≤30 rows already on the page — no extra query, no cross-page state. Both the SSR page and the dropdown island call this one helper, so they cannot disagree, and the rule changes with no migration.
  - **Tone in copy**: `reaction_kind` appears ("…found your post Insightful") only for a **singleton** group (exactly one row / one actor / one tone). Any collapsed group drops the tone. This is why keeping `reaction_kind` in the unique key is safe: one actor multi-reacting produces multiple rows that collapse to one display item with a distinct-actor count of 1 ("X reacted…"), never a double-count.
- **Badge vs. list — intentional and reconciled.** The badge counts unread **rows/events** (`unread-count`, cheap partial-index `COUNT(*)`); the list **collapses** those events for readability. So the badge ("5") can exceed the number of display lines ("X and 4 others" = 1 line) — the badge counts what happened, the list groups it. Opening the surface marks all shown rows read, driving **both** to zero. This is deliberate (decision 3, collapse-at-read-time); a badge that matched the collapsed count would require write-time aggregation we explicitly deferred.
- Poll cadence: on load, on tab-focus (`visibilitychange`), and every 60s while the tab is visible.

Copy per kind: `post_comment` → "X commented on your post «Title»"; `comment_reply` → "X replied to your comment on «Title»"; `post_reaction` → "X found your post «Title» {Tone}"; `comment_reaction` → "X reacted to your comment on «Title»"; `follow` → "X followed you". Links target the post page (comment anchors) or the actor's profile.

## 8. Security & integrity

- **IDOR is the primary surface**: every read and the mark-read write scope to `recipient_id = session.userId` inside the SQL. A test proves user B can neither read nor mark-read user A's rows.
- Self-notification blocked in app **and** by DB CHECK.
- Anti-harassment: the unique natural key means toggling a reaction or follow cannot generate repeat notifications.
- No per-viewer state in cached HTML (bell is an island).
- Mark-read is a POST through the full pipeline (origin + CSRF + epoch), so it is not drive-by triggerable.
- Notifications reveal the actor's identity to the recipient — intended, and no more than the public post/comment/follow already does.

## 9. Testing strategy (TDD, per the SDD methodology)

- **Schema**: `notifications_no_self` CHECK, the kind CHECK, the unique natural key (a duplicate insert is a no-op), all three cascades (user/post/comment deletion).
- **Write seam**: each of the five triggers creates exactly one row with the correct recipient/kind/payload; self-actions create none; **re-react after unreact creates no second row** (same tone), while a **different tone from the same actor does** create a distinct row; a reply notifies the parent commenter and *not* additionally the post author; two replies by one actor to one parent create two rows (distinct new-comment ids); a failing notify never fails the parent write.
- **Read API**: keyset page-boundary (disjoint + complete + ordered), unread-count correctness before/after marking, mark-read with `ids` and with `all`, idempotent re-mark, and the **IDOR test** (B cannot see or mark A's rows).
- **Web**: bell island source tests (island-bundled, `no-store`, no SSR'd count), `/notifications` page (one cache helper, `markPrivate`, safe redirect), proxy tests, page-cache-inventory extension, and a collapsing-helper unit test (adjacent grouping, non-adjacent left alone).
- **E2E**: A publishes → B comments → **A's bell shows 1** → A opens the dropdown → sees the entry → badge clears → A's `/notifications` page lists it as read; B follows A → A's badge increments again.

## 10. Deferred / roadmap

- **M2.3b — realtime push**: `NotifyDO` per user + WebSocket Hibernation API, hooked into the `notify()` seam. A Queue only if measurement shows the inline write path needs decoupling (architecture §9 assumes one; at pre-launch volume it may be unnecessary).
- **M2.3c — email**: instant high-signal (replies/mentions/moderation) + Cron-batched digests for reactions/follows, per-user preferences, one-click unsubscribe, the `notify.` subdomain (Tier 2 separate from `verify.`).
- **KV-cached unread count** — when poll volume justifies it (architecture §9 anticipates this).
- **`@`-mentions** — needs mention parsing in the Markdown pipeline, which does not exist yet; a genuinely separate feature.
- **Retention/pruning** of old notifications — when volume justifies it.
- **Moderation notifications** — arrive with the moderation/interaction-permission cluster (deferred in the M2.2 spec §9).

## 11. Open questions

None outstanding — all scope and architecture decisions are resolved above.

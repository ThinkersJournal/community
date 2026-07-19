# M2.1 — Social graph & home feed (design)

**Date:** 2026-07-19
**Status:** approved design; feeds into an implementation plan (`docs/superpowers/plans/`).
**Milestone context:** M2 (Social graph & engagement) is being built as **decomposed sub-milestones**, not one plan. This is the **first** sub-milestone. The remaining M2 sub-milestones (each its own spec → plan → review-gated build):

- **M2.1 — Social graph & home feed** ← *this doc*
- **M2.2 — Engagement**: comments (materialized-path) + reactions
- **M2.3 — Notifications**: in-app (Durable Object Hibernation WebSocket) + email (instant high-signal + batched digests)
- **M2.4 — Discovery**: Postgres full-text search + explore/trending (Analytics Engine + DO write-coalescing) + a follow **recommender**

The decomposition was chosen because M2 spans six subsystems and introduces three brand-new infrastructure risks (real-time WebSockets, an email-notification system, full-text search); building in proven stages matches the founder's milestone philosophy and keeps each plan reviewable.

---

## 1. Goal

Turn the platform from a collection of isolated public post URLs into a **social graph with a personalized home feed**: users choose a durable handle, follow each other, and read a reverse-chronological feed of posts from the people they follow. This is the foundation every later M2 subsystem (comments, reactions, notifications, discovery) builds on.

## 2. Scope (what ships in M2.1)

1. **User-chosen fixed usernames** — pick once, immutable, unique, validated, reserved-word protected. (Clears the M1 → M2 deferral.)
2. **Follow / unfollow** — one-directional, verified-email gated, idempotent, rate-limited.
3. **Follower / following counts + browsable lists** — on profiles, rendered as client-side islands.
4. **Home feed** at `/feed` — pull-on-read, reverse-chronological, keyset-paginated; published posts by followed authors only.
5. **Recent-authors discovery page** at `/authors` — the minimum surface so a new user isn't stranded with an empty feed; a recommender layers on in M2.4.

Explicitly **out of scope** (see §9): user search, explore/trending, follow recommender, comments, reactions, notifications, the KV followee-list cache, denormalized follow counters.

## 3. Locked decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| 1 | Decompose M2; build graph+feed first | Six subsystems + 3 new infra risks; proven stages. |
| 2 | Usernames **user-chosen, fixed (immutable)** | Memorable/shareable profiles without rename→301-redirect/handle-history/SEO/cache-invalidation complexity. Changeable handles can be added later if demanded. |
| 3 | Discovery = **profile links + recent-authors page** | A recommender is coming in M2.4 *on top of* this; recent-authors is the cheap non-empty-feed starting point. |
| 4 | Feed = **Postgres-first, KV-ready seam** | Honors cost decision #23 architecturally (a single `getFolloweeIds` seam) without cache-invalidation risk in the first sub-milestone. The **KV followee-list cache is roadmapped as a committed near-term item** (§9) — the founder expects fast growth and it matters soon after launch. |
| 5 | Follower/following **lists = client-side islands** | Keeps the public profile page anonymous & edge-cacheable (the M1 "no per-viewer state in cached HTML" discipline); lists change on every follow, so they must not be baked into cached SSR. |
| 6 | Feed lives at **`/feed`** (authed), not logged-in `/` | Keeps the public marketing home cleanly separate and cacheable; avoids entangling a per-viewer feed with a public cacheable route. |
| 7 | Username onboarding = **gate before first publish/follow** | Browsing needs no handle; mirrors the soft email-verification gate; gracefully migrates existing system-username accounts. |
| 8 | Follow **counts computed on read** | `COUNT(*)` over indexed `follows` is cheap pre-launch; denormalized counters are a scale item (§9). |

Inherited standing decisions still in force: #7 pull-on-read reverse-chron keyset feed (fan-out deferred to M5+); #11 soft gate (verified email to post/comment/follow); #23 treat Postgres load as reducible (cache graph/feed in KV/DO — see decision 4 above).

## 4. Data model — Postgres migration `0003`

**`follows`**

```sql
follows (
  follower_id  uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)          -- no self-follow (DB-enforced)
)
CREATE INDEX follows_followee_idx ON follows (followee_id);   -- follower lists + counts
```
- Ids reference `users(id)` (v4) — consistent with the users/profiles per-table v4 invariant; posts/media stay uuidv7.
- The PK `(follower_id, followee_id)` covers "who I follow", membership tests, and idempotent insert conflict.
- `follows_followee_idx` covers "who follows X" + `followers_count`.

**Feed read path**

```sql
SELECT <public post columns + author handle/display>
FROM posts p
WHERE p.status = 'published'
  AND p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $viewer)
  AND ($cursor IS NULL OR p.id < $cursor)
ORDER BY p.id DESC
LIMIT $n
```
uuidv7 post ids are time-ordered, so `ORDER BY id DESC` **is** newest-first with no `created_at` index (same payoff as the M1 profile listing). Verify/extend the posts index so the `author_id IN (…)` + `id DESC` path is index-served (a partial index on `(author_id, id DESC) WHERE status='published'` if the M1 profile index does not already serve it).

**Usernames**
- Add `profiles.username_chosen boolean NOT NULL DEFAULT false`. Existing system-username rows migrate to `false` → prompted to choose on next social/publish action.
- Format constraint: `^[a-z0-9_]{3,30}$` (reuse the existing unique index on `profiles.username`).
- Immutable once `username_chosen = true`.

## 5. API surface (`apps/api`)

All mutations run the existing mutating pipeline (origin → session → CSRF → epoch → **verified-email**), matching M1.

| Route | Auth | DB binding | Notes |
|-------|------|-----------|-------|
| `POST /follows` `{followeeId}` | session+CSRF+verified | `HYPERDRIVE_FRESH` | `INSERT … ON CONFLICT DO NOTHING` (idempotent). Rejects self-follow. New **follow rate-limiter** binding. |
| `DELETE /follows/:followeeId` | session+CSRF+verified | `HYPERDRIVE_FRESH` | Idempotent delete. |
| `GET /feed?cursor=` | session | `HYPERDRIVE_FRESH` | Per-viewer; `cache-control: no-store`; **never** edge-cached. Published posts by followees, keyset. |
| `POST /profile/username` `{username}` | session+CSRF+verified | `HYPERDRIVE_FRESH` | Set once. **Verified-email required** — blocks handle-squatting by throwaway signups, and the onboarding flow verifies first anyway. Validates format + reserved-words + uniqueness (409). Immutable after (409 if already chosen). |
| `GET /public/authors?cursor=` | anonymous | `HYPERDRIVE_CACHED`-eligible | Recently-active published authors, keyset. Powers `/authors`. |
| `GET /public/social?username=` | anonymous | read | `{followersCount, followingCount}`. |
| `GET /public/followers?username=&cursor=` / `…/following` | anonymous | read | Keyset user lists (island-consumed). |
| `GET /follows/status?username=` (or folded into the island's authed call) | session | `HYPERDRIVE_FRESH` | Per-viewer `isFollowing`. |

**Social read endpoints** (`/public/social`, `/public/followers`, `/public/following`, `/follows/status`) are **uncached** (`no-store`, island-fetched live) rather than edge-cached-with-purge: they change on every follow, so serving them live from the island sidesteps staleness at pre-launch scale (a short-TTL cache is a later option if read volume warrants it).

**The KV seam:** the feed's graph read is isolated in one function — `getFolloweeIds(client, userId): Promise<string[]>` — today a single indexed Postgres query, later a KV-cached read with Postgres fallback (invalidated on follow/unfollow). No feed call site changes when the cache lands.

## 6. Web + rendering (`apps/web`) — the M1 cache discipline continues

- **Profile page stays anonymous & cacheable.** Follow counts, the Follow/Unfollow button, and follower/following lists are per-viewer and/or change on every follow → they render in a **client-side social island**, never in the cached SSR HTML. The island reads public counts + (when authed) follow-state, and issues follow/unfollow. This is the exact M1 rule: *no per-viewer state in cached HTML*, enforced by the page-cache-inventory guard.
- **`/feed`** (authed): SSR skeleton + island paging `GET /feed?cursor=`. Cards: title, author handle/display, excerpt, date. Empty state links to `/authors`. `markPrivate` (never cacheable).
- **`/choose-username`**: the onboarding gate. Triggered before the first publish/follow when `username_chosen=false`. New signups routed here after email verification; existing test accounts routed here on next social action.
- **`/authors`**: SSR, anonymous, **short-TTL cacheable (60s, untagged)** — same pattern as sitemap/RSS. "Recently active" tolerates 60s staleness and avoids purge-on-every-signup. Each row has a follow affordance (island).

## 7. Security & integrity (M1 patterns carry over)

- All mutations: origin allowlist + double-submit CSRF + **verified-email gate** + rate limiting. Follow gets its own modest limiter (off-Postgres, per decision #23) to blunt mass-follow abuse.
- **No self-follow** (DB `CHECK` + app guard).
- **No draft leak**: the feed and all public reads filter `status='published'`; drafts are invisible exactly as in M1.
- **Username reserved words**: block impersonation handles (`admin`, `support`, `official`, `staff`, `help`, `thinkersjournal`, …) and empty/edge cases. Route collisions are a non-issue — handles live under the `/@` namespace (the `[handle]` route requires `startsWith("@")`), so `/@login` never collides with `/login`.
- Feed/username/follow endpoints all use `HYPERDRIVE_FRESH` (permission + read-after-write).

## 8. Testing strategy (TDD, per the SDD methodology)

- **Migration/schema**: `follows` constraints (no self-follow, cascade delete, PK idempotency), `username_chosen` default, username format constraint.
- **Follow/unfollow**: idempotency, auth + CSRF + verified-email gate, self-follow rejection, rate-limit, unfollow-not-following is a no-op.
- **Feed**: keyset correctness + stable ordering (uuidv7 desc), **only published**, **only followees**, no-draft-leak, empty state, `no-store` (never cacheable), pagination boundaries.
- **Username**: format/reserved/uniqueness (409), immutability (409 on re-set), onboarding-gate routing.
- **Recent-authors**: keyset, only authors with ≥1 published post, ordering, cacheable headers (60s untagged).
- **Cache-inventory guard**: the profile page carries **no** viewer state (counts/follow-button are island-only) — extends the M1 inventory test.
- **E2E** (both Workers, real browser): two users → A publishes → B follows A → B's `/feed` shows A's post → B unfollows → gone; plus the username-onboarding gate.

## 9. Deferred / roadmap

- **KV followee-list cache** — **committed near-term scaling item** (founder priority; deferred out of M2.1 only). Drops into the `getFolloweeIds` seam, invalidated on follow/unfollow. Implement in M2.4 or at the first sign of feed-load Postgres cost, whichever comes first.
- **Denormalized follow counters** — when count-on-read shows cost.
- **User search, explore/trending, follow recommender** — M2.4 (Discovery).
- **Changeable usernames** (301-redirect + handle-history) — only if demanded.
- **Fan-out-on-write feed** — M5+, on measured evidence (standing decision #7).

## 10. Open questions

None outstanding — all scope and architecture decisions are resolved above.

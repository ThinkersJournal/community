# M4 · Report + Block + Auto-Hide — Design

**Status:** Design for founder/PM review, then implementation plan → subagent build.
**Author:** Community controller agent, 2026-09-02. First M4 code module; the
foundation the moderation queue, action ladder, and audit log later attach to.
Also fulfills the founder-mandated interaction-permissions retrofit
([[interaction-permissions-retrofit-roadmap]]).

**Grounding:** every file:line below is from a codebase surface-map pass, not
memory. Patterns mirror the existing `follows` / `reactions` / `comments` code.

---

## 1. Scope

Three coupled capabilities:

1. **Report** — a signed-in, verified member flags a post or comment for review.
2. **Auto-hide** — when a single item draws **≥3 distinct reporters within 24h**,
   it is hidden pending review (design decision #14). Global, not per-viewer.
3. **Block** — a member blocks another; the block controls **interaction**, not
   the visibility of inherently-public content (see §2).

Out of scope here (later M4 modules): the moderation review queue + admin UI,
the warn/suspend/ban ladder + appeals, the `moderation_actions` audit log,
pre-publish scoring. This module records reports, auto-hides on threshold, and
enforces blocks — enough to protect users; the queue consumes it next.

---

## 2. ⚠️ Key design decision — block is INTERACTION-CONTROL, not invisibility

The public post/profile/comment read paths are **viewer-independent and
edge-cached** (`apps/api/src/routes/public.ts:1-10`,
`comments-public.ts:1-10`) — the platform's cost model depends on it (a viral
post ≈ one Postgres query per SWR window regardless of viewers). Per-viewer
block filtering on those pages would force them viewer-scoped / `no-store`,
breaking that model. And posts are **public by design** — a blocked user can log
out and read any post — so "invisibility" there is illusory.

**Therefore "A blocks B" means, in v1:**

| Effect | Enforced where | Cache-safe? |
|---|---|---|
| B cannot **follow** A | `follows.ts` handler | authed, yes |
| B cannot **comment on** A's posts | `comments.ts` handler | authed, yes |
| B cannot **react to** A's content | `reactions.ts` handler | authed, yes |
| B's posts are removed from **A's feed** | `feed.ts` query | authed, yes |
| **Notifications** between A and B are suppressed | `notifications/create.ts` | authed, yes |
| On block, existing **follows both directions are removed** | block handler | — |

It does **not** hide A's public posts from B on the anonymous edge-cached pages.
**Auto-hide is the exception that IS global** (hidden for everyone pending
review), so it applies to those same pages cleanly via `hidden_at IS NULL`.

---

## 3. Data model — migration `0012_moderation.sql`

Single file, `-- Up Migration` / `-- Down Migration` (pattern per
`0004_engagement.sql`). PG18, `uuidv7()` surrogate keys.

**`blocks`** — mirrors `follows` (`0003_social_graph.sql:7`):
```sql
CREATE TABLE blocks (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id),
  CONSTRAINT blocks_pair_unique UNIQUE (blocker_id, blocked_id)
);
-- Enforcement predicate is "is <actor> blocked by <target>?": index the lookup.
CREATE INDEX blocks_blocked_blocker_idx ON blocks (blocked_id, blocker_id);
```

**`reports`** — one-target shape mirrors `reactions` (`0004:30`, one-target
CHECK at `:37`):
```sql
CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
  CONSTRAINT reports_reason_valid CHECK (reason IN
    ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  -- one report per reporter per target (dedup; the auto-hide count is DISTINCT
  -- reporters, and this makes each row already one distinct reporter).
  CONSTRAINT reports_reporter_post_unique    UNIQUE (reporter_id, post_id),
  CONSTRAINT reports_reporter_comment_unique UNIQUE (reporter_id, comment_id)
);
-- The auto-hide threshold query counts reporters on a target in a time window:
CREATE INDEX reports_post_created_idx    ON reports (post_id, created_at)    WHERE post_id IS NOT NULL;
CREATE INDEX reports_comment_created_idx ON reports (comment_id, created_at) WHERE comment_id IS NOT NULL;
```

**Auto-hide columns** (additive; no `hidden`/`hidden_at` exists today):
```sql
ALTER TABLE posts    ADD COLUMN hidden_at timestamptz;
ALTER TABLE comments ADD COLUMN hidden_at timestamptz;
```

Down migration drops the two columns, then `reports`, then `blocks`.

---

## 4. Shared schemas + error codes (`packages/shared/src`)

- `ReportInput` (in a new `moderation.ts`, re-export via the barrel): `{ postId?: string; commentId?: string; reason: <enum> }` with a refine that exactly one target is set. Reasons = the CHECK list above.
- `BlockInput`: `{ blockedId: string }` (uuid).
- New `ApiErrorCode`s in `packages/shared/src/errors.ts:20`: `CANNOT_BLOCK_SELF`, `ALREADY_BLOCKED`, `NOT_BLOCKED` (unblock of a non-block), `BLOCKED` (a blocked actor attempts an interaction), `INVALID_REPORT_TARGET`. Duplicate reports are idempotent (ON CONFLICT DO NOTHING), not an error.

---

## 5. Routes (register in `apps/api/src/routes.ts` ROUTES table)

All follow the mutating-route pattern (`runMutatingPipeline({ requireVerifiedEmail: true })` → `result.session.userId` → `enforceRateLimit` → zod parse → `withClient(env.HYPERDRIVE_FRESH, …)`), per `follows.ts:21-60`.

- `POST /reports` → `handleCreateReport`. New `REPORT_LIMITER` binding. Validate target exists; `INSERT … ON CONFLICT DO NOTHING`; then run the **auto-hide check** (§6) in the same request.
- `POST /blocks` → `handleBlock`. New `BLOCK_LIMITER`. `INSERT … ON CONFLICT DO NOTHING`; delete existing follows both directions; **bust the followee cache** for both users (`bustFolloweeCache`, per `follows.ts:70`).
- `DELETE /blocks/:blockedId` → `handleUnblock`. Delete the row; bust followee cache.

Two new rate-limit bindings in `wrangler.jsonc` `ratelimits` (next `namespace_id` `"1008"`, `"1009"`), then `wrangler types`.

---

## 6. Auto-hide logic

Inside `handleCreateReport`, after the insert, in the same transaction/connection:

```sql
-- distinct reporters on this target in the last 24h (each row is already one
-- distinct reporter thanks to the UNIQUE constraint, so COUNT(*) suffices):
SELECT count(*) FROM reports
 WHERE <target>_id = $1 AND created_at > now() - interval '24 hours';
```
If `count >= 3` **and** the target's `hidden_at IS NULL`, `UPDATE … SET hidden_at = now()`. Threshold `3` is a named constant (decision #14). Idempotent: never un-hides, never re-hides.

**Filtering hidden content out of public reads** — add `AND <t>.hidden_at IS NULL` at each `status = 'published'` clause:
- posts: `public.ts:126,168,248,277,374,416`, `social-public.ts:157`, `feed.ts:58`, and the reaction-target liveness checks `reactions.ts:68,77`.
- comments: `comments-public.ts:61` (can reuse the `deleted_at` tombstone stream shape at `:57,69-74`) and the reaction/comment joins `reactions.ts:199-205,235-240`.

Author-facing "your content is hidden pending review" is deferred to the queue module; v1 just removes hidden content from public surfaces.

---

## 7. Block enforcement points (predicate: "is ACTOR blocked by TARGET?")

`EXISTS (SELECT 1 FROM blocks WHERE blocker_id = <target> AND blocked_id = <actor>)` → reject `403 BLOCKED`:
- **follow** `follows.ts:45-48` — target = `followeeId`, actor = `userId`.
- **comment** `comments.ts:66-73` — target = `postAuthorId` (and `parentAuthorId` `:91`).
- **reaction** `reactions.ts:66-88` — target = `recipientId`.

**Feed filtering** `feed.ts:57-60` — add `AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $viewer AND blocked_id = p.author_id)` so authors the viewer blocked drop out.

**Notification suppression** `notifications/create.ts:75` — after the self-suppression check, skip if the recipient has blocked the actor (or vice versa).

---

## 8. Tests (mirror the existing patterns)

- **Schema** (`*.db.test.ts`, Node project, direct `pg` vs `MIGRATIONS_TEST_DATABASE_URL`) — `blocks-schema.db.test.ts` + `reports-schema.db.test.ts` mirroring `follows-schema.db.test.ts`: columns, FKs, the CHECKs, the UNIQUEs, and the up/down round-trip.
- **Route** (`cloudflare:test`, `test/actor.ts` fixtures, `mutatingHeaders`) — `reports.test.ts`, `blocks.test.ts` mirroring `follows.test.ts`: happy path, dedup idempotency, self-block/self-report rejection, unverified/unauth rejection (auto via route-protection test).
- **Enforcement** — blocked actor gets 403 on follow/comment/react; blocked author's posts absent from the blocker's feed; a `NOTIFY` spy (per `follows.test.ts:209`) confirms suppression.
- **Auto-hide** — 3 distinct verified actors report one post → `hidden_at` set → the post disappears from a public read; a 4th report is a no-op; 2 reports do not hide.

---

## 9. Decisions flagged for review

1. **Block = interaction-control** (§2), not viewer-scoped invisibility. Recommended; the alternative breaks the edge-cache cost model. *(Founder heads-up already sent.)*
2. **On block, remove existing follows both directions** — recommended yes (prevents a stale follow edge leaking feed/notifications).
3. **Report reason taxonomy** — proposed: spam / harassment / hate / sexual / violence / ip_infringement / other. Mirrors the drafted Community Guidelines.
4. **Auto-hide threshold** — 3 distinct reporters / 24h, per decision #14 (not a new choice).

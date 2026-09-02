# M4 · Report + Block + Auto-Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Members can report posts/comments (auto-hiding an item at 3 distinct reporters/24h) and block other users (interaction-control: no follow/comment/react, feed-filtered, notifications suppressed).

**Architecture:** New `blocks` + `reports` tables (migration 0012) and additive `hidden_at` columns on `posts`/`comments`. Two new mutating routes (`/reports`, `/blocks`) following the existing `follows` pattern. Block enforcement inserts a "is actor blocked by target?" predicate into the follow/comment/reaction handlers, the feed query, and the notify seam. Auto-hide is global — a `hidden_at IS NULL` filter added to every public read.

**Tech Stack:** Cloudflare Workers, Postgres 18 (node-pg-migrate), Hyperdrive, Vitest + `cloudflare:test`, zod (`@thinkersjournal/shared`).

**Design source:** `docs/superpowers/specs/2026-09-02-m4-report-block-design.md`.

## Global Constraints

- Every write route MUST call `runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true })` (else `test/route-protection.test.ts` fails) and read the user id as `result.session.userId`.
- All writes use `withClient(env.HYPERDRIVE_FRESH, ctx, …)` — never `_CACHED`.
- Surrogate PKs are `uuid DEFAULT uuidv7()`; FK columns are plain `uuid`. Idempotent writes use `INSERT … ON CONFLICT DO NOTHING`.
- Zod input schemas live in `packages/shared/src/` and are re-exported from the barrel; error codes are added to the `ApiErrorCode` union in `packages/shared/src/errors.ts` and emitted only via `errorResponse(code, status)`.
- New rate-limit bindings go under the `ratelimits` key in `apps/api/wrangler.jsonc` (unique `namespace_id`, `period` 10 or 60), then run `wrangler types`.
- Block predicate (canonical): `EXISTS (SELECT 1 FROM blocks WHERE blocker_id = <target> AND blocked_id = <actor>)`.
- Auto-hide threshold is a named constant `AUTO_HIDE_REPORTER_THRESHOLD = 3` over a 24h window (design decision #14).

---

### Task 1: Migration 0012 — blocks, reports, hidden_at

**Files:**
- Create: `apps/api/migrations/0012_moderation.sql`
- Test: `apps/api/test/blocks-schema.db.test.ts`, `apps/api/test/reports-schema.db.test.ts`, extend `apps/api/test/engagement-schema.db.test.ts` (or a new `moderation-schema.db.test.ts`) for the `hidden_at` columns.

**Interfaces — Produces:** tables `blocks(id,blocker_id,blocked_id,created_at)`, `reports(id,reporter_id,post_id,comment_id,reason,created_at)`, columns `posts.hidden_at`, `comments.hidden_at`.

- [ ] **Step 1: Write the failing schema tests** (mirror `apps/api/test/follows-schema.db.test.ts`): assert `blocks` columns + `blocks_no_self` CHECK + `blocks_pair_unique`; `reports` columns + `reports_one_target` CHECK + `reports_reason_valid` CHECK + the two reporter-target UNIQUEs; `posts.hidden_at` and `comments.hidden_at` exist and are `timestamptz` nullable; and the up/down round-trip via the `runner` (per `migrations.db.test.ts:36-50`).
- [ ] **Step 2: Run — expect FAIL** (`pnpm --filter @thinkersjournal/api test -- moderation-schema` / the new files) — migration/objects absent.
- [ ] **Step 3: Write `0012_moderation.sql`** exactly as in the spec §3 (Up: blocks, reports, the two hidden_at ALTERs, all indexes; Down: drop columns, then reports, then blocks).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`git add apps/api/migrations/0012_moderation.sql apps/api/test/*schema*.db.test.ts && git commit`).

### Task 2: Shared schemas + error codes

**Files:**
- Create: `packages/shared/src/moderation.ts`
- Modify: `packages/shared/src/index.ts` (barrel re-export), `packages/shared/src/errors.ts` (add codes)
- Test: `packages/shared/test/moderation.test.ts`

**Interfaces — Produces:** `ReportInput` (`{ postId?: string; commentId?: string; reason: ReportReason }`, refined to exactly one target, uuid-validated, `reason` ∈ the 7-value enum), `BlockInput` (`{ blockedId: string }` uuid). New `ApiErrorCode`s: `CANNOT_BLOCK_SELF`, `ALREADY_BLOCKED`, `NOT_BLOCKED`, `BLOCKED`, `INVALID_REPORT_TARGET`.

- [ ] **Step 1: Write failing tests** — `ReportInput` accepts one-target + valid reason; rejects zero/both targets, a bad reason, a non-uuid; `BlockInput` accepts a uuid, rejects non-uuid.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `moderation.ts` (zod, mirroring `packages/shared/src/engagement-write.ts`), add the error codes to `errors.ts`, re-export from `index.ts`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

### Task 3: POST /reports + auto-hide

**Files:**
- Create: `apps/api/src/routes/reports.ts`, `apps/api/src/moderation/auto-hide.ts` (the threshold helper)
- Modify: `apps/api/src/routes.ts` (register), `apps/api/wrangler.jsonc` (`REPORT_LIMITER`), then `wrangler types`
- Test: `apps/api/test/reports.test.ts`

**Interfaces — Consumes:** `ReportInput` (Task 2), the `reports` table + `hidden_at` (Task 1). **Produces:** `handleCreateReport`, `POST /reports`.

- [ ] **Step 1: Write failing route tests** (mirror `follows.test.ts` + `actor.ts`): a verified actor reports a post → 201 and a `reports` row exists; a second report of the same target by the same actor is idempotent (still one row); reporting with zero/both targets → 400 `INVALID_REPORT_TARGET`; **auto-hide: 3 distinct verified actors report one post → `posts.hidden_at` is set; a 4th report is a no-op; 2 reports leave `hidden_at` NULL**; unverified/unauth is covered by `route-protection.test.ts`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** `auto-hide.ts` exports `AUTO_HIDE_REPORTER_THRESHOLD = 3` and `maybeAutoHide(c, target)` running the count query (spec §6) and the conditional `UPDATE … SET hidden_at = now() WHERE hidden_at IS NULL`. `reports.ts` = pipeline → `enforceRateLimit(env.REPORT_LIMITER, …)` → parse `ReportInput` → verify the target row exists (404 if not) → `INSERT … ON CONFLICT DO NOTHING` → `maybeAutoHide`. Register in `routes.ts`; add `REPORT_LIMITER` (namespace_id `"1008"`) + `wrangler types`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

### Task 4: Block / Unblock routes

**Files:**
- Create: `apps/api/src/routes/blocks.ts`
- Modify: `apps/api/src/routes.ts`, `apps/api/wrangler.jsonc` (`BLOCK_LIMITER`), then `wrangler types`
- Test: `apps/api/test/blocks.test.ts`

**Interfaces — Consumes:** `BlockInput` (Task 2), `blocks` (Task 1), `bustFolloweeCache` (`apps/api/src/social/followee-cache.ts`, used at `follows.ts:70`). **Produces:** `handleBlock`, `handleUnblock`, `POST /blocks`, `DELETE /blocks/:blockedId`.

- [ ] **Step 1: Write failing tests:** block → 201 + `blocks` row; self-block → 400 `CANNOT_BLOCK_SELF`; re-block idempotent; **on block, a pre-existing follow in either direction is deleted** (assert via a direct `edgeExists`-style query); unblock → row gone; unblock of a non-block → 404 `NOT_BLOCKED`; a `bustFolloweeCache` spy (env-spread override per `follows.test.ts:209`) fires for both users.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** `handleBlock`: pipeline → `BLOCK_LIMITER` → parse → self-check → `INSERT INTO blocks … ON CONFLICT DO NOTHING` → `DELETE FROM follows WHERE (follower_id,followee_id) IN ((blocker,blocked),(blocked,blocker))` → bust followee cache for both. `handleUnblock`: `DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2` (404 if 0 rows) → bust cache. Register both routes; add `BLOCK_LIMITER` (namespace_id `"1009"`) + `wrangler types`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

### Task 5: Block enforcement in follow / comment / reaction handlers

**Files:**
- Modify: `apps/api/src/routes/follows.ts` (~:45), `apps/api/src/routes/comments.ts` (~:73), `apps/api/src/routes/reactions.ts` (~:88)
- Create: `apps/api/src/moderation/is-blocked.ts` (shared predicate helper)
- Test: extend `apps/api/test/follows.test.ts`, `comments.test.ts`, `reactions.test.ts`

**Interfaces — Consumes:** `blocks` (Task 1). **Produces:** `isBlockedBy(c, targetId, actorId): Promise<boolean>`.

- [ ] **Step 1: Write failing tests:** actor blocked by the target gets **403 `BLOCKED`** on: following the target; commenting on the target's post (and on a reply to the target's comment — parent-author case); reacting to the target's post and to the target's comment. A non-blocked actor still succeeds (guard against over-blocking).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `isBlockedBy` (`EXISTS` query, spec §7) and insert the check at each handler's post-target-resolution point (`follows.ts` after the self-check; `comments.ts` after `postAuthorId`/`parentAuthorId` resolve; `reactions.ts` after `recipientId` resolves), returning `errorResponse("BLOCKED", 403)`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

### Task 6: Feed filtering + notification suppression

**Files:**
- Modify: `apps/api/src/routes/feed.ts` (~:57-60), `apps/api/src/notifications/create.ts` (~:75)
- Test: extend `apps/api/test/feed.test.ts` and a notify-suppression test (env-spread `NOTIFY` spy per `follows.test.ts:209`)

**Interfaces — Consumes:** `blocks` (Task 1).

- [ ] **Step 1: Write failing tests:** a post by an author the viewer has blocked is absent from the viewer's feed, while a non-blocked followee's post is present; `notify()` does not create a row when the recipient has blocked the actor (spy sees no push), but does for a non-blocked pair.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Feed: add `AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $viewer AND blocked_id = p.author_id)` to the feed WHERE. `notify()`: after the self-suppression check, `return` early when `isBlockedBy(recipient, actor)` or the reverse (block suppresses notifications both ways).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

### Task 7: Auto-hide filtering across public reads

**Files:**
- Modify: `apps/api/src/routes/public.ts` (`:126,168,248,277,374,416`), `apps/api/src/routes/social-public.ts` (`:157`), `apps/api/src/routes/feed.ts` (`:58`), `apps/api/src/routes/comments-public.ts` (`:61`), `apps/api/src/routes/reactions.ts` (target-liveness `:68,77` and comment joins `:199-205,235-240`)
- Test: extend the relevant public-read tests

**Interfaces — Consumes:** `hidden_at` (Task 1).

- [ ] **Step 1: Write failing tests:** a post with `hidden_at` set is absent from `handlePublicRecent`, `handlePublicDiscover`, `handlePublicProfile`, `handlePublicTag`, and `handleFeed`; a hidden comment is absent from `handlePublicComments`; a reaction cannot be added to a hidden post/comment (target-liveness). A non-hidden control remains present in each.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — add `AND <t>.hidden_at IS NULL` at each `status = 'published'` clause and the comment reads. Keep the change mechanical and uniform.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

---

## Self-review notes

- **Spec coverage:** Tasks 1–7 cover the spec's data model (T1), schemas (T2), reports+auto-hide (T3, T7), blocks (T4), and all block enforcement surfaces (T5, T6). ✅
- **Type consistency:** `isBlockedBy(c, target, actor)` is defined in T5 and reused in T6; `maybeAutoHide` in T3; `AUTO_HIDE_REPORTER_THRESHOLD` single-sourced in T3.
- **Ordering:** T1 (schema) and T2 (shared) are prerequisites for T3–T7. T5 defines `isBlockedBy`, which T6 consumes — dispatch T5 before T6.
- **Deferred (later M4 modules):** the moderation review queue + admin UI, author-facing "hidden pending review" state, warn/suspend/ban ladder, `moderation_actions` audit log. This module records + auto-hides + enforces; it does not adjudicate.

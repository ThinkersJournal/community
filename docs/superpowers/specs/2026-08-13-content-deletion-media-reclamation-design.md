# Content Deletion + Media Reclamation — Design

**Status:** Approved 2026-08-13. Pre-launch milestone (fix-list #4 + #5, see
`docs/pre-launch-fixes.md`; requirements seeded in
`docs/backlog/media-garbage-collector.md`).

**Goal:** Let an author delete their own post, and add a reclaimer that frees
media (DB rows + R2 objects) referenced by no post — covering both
post-deletion orphans and abandoned-upload orphans with one mechanism.

**Why:** A published post currently cannot be deleted (no `DELETE /posts`,
handler, or UI — only create/update/get). And media has no FK to posts (the only
link is the image URL inside `posts.markdown_source`), so deleting a post — or
abandoning an upload — orphans its images, which then consume the owner's quota
(`media.bytes`) and R2 storage forever. These two are coupled: shipping deletion
without reclamation would leak storage on every delete.

---

## Decisions (settled during brainstorming)

1. **Hard delete.** `DELETE FROM posts` — permanently gone, no undo/tombstone.
   Comments, reactions, notifications, and tag-joins cascade (all already
   `ON DELETE CASCADE`); the app already renders a "gone post" gracefully
   (`packages/shared/src/notifications.ts` — null author/href → plain text). Soft
   delete was rejected (it would force `deleted_at IS NULL` filters across every
   feed/search/profile AND force the reclaimer to exclude deleted posts'
   markdown — much larger surface, premature pre-launch).
2. **Media reclamation = Approach A (periodic reference scan).** A daily cron
   derives the referenced-image set by scanning all `posts.markdown_source`, then
   reclaims unreferenced media past a grace period, then dedup-safe-deletes the R2
   objects. One mechanism for both orphan classes; no write-path changes; mirrors
   the just-shipped unverified-account reaper. (Maintained `post_media` join and
   pending/promote lifecycle rejected as premature — YAGNI.)
3. **Grace period 24h**, reclaimer cron **`15 4 * * *`** (offset from the reaper's
   `30 3`).
4. **Delete affordance:** the **post page** (primary, required) via an owner-only
   client island, PLUS the **editor** (secondary convenience). Post-page deletion
   is a necessity (deletion acts on an existing post); the editor button is a
   nice-to-have.
5. **Confirm:** an inline two-step confirm ("Delete" → "Really delete?
   [Confirm] [Cancel]") — never a browser `confirm()` dialog (CSP + the codebase's
   no-dialog rule).

**Non-goals:** soft delete / undo / trash; bulk delete; admin/moderation deletion
of others' posts (this milestone is owner-only self-deletion — moderation is a
later concern); changing the media upload path.

---

## Architecture / approach

Post deletion follows the existing mutation discipline: owner-authorization lives
in the SQL `WHERE` clause (race-safe under the transaction-mode pooler, exactly
like the edit path), and cache purge reuses the edit handler's `purgeTags`.
Deletion never touches R2 — it just makes the post's media unreferenced; the
reclaimer (a cron, like the reaper) frees rows + objects out of band, preserving
the codebase's "never delete an R2 object inline" rule (content-addressed objects
can be shared between users).

---

## Components & changes

### 1. `DELETE /posts/:id` — `apps/api/src/routes/posts.ts`, `routes.ts`

- New handler `handleDeletePost`, registered as `{ method: "DELETE", pattern:
  "/posts/:id", handler: handleDeletePost }`.
- Runs the mutating pipeline with `requireVerifiedEmail: true` (origin → session →
  CSRF → epoch → verified-email), same as create/update.
- **Read the tag slugs BEFORE the delete** (`readTagSlugs(c, id)`), inside the
  transaction. ⚠️ Ordering is load-bearing and DIFFERENT from the edit path: the
  `DELETE` cascades `post_tags` away, so reading them afterward (as the edit
  handler does with `oldSlugs`) would return nothing. Tags are public data, so
  reading them for an id that turns out not-owned/nonexistent leaks nothing — the
  cost is one cheap `SELECT` on a 404, accepted to keep the read before the
  cascade.
- Then `DELETE FROM posts WHERE id = $1 AND author_id = $me RETURNING slug`.
  Ownership is the `WHERE` clause; **zero rows → 404** ("no such post" and "not
  yours" answered identically, like the edit path — and the tag slugs read above
  are discarded, no purge). A malformed id (22P02) → 404 (reuse
  `isInvalidTextRepresentation`).
- Cascade is automatic: `comments`, `reactions`, `notifications.post_id`,
  `post_tags` are all `ON DELETE CASCADE` on `posts(id)`.
- **Purge** (mirror the edit handler, awaited before responding, only on a hit):
  `purgeTags(env, ["post:" + id, "author:" + authorId, "listing", ...tagSlugs.map(s => "tag:" + s)])`.
  Never throws (post already deleted; a failed invalidation must not error the
  response). Below the 404 (same purge-quota security ordering as the edit path:
  a 404 delete purges nothing).
- **Response:** `200` with `{ username }` — the author's own handle via
  `usernameFor(c, authorId)` (same as the edit handler), so the web can redirect
  to `/@username`. Media is NOT touched (the reclaimer frees it).

### 2. Web — post-page owner delete island (primary)

- `apps/web/src/pages/[handle]/[slug].astro` already carries `data-post-id` and
  `data-post-author-id` (used by the comment island). Add a **hidden** owner-only
  delete control (SSR default hidden, cache-safe — the page is edge-cached and
  anonymous) carrying the post id + author id.
- New client island `apps/web/src/scripts/post-delete.ts`: fetches `/api/me`
  (`{ userId, csrfToken }`), and if `me.userId === <post author id>` reveals the
  Delete button. Click → inline confirm (Delete → "Really delete? [Confirm]
  [Cancel]"). Confirm → `fetch` the same-origin delete proxy with the CSRF token →
  on success, `location.href = "/@" + handle`.
- CSP: the page already loads client islands under `script-src 'self'`; this is
  another bundled module — no CSP change.

### 3. Web — editor delete button (convenience)

- `apps/web/src/pages/new-post.astro` (the `?post=<id>` edit mode) is already
  owner-only + per-viewer. Add a Delete button that submits a form; the page's
  server handler forwards `DELETE /posts/:id` via `apiFetch` (server-side, same
  idiom as signup), then redirects to `/@username`. (Inline confirm here too.)

### 4. Web — the delete proxy

- A same-origin web endpoint forwards the browser's delete to the api over the
  Service Binding (the api has no public origin), applying cookies — the same
  proxy idiom the comment island's mutations already use (`/api/*`). The
  post-page island calls it via `fetch(..., { method: "DELETE", headers: {
  "X-CSRF-Token": csrf } })`; the editor may reuse it or forward server-side. It
  forwards the browser's Origin (for `checkOrigin`) and the session cookie.

### 5. Media reclaimer — `apps/api`

- **New** `apps/api/src/media/reap-orphan-media.ts` exporting
  `reapOrphanMedia(env, ctx): Promise<{ rows: number; objects: number }>`:
  - **Reference set + orphan delete**, one bounded statement on `HYPERDRIVE_FRESH`:
    ```sql
    WITH referenced AS (
      SELECT DISTINCT (regexp_matches(markdown_source,
                       'media/post/([0-9a-f]{64})\.webp', 'g'))[1] AS sha256
        FROM posts
    ),
    orphans AS (
      SELECT m.id FROM media m
       WHERE m.created_at < now() - interval '24 hours'
         AND NOT EXISTS (SELECT 1 FROM referenced r WHERE r.sha256 = m.sha256)
       ORDER BY m.created_at
       LIMIT $1                       -- REAP_BATCH, e.g. 500
    )
    DELETE FROM media WHERE id IN (SELECT id FROM orphans)
    RETURNING r2_key;
    ```
    Keyed on `sha256` (the media table's own column; the r2_key embeds it). The
    scan is conservative: a sha256 appearing anywhere in any markdown (published
    OR draft) counts as referenced — better to keep than wrongly delete. sha256 is
    stored lowercase (`sha256HexOf`) and the URL/key are lowercase, so the match is
    case-consistent.
  - **Dedup-safe R2 object delete:** for each DISTINCT `r2_key` returned, check
    `SELECT 1 FROM media WHERE r2_key = $1 LIMIT 1`; if none remain, `await
    env.MEDIA.delete(key)`. A key still held by another user's row keeps its
    object. Swallow per-object R2 errors (log and move on): the `media` row is
    already gone by this point, and the reaper only ever scans surviving
    rows — a failed R2 delete is never revisited, so it leaves a PERMANENT
    orphaned object, not a retry candidate. Accepted: rare, storage-bytes
    only, and in the safe direction (the object outlives the row, never the
    reverse); a future bucket-vs-DB sweep could reclaim it if it ever matters.
  - Log the counts (`rows`, `objects`).
- **Cron** `"15 4 * * *"` added to `apps/api/wrangler.jsonc` `triggers.crons`.
- **Dispatcher** (`apps/api/src/index.ts` `scheduled`): add an explicit branch
  `if (controller.cron === "15 4 * * *") { ctx.waitUntil(reapOrphanMedia(env, ctx)); return; }`
  alongside the existing reaper (`30 3`) and email-drain branches.
- **Test hook:** `TEST_ROUTES`-gated `POST /__test/reap-orphan-media` returning
  `{ rows, objects }`, mirroring the reaper's `/__test/reap-unverified`
  (same triple gate: `TEST_ROUTES === "1"` + `checkOrigin` + the routes.ts
  wrapper delegating to the gated `handleTestRoute`).

---

## Error / wire

| Case | Status | Body |
|------|--------|------|
| Deleted | 200 | `{ username }` |
| Not owner / no such post | 404 | `NOT_FOUND` |
| Unverified email | 403 | `EMAIL_NOT_VERIFIED` |
| Origin/CSRF fail | 403 | `FORBIDDEN` |
| Malformed id | 404 | `NOT_FOUND` |

---

## Testing

- **`apps/api/test/posts.test.ts`** (or a new `posts-delete.test.ts`): owner
  deletes → subsequent `GET` 404s; a comment + reaction on the post are gone
  (cascade); the delete purges `post:`/`author:`/`listing`/`tag:` (assert via the
  purge spy, same idiom as `purge-wiring.test.ts`); delete by a non-owner → 404;
  delete unverified → 403; malformed id → 404. The purge-quota ordering ("a 404
  delete purges nothing") is pinned like the edit path.
- **`apps/api/test/reap-orphan-media.test.ts`** (real DB + a stub/real `env.MEDIA`
  via `cloudflare:test`, using `createExecutionContext`/`waitOnExecutionContext`):
  seed (a) an unreferenced media row >24h old → reaped, its R2 object deleted;
  (b) a media row whose sha256 appears in a post's markdown → kept; (c) a media
  row <24h old, unreferenced → kept; (d) TWO rows sharing one r2_key where ONE is
  referenced → the unreferenced row's row is reaped but the R2 object is KEPT
  (dedup); (e) a post-deletion orphan (row exists, no post references it) → reaped.
  Verify returned counts.
- **e2e** (`e2e/publish.spec.ts` or a delete spec): author signs up, publishes a
  post with an image, deletes it from the post page (owner button → confirm), and
  the post URL then 404s.

---

## Rollout notes

- No migration — this milestone adds a route, a cron, and web islands; no schema
  change.
- The reclaimer cron is new; confirm it registers on deploy (`wrangler deploy`
  surfaces cron triggers).
- The reclaimer depends on `env.MEDIA` (the R2 bucket binding) already being
  present (it is — the upload path uses it).

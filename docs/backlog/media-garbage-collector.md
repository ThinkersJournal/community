# Media Garbage Collector — Requirements (future, ~M4)

> **Status:** Backlog. Not yet scheduled. This note seeds the eventual GC
> spec/plan. Added 2026-08-13 after pre-launch testing surfaced an orphan class
> the originally-planned GC would not reclaim.

## Context

Media uploads are **content-addressed**: stored in R2 under
`media/<variant>/<sha256>.webp`, with one `media` table row per upload. The R2
key is deliberately **not** unique — two users uploading the same bytes share
**one** R2 object with **two** `media` rows (`apps/api/migrations/0002_posts_and_media.sql`,
`apps/api/src/routes/media.ts:84-86`). `media.bytes` is the per-user storage
**quota**.

Uploads commit **immediately and independently of any post**: the post
references the file only as URL text inside `posts.markdown_source`. There is
**no FK and no join table** linking media → post.

The codebase never deletes R2 objects inline. Reclamation is deferred to this
offline GC.

## Two orphan classes the GC MUST handle

### Class 1 — R2 object with no remaining `media` row  *(already planned)*
When a `media` row is removed (future post-deletion cascade, moderation
removal), the R2 object can linger. The GC drops R2 objects with no remaining
`media` row.
- **Safety invariant:** because objects are shared, an object may be deleted
  **only** when **no** `media` row references its `r2_key`/`sha256`. Ref-count
  across all rows before deleting the object. NEVER delete an object out from
  under another user's row.

### Class 2 — `media` row referenced by no content  *(NEW — the gap)*
A user adds an image to a post, then abandons/discards the compose before
saving. The `media` row **and** the R2 object persist forever, referenced by
nothing. **Class 1's GC never catches this — the row still exists.** These
orphans:
- consume the owner's quota (`media.bytes`) indefinitely, and
- accumulate with every abandoned compose session.

**Requirement:** the GC must detect and reclaim never-referenced `media` rows.
- A row is "referenced" iff its URL (`<MEDIA_CDN_ORIGIN>/<r2_key>`) appears in
  some `posts.markdown_source` (published **or** draft).
- Reclaim rows that are unreferenced **and** older than a grace period
  (e.g. 24–48h, so an in-progress compose is never raced).
- Deleting the row frees the quota; then apply the Class-1 object deletion
  (ref-count across any remaining rows first).

*Empirically observed 2026-08-13:* founder added a 2 KB image to a post they
discarded → `media` row `019ff92c…` + R2 object `media/post/c781129e…webp` both
persisted with zero post references, charged against quota. This is the Class-2
orphan in the wild.

## Design options to weigh at spec time

- **Reference scan** (simple, periodic): scan all `posts.markdown_source` for
  media URLs, diff against `media` rows. O(posts) per run; fine at small scale.
- **Maintained reference table** (`post_media` join, updated on every post
  save): precise, but requires wiring all write paths + a backfill.
- **Upload-as-pending + promote-on-save**: `media` rows start `pending`,
  promoted to `referenced` when a citing post is saved; GC reaps `pending` rows
  past the grace period. Cleanest lifecycle; touches upload + post-save paths.
- Fold in with **moderation deletion** (also M4) — one GC pass.

## Why it matters

Quota correctness depends on Class-2 reclamation: without it, a user can
exhaust their storage quota purely by abandoning composes, and dead bytes
accumulate in R2 with no path to release. Keep the content-addressed dedup
invariant sacred throughout: never delete an R2 object while any `media` row
references its key.

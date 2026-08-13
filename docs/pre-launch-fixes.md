# Pre-Launch Fix List

Issues found during pre-launch testing on `*.workers.dev` (2026-08-12/13),
before the custom domain goes live. Each item: what, evidence (`file:line`),
root cause, disposition.

**Disposition legend:** `Fix before launch` · `Defer` · `Decision needed`

---

## 1. Handle selection at signup   `Decided (Option A, 2026-08-13) → Fix before launch`

**Decision:** the permanent handle is chosen on the **signup form** itself
(email + password + @handle), before email verification. This removes the
first-post gate entirely and eliminates the placeholder-then-claim flow.

**Original problem it replaces:** a placeholder username
(`<emaillocal>_<randomsuffix>`, `signup.ts:93-99`) was minted at signup, and the
user was forced to pick a permanent, immutable handle with no advance warning —
the "can't be changed later" copy (`choose-username.astro:120`) appeared for the
first time **inside the first-post editor**. The spec intended a
post-verification redirect (`.../2026-07-19-m2-1-...:104`) that was never built,
so the gate ambushed users at first publish/follow.

**Scope of the change:**
- Add `username` to the signup input + form: zod format validation, an
  availability check, and collision handling — accept the chosen handle when
  free; on collision, suggest the first available variant (`name`, `name2`, …),
  never a random suffix. *(Absorbs former item #3.)*
- Set `profiles.username` to the chosen handle at signup and mark
  `username_chosen = true` immediately; keep it immutable afterward (unchanged
  policy).
- **Remove the now-dead onboarding path:** `apps/web/src/pages/choose-username.astro`,
  `POST /profile/username` (`apps/api/src/routes/username.ts`), the
  `requireChosenUsername` gate on posts/follows (`posts.ts:261-275`), and the
  placeholder generator `generateUsername` (`signup.ts:93-99`). No
  post-verification redirect needed.

**Required companion — unverified-account handle reaper (anti-squatting):**
because handles are now claimed *before* verification, an unverified/bot account
can reserve a handle it never uses. A reaper must release handles from accounts
left unverified past a grace period. Requirements captured in
`docs/backlog/unverified-account-reaper.md`.
**Decided (2026-08-13): ships before launch**, folded into this handle-at-signup
milestone (no one is waiting on the launch — do it right).

**Note:** feature-sized change (signup schema, auth flow, route removals, new
reaper) — recommend a short spec → plan → build, not an inline patch.

---

## 2. Notification bell — empty oval + un-closable dropdown   `Fix before launch`

**What:** (a) An empty rounded box renders near the bell on every page load.
(b) The dropdown ("No notifications yet.") can't be closed except by navigating
to another page.

**Evidence:**
- `apps/web/src/components/Nav.astro:50` — `display:flex` on `.notify-panel`;
  `Nav.astro:41` — same on `.notify`.
- `apps/web/src/scripts/notify-bell.ts:304-310` — toggle logic is correct
  (second click sets `hidden = true`) but has no visual effect.

**Root cause:** ONE bug — author CSS `display:flex` overrides the `hidden` HTML
attribute (no `[hidden]{display:none}` rule exists), so the panel renders when
it should be hidden **and** `panel.hidden = true` is inert. Additionally
missing: outside-click close, Escape-to-close, and `aria-expanded` (the burger
menu has all three; the bell was never given them).

**Fix:** make `hidden` win (`[hidden]{display:none}` in `global.css`, or drive
open/close with an explicit `.open` class), then add outside-click + Escape +
`aria-expanded` for a proper accessible dropdown. *(The unread-count badge is
NOT the oval — it hides correctly at 0, `notify-bell.ts:81-89`.)*

---

## 3. Handle collision UX   `Folded into #1`

Accept the chosen handle when free; on collision, suggest the first available
variant (`name`, `name2`, `name3`…) rather than a random suffix. With handle
selection moved to the signup form (Option A, item #1), this is now implemented
**as part of #1** and applies at signup — there is no longer a separate picker.

---

## 4. Media reclamation (garbage collector)   `Promoted to pre-launch — coupled with #5`

**What:** Media becomes orphaned two ways: (Class 2) an image added to a post
that's then discarded, and — once #5 ships — (the post-deletion case) a
published post's images when the post is deleted. There is **no FK from `media`
to `posts`** (the only link is the image URL inside `posts.markdown_source`), so
deleting a post does **not** cascade to its media; the images simply become
referenced-by-nothing. Both cases are the **same orphan**: a `media` row
referenced by no post, consuming the owner's quota forever.

**Disposition — was "defer to M4", now PRE-LAUNCH (decided 2026-08-13):** because
#5 (post deletion) ships pre-launch, deleting a post would leak its images
without reclamation — so the reclamation must ship alongside it. Crucially it is
**one mechanism**: a reference-based reclamation ("reclaim `media` rows
referenced by no post, then dedup-safe R2 object deletion") serves both the
post-deletion orphans and the abandoned-upload orphans. The design's
never-delete-R2-inline rule (content-addressed dedup) is preserved — deletion
makes media unreferenced; the reclaimer removes rows and ref-count-deletes
objects. Requirements in `docs/backlog/media-garbage-collector.md`. Build as one
milestone with #5.

---

## 5. Post deletion   `Fix before launch`

**What:** A published post cannot be deleted. There is no `DELETE /posts/...`
route, no delete handler (only `handleCreatePost`/`handleUpdatePost`/
`handleGetPost` in `apps/api/src/routes/posts.ts`), and no web UI. The only
`DELETE` routes in the app are follows, comments, and reactions. Users cannot
remove their own content.

**Evidence:** `apps/api/src/routes.ts` (no `DELETE`/posts entry);
`apps/api/src/routes/posts.ts` (exports create/update/get only).

**Scope:** add a `DELETE /posts/:id` route (owner-authorized, verified-email
gated per the existing mutation pipeline) + the web affordance to trigger it.
Deleting a post must free its images — see #4. **Build #4 and #5 together** as
one "content deletion + media reclamation" milestone: post deletion is the first
concrete producer of post-deletion media orphans, and the reclaimer is what
keeps that from leaking storage/quota.

---

## Not a fix — resolves with the domain

**Post image preview doesn't display uploaded images.** Uploads work
end-to-end; the preview `<img>` points at `https://cdn.thinkersjournal.com/...`,
which resolves once the media custom domain is attached at DNS launch. Not a
CSP block, not unfinished, not a bug (`apps/api/src/routes/media.ts:64,225`
hardcode the CDN origin; `apps/web/src/lib/csp.ts:58` allows it). No action
beyond the DNS step.

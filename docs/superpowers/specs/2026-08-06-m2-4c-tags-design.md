# M2.4c — Tags (design)

**Milestone:** M2.4c, the third and final sub-milestone of M2.4 Discovery (**Search → Discover → Tags**). Search merged via PR #11 (`a5fbf12`), Discover via PR #13 (`0feb752`).

**Goal:** Let authors attach freeform tags to posts, and let readers browse published posts by tag — adding a topic/curation axis alongside Search (fuzzy text) and Discover (recency). Delivered: tag input in the editor, tag chips on the full post page **and** on listing cards, an anonymous edge-cached per-tag page (`/tag/<slug>`), and a popularity-ordered tag index (`/tags`) with a nav link.

## Product framing

Tags are **freeform / author-created** (like dev.to/Medium): an author types tags when writing; a new tag is created on first use. There is no curated vocabulary and no moderation tooling (deferred). Tags are normalized to a lowercase `citext` slug so `AI` and `ai` collapse to one tag/one URL/one cache entry; the author's original text is kept as the display `label`.

## Decision log (what was chosen and why)

- **Freeform, author-created vocabulary** — YAGNI for a young community; no admin tooling required. Curation (featured/hidden/merge) is deferred.
- **Normalized join model** (`tags` + `post_tags`), not a denormalized `posts.tags citext[]` — it matches the existing keyset machinery for "published posts with tag X, newest first" and the `GROUP BY` count query for the index, and gives tags a first-class row for the label + future curation.
- **`citext` slug** — matches the `posts.slug` precedent; case-insensitive URL/cache-key collapsing.
- **Scope = full feature**: editor input + chips on post page + chips on cards + `/tag/<slug>` pages + `/tags` index + nav link. (Both optional surfaces were chosen.)
- **No-JS comma-separated editor input** — matches the form-POST editor (zero island). A chip/autocomplete widget is deferred.
- **`/tags` ordered by published-post count (popularity)**, capped at the top ~100.
- **Per-tag pages subscribe to `tag:<slug>`; the `/tags` index subscribes to `listing`** — the individual tag page only changes when a post carrying that tag changes; the index's counts shift on any publish/edit (`listing` already fires then).
- **Max 5 tags/post.**

## Architecture

### 1. Data model — migration `0010_tags.sql`

```sql
CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  slug       citext NOT NULL UNIQUE,
  label      text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_tags (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- Serves the per-tag keyset ("published posts with this tag, newest first").
CREATE INDEX post_tags_tag_id_idx ON post_tags (tag_id);
```

The per-tag listing query joins `post_tags → posts` filtered to `status='published'` and keyset-ordered by `posts.id DESC`; `post_tags_tag_id_idx` (plus the existing `posts_published_key`) serves it. Tag rows are upserted freeform on write; they are never deleted by this milestone (an orphaned tag with zero published posts simply doesn't appear in `/tags` or match a listing — cleanup is out of scope).

### 2. API

- **`POST /posts` (create) / `PATCH /posts/:id` (edit)** — add `tags` to the input schemas:
  - `tags: z.array(z.string().trim().min(1).max(50)).max(5).default([])` — the client sends the author's raw **labels** (comma-split from the editor input). The server derives each tag's `slug` via `slugify(label)` (lowercase `citext`, `[a-z0-9-]`, capped at 50), **drops** any label that slugifies to empty, and **dedupes by slug** (keeping the first label per slug within the post). Each tag row is upserted `ON CONFLICT (slug) DO NOTHING`, so the first-ever writer's `label` is retained platform-wide for that slug (renaming a label later is deferred).
  - In `insertPost` / `handleUpdatePost`, within the **same held connection**: upsert each tag (`INSERT INTO tags (slug,label) VALUES … ON CONFLICT (slug) DO NOTHING`), resolve ids, then rewrite `post_tags` (`DELETE` the post's rows + `INSERT` the new set).
  - On **edit**, read the post's **prior** tag slugs in that connection (before rewriting) — required for purge (§3).
  - Add `tags: TagRef[]` (`TagRef = {slug,label}`) to `AuthoredPost` and the `GET /posts/:id` SELECT so the editor pre-fills on edit.
- **`GET /public/tag?slug=&cursor=`** — anonymous, `HYPERDRIVE_FRESH`, `jsonNoStore`. Near-clone of `handlePublicDiscover`: `SELECT … FROM post_tags pt JOIN posts p ON p.id=pt.post_id JOIN profiles pr ON pr.user_id=p.author_id JOIN tags t ON t.id=pt.tag_id WHERE t.slug=$1 AND p.status='published' AND p.id < $2 ORDER BY p.id DESC LIMIT PAGE_SIZE+1`. `cursor` defaults to `MAX_CURSOR`; malformed cursor → 400 `INVALID_INPUT{fields:["cursor"]}`; missing/blank `slug` → 400 `{fields:["slug"]}`. Returns `TagPage = { tag: TagRef, posts: RecentPost[], nextCursor: string|null }`. An unknown/zero-post tag returns `200 { tag:{slug, label:slug}, posts:[], nextCursor:null }` (the web page renders an empty state — a tag with no published posts is not an error).
- **`GET /public/tags`** — anonymous, `HYPERDRIVE_FRESH`, `json()`. `SELECT t.slug, t.label, count(*) AS n FROM tags t JOIN post_tags pt ON pt.tag_id=t.id JOIN posts p ON p.id=pt.post_id WHERE p.status='published' GROUP BY t.slug,t.label ORDER BY n DESC, t.slug ASC LIMIT 100`. Returns `{ tags: TagCount[] }`, `TagCount = {slug,label,count}`.
- **DTO changes** — add `tags: TagRef[]` to `PublicPost` (full post page) and to `RecentPost` / `PublicPostSummary` / `FeedPost` (cards), populated by a per-row aggregate (e.g. a `LEFT JOIN LATERAL`/`array_agg` subquery of the post's tags) in each listing SELECT. New shared types: `TagRef`, `TagPage`, `TagCount`.

### 3. Purge model (the one genuinely new piece)

The single, batched `purgeTags(env, [...])` request per write is preserved — tags are added to the existing array, never a new request (well within the 5-req/min · 100-op/req quota; a post has ≤5 tags):

- **Publish** (create with `status='published'`): `["author:${authorId}", "listing", ...newTags.map(t => \`tag:${t}\`)]`.
- **Edit**: `["post:${id}", "author:${authorId}", "listing", ...union(oldTags,newTags).map(t => \`tag:${t}\`)]` — the union is load-bearing: a tag **removed** on edit must still purge its `/tag/<slug>` page, or that page shows the post for up to 25h.
- Subscriptions: `/tag/[slug].astro` → `markPublicCacheable(["tag:<slug>"])` (never `listing`). `/tags.astro` → `markPublicCacheable(["listing"])`. Card chips need no new purge — they ride the `listing`/`author:<id>`/`post:<id>` purges of the Discover/profile/post pages they appear on, which already fire on the relevant writes.

### 4. Web

- **Editor** (`new-post.astro`): a no-JS `<input name="tags" placeholder="tags, comma, separated">` between the body textarea and the media fieldset; read from `formData` in the POST branch, split/trim/dedupe, threaded into the `apiFetch` body for both draft and publish; pre-filled from `existing.data.tags` (joined labels) on the `?post=` edit load. Stays `markPrivate` + `setPublicPageCsp`; no new island.
- **Post page** (`[handle]/[slug].astro`): a `<ul class="tags">` of chips after the byline, each `<a href="/tag/${encodeURIComponent(slug)}">${label}</a>` (label rendered as escaped text).
- **Cards** (Discover `index.astro`, profile `[handle]/index.astro`, feed `feed.astro`): a compact chip row per card from the card DTO's `tags`.
- **`/tag/[slug].astro`** (new, literal `tag/` dir + dynamic slug — no `@`-guard needed; static-wins): clone of `index.astro` — anonymous `apiFetch<TagPage>` without `request`, fail-closed 503 on non-200/null before the cache mark, `markPublicCacheable(["tag:<slug>"])`, `setPublicPageCsp`, `PageLayout` header ("Tag" / `#label`), the post cards, keyset "Older posts →" pager (+ "← Newest" on cursor pages), cursor pages `noindex`, `canonical` → the bare `/tag/<slug>`. Empty state for a tag with no posts.
- **`/tags.astro`** (new): `markPublicCacheable(["listing"])`, `setPublicPageCsp`, `PageLayout` ("Discover" / "Tags"), a list of tag chips (label + count) each linking to `/tag/<slug>`, ordered by count. Empty state when there are no tags yet.
- **Nav** (`Nav.astro`): add `<a href="/tags">Tags</a>` in the browse links (pure-static, keeps the nav viewer-independent).

## Data flow

```
Author publishes/edits a post with tags
  → POST /posts | PATCH /posts/:id (apps/api/src/routes/posts.ts)
  → upsert tags + rewrite post_tags in the held connection; on edit, read prior tags first
  → purgeTags(env, [..., "listing", ...tag:<slug> for new (publish) or old∪new (edit)])
  → the /tag/<slug> pages for affected tags + the /tags index + Discover home all evict

Reader opens /tag/<slug> (or /tags)
  → the .astro page SSRs anonymously (no Cookie) → apiFetch /public/tag (or /public/tags), HYPERDRIVE_FRESH
  → renders cards + pager (or the tag list); markPublicCacheable(["tag:<slug>"]) (or ["listing"])
  → nav auth slot hydrates client-side (cache-safe)
```

## Load-bearing invariants

- **Edit purge uses old ∪ new tags** — removed tags must purge their page. Guarded by a purge-wiring test.
- **`/tag/<slug>` cache tag string byte-matches the api purge literal** (`tag:<slug>`), and the slug is the normalized `citext` slug on both sides. A mismatch silently leaves a stale tag page for 25h.
- **`/tag` and `/public/tags` read `HYPERDRIVE_FRESH`** — they back purge-tagged edge pages; a cached read reopens the read-after-write staleness window. (`handlePublicRecent` remains the sole `HYPERDRIVE_CACHED` route.)
- **Anonymous, leak-safe**: the tag pages `apiFetch` without `request`; only `status='published'` posts appear; tag `label`/post fields render as escaped text (never `set:html`); every interpolated URL segment is `encodeURIComponent`-wrapped.
- **Exactly one cache helper per page**; tag pages fail closed (uncached) on a non-200 upstream result, mirroring `index.astro`.
- **Slug normalization is identical** on write (server slugify) and on read (URL slug → citext match). Tag input is validated + capped at 5 + deduped server-side.

## Error handling

- Malformed cursor → 400 `{fields:["cursor"]}`; blank slug → 400 `{fields:["slug"]}`; invalid/oversize tags (>5, bad shape) → 400 `{fields:["tags"]}` via zod.
- `/tag/<slug>` for an unknown or zero-published-post tag → a normal 200 empty state, not a 404 (tags aren't resources that 404; an empty tag page is valid and cacheable).
- Web pages treat any non-200 as a fail-closed uncached 503 (tag/`tags` pages) — never a cached empty page.

## Testing strategy

- **DB (`apps/api/test/…db.test.ts`)**: migration 0010 creates `tags`/`post_tags` + the index; the join returns published posts by tag newest-first and excludes drafts; `ON DELETE CASCADE` removes `post_tags` when a post is deleted.
- **API**: create/edit thread tags (upsert + rewrite; ≤5 enforced; dedupe); **purge-wiring** asserts publish appends `tag:<slug>` for new tags and edit appends `tag:<slug>` for old ∪ new (including a removed tag); `/public/tag` keyset (full page → nextCursor → non-overlapping older page, drafts excluded, unknown tag → empty 200, malformed cursor → 400); `/public/tags` counts + popularity order; the DTOs carry `tags`; `hyperdrive-binding-inventory` stays green (new routes FRESH); `error-envelope` CASES probes for the new 400 paths.
- **Web (static)**: editor has the `name="tags"` input and threads it (no island added); post page + cards render chips (escaped, `encodeURIComponent` hrefs, no `set:html`); `/tag/[slug]` and `/tags` each declare exactly one cache helper (`["tag:<slug>"]` / `["listing"]`), set CSP, anonymous `apiFetch` without `request`, fail-closed 503; nav has the `/tags` link; `page-cache-inventory` passes.
- **e2e**: publish a post with a distinctive tag → the post appears on `/tag/<that-slug>`, its chip renders on the full post page (and on its Discover card), and the tag shows on `/tags`. Assertions scoped to `main`; distinctive tag slug to stay unambiguous in the shared DB.

## Files

**Create:** `apps/api/migrations/0010_tags.sql`; `handlePublicTag` + `handlePublicTags` in `apps/api/src/routes/public.ts`; `apps/web/src/pages/tag/[slug].astro`; `apps/web/src/pages/tags.astro`; api tests (`tags.db.test.ts`, `tag.test.ts`, `tags-index.test.ts`); `e2e/tags.spec.ts`.
**Modify:** `packages/shared/src/posts.ts` (add `TagRef`/`TagPage`/`TagCount`; `tags` on `PublicPost`/`PublicPostSummary`/`RecentPost`; `tags` array on `Create/UpdatePostInput`) and `packages/shared/src/social.ts` (`tags` on `FeedPost`); `apps/api/src/routes/posts.ts` (thread tags through create/edit + old∪new purge) and `apps/api/src/routes.ts` (register the two routes); `apps/api/src/routes/public.ts` (add `tags` to the post/listing SELECTs); `apps/web/src/pages/new-post.astro` (tag input); `apps/web/src/pages/[handle]/[slug].astro` + `index.astro` + `[handle]/index.astro` + `feed.astro` (chips); `apps/web/src/components/Nav.astro` (Tags link); the affected purge-wiring / page-cache / nav / DTO tests.

## Out of scope / deferred

- **Tag curation** (featured/hidden/merge/rename), **admin tooling**, orphan-tag cleanup.
- **Chip/autocomplete editor widget** (no-JS comma input now).
- **Tag-filtered Discover** (redundant with `/tag/<slug>`).
- **Tag following / per-tag feeds in the notification system.**
- **Renaming a tag's label** after creation (first writer's label wins; revisit if it matters).

## Global constraints

- TypeScript 6.0.3; Postgres 18 (uuidv7). pnpm monorepo (`apps/{api,web}`, `packages/{shared,markdown}`); `web` reaches `api` only over the Service Binding via `apiFetch`.
- Exactly one cache helper per web page (`page-cache-inventory.test.ts`); nothing under `src/` except `lib/cache.ts` sets cache headers.
- The `tag:<slug>` cache-tag string must byte-match the api purge call site; the single batched `purgeTags` request per write is preserved.
- New public read routes use `HYPERDRIVE_FRESH`; `handlePublicRecent` stays the sole `HYPERDRIVE_CACHED` route.
- Never `set:html`; escaped text for tag labels/excerpts; `encodeURIComponent` on interpolated URL segments; anonymous pages `apiFetch` without `request`.
- `slug` columns are `citext`; reuse `slugify` (server-side) to derive tag slugs from author labels; the URL `<slug>` is matched case-insensitively against `tags.slug` (a non-matching slug yields an empty tag page, not a 404).
- Commit messages end with the `Co-Authored-By` + `Claude-Session` trailers; PR body ends with the Claude Code footer + session URL.
- **Deploy note:** migration 0010 must run on Neon (additive; no extension, secret, binding, or cron). Adds to the still-pending 0006–0009.

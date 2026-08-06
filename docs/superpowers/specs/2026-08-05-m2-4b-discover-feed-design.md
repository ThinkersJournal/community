# M2.4b — Discover feed (design)

**Milestone:** M2.4b, the second of M2.4 Discovery's three sub-milestones (**Search → Discover → Tags**). M2.4a Search merged via PR #11 (`a5fbf12`).

**Goal:** Turn the community front page (`/`) into a public, anonymous, edge-cacheable **Discover feed** — the newest published posts site-wide — so anyone (logged-out visitors and members) sees live community content on entry. This is distinct from the M2.1 personalized home feed (`/feed`, follow-graph based, per-viewer, never cached).

## Product framing

ThinkersJournal.com is the top-level landing page and jump-off point to Thinker's Journal's web offerings; it owns the marketing hero and the signup CTA. `community.thinkersjournal.com` (`/` from this project's point of view) is **not** the first page most users land on — it is the first page they see when they enter the community. Its main page should therefore be the Discover feed itself, **not** a second marketing landing. The existing marketing content in `index.astro` is removed; signup remains reachable through the nav auth slot. The marketing/signup funnel is owned by ThinkersJournal.com and is out of scope here.

## Decision log (what was chosen and why)

- **Ordering = recency (newest first).** Site-wide latest published posts, keyset-paginated by `id DESC` (uuidv7 = time-ordered). Cache-coherent with the reserved `listing` purge tag (which fires on publish/edit), keyset-ready, YAGNI. Trending/popularity ranking is deliberately deferred (it needs engagement-count aggregation + time-decay + a re-scoring model that fights the publish-driven purge cache) and can be added later without reworking this.
- **`/` (community home) *is* the Discover feed.** Full, paginated, anonymous, edge-cached. No dedicated `/discover` route — `/` is the sole surface (one canonical URL, no duplicate content).
- **Anonymous + viewer-independent.** Because it is edge-cached, it cannot be personalized; the SSR is anonymous and the nav auth slot hydrates client-side (same pattern the home page and Authors already use). Logged-in users see the same cached content with the nav upgraded. No redirects. Personalized content stays at `/feed`.
- **New FRESH keyset API route.** `GET /public/discover` on `HYPERDRIVE_FRESH`. `GET /public/recent` (the sitemap/RSS listing) is left untouched — it is `HYPERDRIVE_CACHED` + untagged *on purpose*, and its own header warns that placing a purge-tagged edge entry in front of a cached Hyperdrive read reopens a ~25h stale-read window. Discover reads FRESH.
- **Cache via the reserved `listing` tag.** `markPublicCacheable(Astro, ["listing"])`. Publish (`POST /posts`) and edit (`PATCH /posts/:id`) already purge `listing` (`apps/api/src/routes/posts.ts:252,336`) through the existing cross-Worker purge hop, so a new/edited post evicts the home feed immediately. **Zero new cache infra.** This finally makes `listing` a live subscriber.
- **Nav.** Add **"Discover" → `/"`**; keep **"Feed" → `/feed`** and **"Authors" → `/authors`**. Empty `/feed` state gains a secondary "…or browse Discover →" → `/`.

## Architecture

Three layers, each cloning an existing, proven pattern:

### 1. API — `GET /public/discover`

**File:** `apps/api/src/routes/public.ts` (new handler `handlePublicDiscover` beside `handlePublicRecent`), registered in `apps/api/src/routes.ts` next to `/public/recent`.

- **Binding:** `HYPERDRIVE_FRESH` (never the cached binding — see decision log). The `hyperdrive-binding-inventory.node.test.ts` already enforces that `/public/recent` is the *only* `HYPERDRIVE_CACHED` route; a FRESH Discover handler satisfies that invariant automatically.
- **Query** (FROM/JOIN/WHERE mirrors `handlePublicRecent`; keyset mirrors `handlePublicProfile`):
  ```sql
  SELECT p.id, p.title, p.slug,
         left(p.markdown_source, 400) AS "excerptSource",
         p.published_at AS "publishedAt",
         p.updated_at   AS "updatedAt",
         pr.username
    FROM posts p
    JOIN profiles pr ON pr.user_id = p.author_id
   WHERE p.status = 'published'
     AND p.id < $1
   ORDER BY p.id DESC
   LIMIT $2
  ```
  `$1` = cursor (`MAX_CURSOR` sentinel `"ffffffff-…-ffffffffffff"` for page 1), `$2` = `PAGE_SIZE + 1` (the +1 sentinel row that determines `nextCursor`). Served by the existing `posts_author_published_key` / partial published index (drafts excluded at the DB level, migration 0002).
- **Validation:** `cursor` query param — if absent, use `MAX_CURSOR`; if present, must be a valid UUID (else `400 INVALID_INPUT { fields: ["cursor"] }`). No other params.
- **Response:** `200 { posts: RecentPost[], nextCursor: string | null }`, `cache-control: no-store` on the API response (the *page* is edge-cached, not this hop). `nextCursor` = the id of the last returned row when a sentinel row was present, else `null`.
- **DTO:** reuse `RecentPost` (`packages/shared/src/posts.ts:86-89`: `id, title, slug, excerptSource, publishedAt, updatedAt, username`) — it is exactly this row shape. Add a new shared page type `DiscoverPage = { posts: RecentPost[]; nextCursor: string | null }` to `packages/shared/src/posts.ts` and re-export it from the barrel.
- **Constant:** `PAGE_SIZE = 20` in the handler (matching `feed.ts` and `handlePublicProfile`). `EXCERPT_SOURCE_CHARS = 400` reused.

### 2. Web page — `/` (`apps/web/src/pages/index.astro`, rewritten)

- **Cache:** exactly one helper — `markPublicCacheable(Astro, ["listing"])` (was `[]`). 1h fresh / 24h SWR, purge-invalidated. `setPublicPageCsp(Astro)`.
- **Anonymous fetch:** `apiFetch<DiscoverPage>("/public/discover" + cursorQuery)` **without** `request:` (omitting the Cookie is what keeps the render anonymous/leak-safe). Cursor forwarded opaquely from `Astro.url.searchParams.get("cursor")`.
- **Header:** `PageLayout` with eyebrow "Community", heading "Discover", a one-line intro (e.g., "The latest from the community."), `canonical="https://community.thinkersjournal.com/"`. On a cursor page (`?cursor=…`), `canonical` still points to `/` (bare) to avoid duplicate-content indexing of paginated views.
- **Cards:** clone `feed.astro`'s card markup — `<li class="card"><h2><a href={/@${encodeURIComponent(username)}/${encodeURIComponent(slug)}}>{title}</a></h2><p class="meta">by <a href={/@${encodeURIComponent(username)}}>@{username}</a> · <time datetime={publishedAt}>{publishedAt.slice(0,10)}</time></p><p>{markdownExcerpt(excerptSource)}</p></li>`. Excerpts render as Astro-escaped text via `markdownExcerpt()` (never `set:html`; not the raw `.slice()` the legacy feed card used — this is the safer, Search-page-consistent choice).
- **Empty state:** if there are no published posts at all, a friendly "No posts yet." message.
- **Pagination:** keyset "Older posts →" → `/?cursor=${nextCursor}` when `nextCursor !== null`; a "← Newer" / "Home" link back to `/` when on a cursor page (mirrors `feed.astro`/`authors.astro`). No offset, no total count.

### 3. Nav + cross-links

- **`apps/web/src/components/Nav.astro`:** add `<a href="/">Discover</a>` at the front of the browse links in `<nav class="links">`, before "Feed" and "Authors". Stays pure-static (no `apiFetch`/`Astro.request`) so the nav remains viewer-independent/cacheable.
- **`apps/web/src/pages/feed.astro`:** the empty-feed state adds a secondary "…or browse Discover →" → `/` alongside the existing "Discover authors to follow →" → `/authors`.
- **`Footer.astro` / other cross-links:** the existing "Discover authors → /authors" links (people to follow) are left as-is — they are a distinct action from browsing posts.

## Data flow

```
Author publishes/edits a post
  → POST /posts | PATCH /posts/:id  (apps/api/src/routes/posts.ts)
  → purgeTags(env, [... , "listing"])           (already wired, awaited)
  → env.WEB.fetch(/internal/purge, {tags:["listing"]})
  → web cache.invalidate({ tags:["listing"] })  → the `/` edge entry(ies) evicted

Visitor opens / (or /?cursor=…)
  → index.astro SSR (anonymous, no Cookie)
  → apiFetch("/public/discover?cursor=…")  → HYPERDRIVE_FRESH keyset query
  → renders cards + keyset pager
  → markPublicCacheable(["listing"]) stamps the edge entry with the listing tag
  → nav auth slot hydrates client-side (viewer-specific UI, cache-safe)
```

## Load-bearing invariants

- **The page's cache tag string must byte-match the api's purge call-site literal** — both are `"listing"`. If they diverge, purge silently misses (miniflare doesn't simulate Workers Cache, so only the wiring test catches it). Pinned by the purge-wiring and page-cache tests.
- **`/public/discover` must read `HYPERDRIVE_FRESH`**, never `HYPERDRIVE_CACHED` — a cached read behind a purge-tagged edge entry reopens the stale-read hazard. Guarded by the hyperdrive-binding-inventory test.
- **Anonymous render only** — `apiFetch` without `request:`; the page must not read the session or mint a cookie, or `markPublicCacheable` refuses and the feed goes uncached (and per-viewer). Guarded by the page-cache-inventory `isViewerSpecific` check.
- **Keyset, not offset** — `id < $cursor ORDER BY id DESC LIMIT PAGE_SIZE+1`; `nextCursor` from the sentinel row. No total count, no offset cap.

## Error handling

- Invalid `cursor` (non-UUID) → `400 INVALID_INPUT { fields: ["cursor"] }` from the API; the page treats any non-200 as an empty page (renders "No posts yet." rather than erroring), consistent with the other public list pages.
- Empty result set (no published posts, or a cursor past the end) → empty list, no pager, friendly message.

## Testing strategy

- **API (`apps/api/test/`):** `handlePublicDiscover` returns published posts newest-first; excludes drafts; a seed of > `PAGE_SIZE` matching posts yields a full first page + a non-null `nextCursor`, and the second page (`?cursor=`) returns the remainder with `nextCursor: null` and **no overlap**; invalid cursor → 400; route-protection (anonymous GET) + error-envelope coverage. The hyperdrive-binding-inventory test continues to pass (Discover is FRESH).
- **Web (`apps/web/test/`):** `/` (index) static assertions — exactly one cache helper and it is `markPublicCacheable(` with `"listing"`; `setPublicPageCsp`; no `set:html`; `markdownExcerpt` used; `encodeURIComponent` on interpolated URL segments; anonymous `apiFetch` (no `request:`); cursor-page `canonical` → `/`. Nav test — the "Discover" link exists and the nav stays viewer-independent (no `apiFetch`/`Astro.request`). Update the existing home-page assertions that pinned the old marketing content, and the `page-cache-inventory` sweep. Update `home-feed-page.test.ts` / `social.spec` empty-state expectations if they assert homepage marketing copy.
- **e2e (`e2e/`):** publish a post → it appears at the top of `/`; the keyset "Older posts →" link advances to a second page whose posts differ from page 1. Assertions scoped to the results container (avoid the nav-auth-slot handle-collision class of bug from M2.4a). Reset/seed a distinctive title so the top-of-feed assertion is unambiguous under the shared, accumulating test DB.

## Files

**Create:**
- `handlePublicDiscover` in `apps/api/src/routes/public.ts` (beside `handlePublicRecent`).
- `apps/api/test/discover.test.ts` — the API handler tests.
- `e2e/discover.spec.ts` — the e2e spine.
- (Home-page web tests extend the existing home-page/nav test files rather than a new file — see below.)

**Modify:**
- `apps/api/src/routes/public.ts` (handler), `apps/api/src/routes.ts` (register `/public/discover`).
- `packages/shared/src/posts.ts` (add the `DiscoverPage` page-shape type; reuse `RecentPost`).
- `apps/web/src/pages/index.astro` (rewrite: marketing → Discover feed).
- `apps/web/src/components/Nav.astro` (add "Discover" link).
- `apps/web/src/pages/feed.astro` (empty-state secondary Discover link).
- Existing home-page / nav tests, and the `social.spec` / `home-feed` empty-state assertions, updated to the new content.

## Out of scope / deferred

- **Trending / popularity ranking** (engagement-weighted, time-decayed) — a separate future feature; recency now.
- **Personalization** — impossible on an anonymous edge-cached page by design; `/feed` owns that.
- **Tag-based browsing** — M2.4c.
- **Marketing hero / signup CTA on `/`** — owned by ThinkersJournal.com (parent site).
- **Home-preview-then-full-feed split** — obsolete now that `/` *is* the full feed.

## Global constraints

- TypeScript pinned **6.0.3**; Postgres **18** (uuidv7). pnpm monorepo (`apps/{api,web}`, `packages/{shared,markdown}`).
- Two-Worker topology; `web` reaches `api` only over the Service Binding via `apiFetch`.
- Exactly **one** cache helper per web page (`page-cache-inventory.test.ts`); nothing under `src/` except `lib/cache.ts` may call `cache.set(` or hand-set cache headers.
- The `listing` tag string on the page must match the api purge call-site (`apps/api/src/routes/posts.ts`) byte-for-byte.
- Never `set:html`; excerpts are escaped text. Every interpolated URL segment is `encodeURIComponent`-wrapped.
- Anonymous pages call `apiFetch` **without** `request:`.
- Commit messages end with the `Co-Authored-By` + `Claude-Session` trailers; PR body ends with the Claude Code footer + session URL.

# M2.4a — Search: Design

**Status:** Approved (brainstorm complete 2026-08-01)
**Milestone:** M2.4a — the FIRST of M2.4 Discovery's three sub-milestones. Order: **Search (this) → Discover feed → Tags.** Each ships as its own spec → plan → subagent build → CI-gated PR.
**Branch:** `m2-4a-search` off `main`

## Goal

Let anyone find posts and people across the whole platform — beyond their follow graph — with a forgiving, typo-tolerant search. Greenfield: there is no search of any kind today.

## Architecture (one sentence)

A single anonymous `GET /public/search` endpoint runs Postgres **pg_trgm** (trigram) fuzzy matching over posts (title + body) and profiles (username + display name + bio), GIN-indexed, ranked by `word_similarity`, offset-paginated; a server-rendered `/search` page (Posts | People tabs) and a nav search box are its front end, short-TTL edge-cached.

---

## Decision log (from the brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Milestone decomposition | M2.4 Discovery = three sub-milestones, built in order **Search → Discover → Tags**; this spec is **Search** only |
| 2 | Matching model | **pg_trgm trigram** fuzzy match for BOTH posts and people (typo-tolerant, partial) — not FTS, not tags |
| 3 | Ranking / operator | `word_similarity` (query vs best-matching region of the text), not plain `similarity` (length-skewed) |
| 4 | Presentation | **Tabbed** — Posts / People, user picks scope; each its own list |
| 5 | Pagination | **Offset-based** (similarity rank isn't keyset-friendly), with a `hasMore` sentinel (no total count) |
| 6 | Access | **Anonymous / public** (a `/public/*` read), like the rest of the platform's content reads |
| 7 | Caching | **Short-TTL untagged edge cache** on the `/search` page (`markFeedCacheable`, 60s/600s), keyed on the querystring |
| 8 | Nav entry | A **nav search box** ships in M2.4a (submits `GET /search?q=`) |
| 9 | Abuse | min/max query length + offset cap + result cap + Cloudflare DDoS; app-level IP rate limiting stays a **documented deferral** |

---

## What already exists (reused, not rebuilt)

- **Posts** (`migrations/0002`): `id, author_id, title, slug, markdown_source, status, published_at, updated_at, created_at`. Excerpt = `left(markdown_source, 400)`. Published-only listings filter `status = 'published'`. No `body` column; `markdown_source` is the text.
- **Profiles** (`migrations/0001`,`0003`): `user_id, username (citext), display_name, bio, created_at, username_chosen`. `bio` is the only free-text "about"; onboarded users have `username_chosen = true`.
- **Postgres 18**, extensions: only `citext` enabled today. `pg_trgm` ships in the `postgres:18` image and is Neon-allowed — a one-line `CREATE EXTENSION` enables it.
- **Anonymous public-read pattern** (`src/routes/public.ts`): viewer-independent reads the web Worker calls WITHOUT forwarding the cookie; `apiFetch("/public/...")` with **no `request`** is the structural anti-leak defense.
- **Keyset/listing conventions** (`packages/shared/src/posts.ts` `MAX_CURSOR`; `handlePublicProfile`/`handlePublicAuthors`): `LIMIT PAGE_SIZE+1` sentinel → `hasMore`, malformed cursor → `400 INVALID_INPUT`. **Search uses OFFSET, not keyset** (rank order), but keeps the `+1` `hasMore` trick.
- **Edge cache helpers** (`apps/web/src/lib/cache.ts`): `markFeedCacheable` (60s/600s, untagged — used by `/authors`, sitemap, rss) is the class the `/search` page joins; `markPrivate` for per-viewer; `markPublicCacheable(tags)` for purge-tagged. Exactly one cacheability helper per page (enforced by `test/page-cache-inventory.test.ts`).
- **`GET /public/authors`** + `apps/web/src/pages/authors.astro` (eyebrow "Discover") — the closest existing anonymous listing page; the SSR pattern `/search` follows.
- **Nav** (`apps/web/src/components/Nav.astro`) — the shared chrome the search box lands in; cache-safe (anonymous SSR default) with a client-hydrated auth slot.

---

## Section 1 — Data model & indexes (migration 0009)

No new tables. `migrations/0009_search_trgm.sql`:

```sql
-- Up Migration

-- Trigram fuzzy search (M2.4a). pg_trgm ships in the postgres:18 image and is
-- Neon-allowed; it powers typo-tolerant / partial matching over posts and people.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Posts: a PARTIAL expression GIN index over the lowercased title+body, restricted
-- to published posts (search never returns drafts). lower(...) because trigram is
-- case-sensitive; the expression (not a stored column) avoids duplicating the body.
CREATE INDEX posts_search_trgm_idx ON posts
  USING gin (lower(title || ' ' || coalesce(markdown_source, '')) gin_trgm_ops)
  WHERE status = 'published';

-- People: expression GIN index over lowercased username+display_name+bio, restricted
-- to onboarded users (username_chosen = true). username is citext → cast to text.
CREATE INDEX profiles_search_trgm_idx ON profiles
  USING gin (lower(coalesce(username::text, '') || ' ' || coalesce(display_name, '') || ' ' || coalesce(bio, '')) gin_trgm_ops)
  WHERE username_chosen = true;

-- Down Migration
DROP INDEX IF EXISTS profiles_search_trgm_idx;
DROP INDEX IF EXISTS posts_search_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;
```

> The index predicate/expression MUST match the query's `WHERE`/rank expression byte-for-byte, or Postgres won't use the index. A db-test proves the index is actually used (and, more importantly, that a partial/typo query finds a seeded row).

## Section 2 — Matching & ranking

`word_similarity(q, text)` = the greatest trigram similarity between `q` and any continuous region of `text` — the right measure for a short query against both short names and long bodies (plain `similarity` is skewed by document length). The GIN-accelerated **operator** form drives the filter; the **function** form drives the rank:

- **Filter (index-driven):** the word-similarity operator between the (lowercased) query and the (lowercased) indexed expression, true when the word-similarity exceeds `pg_trgm.word_similarity_threshold`.
- **Threshold:** the strict 0.6 default kills recall; run each search inside a transaction that first `SET LOCAL pg_trgm.word_similarity_threshold = 0.3`.
- **Rank:** `ORDER BY word_similarity(lower($q), <expr>) DESC, <id> DESC` — the `id DESC` tiebreak makes the OFFSET order stable across pages.

Posts query shape (people mirrors it over the profile expression):

```sql
-- inside a tx after: SET LOCAL pg_trgm.word_similarity_threshold = 0.3;
SELECT p.id, p.title, p.slug,
       left(p.markdown_source, 400) AS "excerptSource",
       p.published_at AS "publishedAt",
       pr.username, pr.display_name AS "displayName"
  FROM posts p
  JOIN profiles pr ON pr.user_id = p.author_id
 WHERE p.status = 'published'
   AND lower($1) <% lower(p.title || ' ' || coalesce(p.markdown_source, ''))
 ORDER BY word_similarity(lower($1), lower(p.title || ' ' || coalesce(p.markdown_source, ''))) DESC,
          p.id DESC
 LIMIT $2 OFFSET $3;   -- $2 = PAGE_SIZE + 1
```

> **Operator direction is verified by test, not assumed.** `<%` vs `%>` (which operand is the query vs the indexed text) must make the *indexed expression* the right operand so the GIN index is used AND the semantics are "query matches a region of the text". The Task-3 db-test seeds a post and asserts a partial+typo query returns it (and `EXPLAIN` shows a bitmap index scan, not a seq scan) — if the direction is wrong, that test fails. The implementer confirms against the pg_trgm docs and the failing test.

Using the similarity operator (not `ILIKE '%'||$q||'%'`) means `%`/`_` in the query are literal trigram input — **no LIKE-metacharacter escaping needed**, and `$q` is always a bind parameter (never interpolated).

## Section 3 — API endpoint (anonymous)

**`GET /public/search?q=<query>&type=posts|people&offset=<n>`** — a `/public/*` route, **no session read** (registered in the anonymous block of `src/routes.ts`; it reads `HYPERDRIVE_FRESH`, carries no cache-tag). Handler `handlePublicSearch` in a new `src/routes/search.ts`.

Validation (→ `400 INVALID_INPUT { fields: [...] }` via `errorResponse`):
- `q` — trimmed; **length 2–100** after trim (shorter than 2 is meaningless for trigram; 100 bounds cost). Empty/short → 400.
- `type` — `posts` (default when absent) or `people`; anything else → 400.
- `offset` — integer `≥ 0`, **capped at `SEARCH_MAX_OFFSET` (200)**; a direct request above the cap → `400` (a clear contract, not a silent clamp — this is the deep-scan abuse guard).

Response: `{ results: SearchPostResult[] | SearchPersonResult[], nextOffset: number | null }`. `hasMore` comes from the `LIMIT PAGE_SIZE+1` sentinel (**no total count**); `nextOffset = (hasMore && offset + PAGE_SIZE <= SEARCH_MAX_OFFSET) ? offset + PAGE_SIZE : null` — so the pager stops offering "Next" *before* the cap and a normal user never clicks into the 400. `PAGE_SIZE = SEARCH_PAGE_SIZE = 20`. `cache-control: no-store` on the api response itself (the edge caching is the web page's job, §5).

Result shapes:
- **post:** `{ id, title, slug, excerptSource, publishedAt, authorUsername, authorDisplayName }` (author handle needed to build the `/@author/slug` link).
- **person:** `{ username, displayName, bio }`.

## Section 4 — Shared types

`packages/shared/src/search.ts` (pure types + the small param helper; keep zod isolated per the bundle rule if the param parse uses it):

```ts
export const SEARCH_TYPES = ["posts", "people"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export interface SearchPostResult { id: string; title: string; slug: string; excerptSource: string; publishedAt: string; authorUsername: string; authorDisplayName: string | null; }
export interface SearchPersonResult { username: string; displayName: string | null; bio: string | null; }
export interface SearchPage<T> { results: T[]; nextOffset: number | null; }
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 100;
export const SEARCH_MAX_OFFSET = 200;
```

## Section 5 — Web surface

- **`apps/web/src/pages/search.astro`** — anonymous, `markFeedCacheable(Astro)` (60s/600s untagged edge cache; the `?q=&type=&offset=` querystring is part of the cache key), `setPublicPageCsp(Astro)`. Reads `q`/`type`/`offset` from `Astro.url.searchParams`; calls `apiFetch<SearchPage<...>>("/public/search?...")` **with no `request`** (anonymous, no cookie). Renders:
  - a `<form method="GET" action="/search">` with `name="q"` (and the current `type` preserved via a hidden input) — no JS;
  - **Posts | People tabs** as plain links that set `?type=` (preserving `q`, resetting `offset`);
  - the ranked result list — posts reuse the existing post-card/excerpt markup; people reuse the author-card markup (extract a shared partial if the profile/authors pages have inline markup worth sharing — otherwise a local list is fine);
  - a prev/next pager: "Next" links to `offset = nextOffset` when non-null; "Prev" to `max(0, offset - PAGE_SIZE)` when `offset > 0`.
  - Empty state: "No {posts|people} match «q»."
  - Guard: a missing/too-short `q` renders the empty search box (no api call), not an error page.
- **Nav search box** (`apps/web/src/components/Nav.astro`) — a small `<form method="GET" action="/search">` with a `name="q"` text input, present on every page. No JS; submitting navigates to `/search?q=...`. Must preserve the nav's cache-safety (anonymous SSR default — the form is static markup, viewer-independent) and pass `setPublicPageCsp`'s policy (no inline script). Update the nav's tests (cache-safety / structure) accordingly.

## Section 6 — Security & correctness invariants

1. **Anonymous + viewer-independent.** `/public/search` reads no session; the web page calls `apiFetch` with no `request` (cookie never forwarded) — the same structural anti-leak defense as every `/public/*` read, so edge-caching cannot serve one viewer's data to another (there is none).
2. **No draft / un-onboarded leakage.** Posts filtered `status = 'published'`; people filtered `username_chosen = true` (both enforced in the query AND the partial index predicate).
3. **Parameterized, no metacharacter injection.** `$q` is always a bind parameter; the similarity operator (not `ILIKE`) makes `%`/`_` literal — no escaping, no injection.
4. **Bounded cost.** min/max `q` length + `offset` cap + `LIMIT PAGE_SIZE+1` + the GIN index keep every query bounded. Cloudflare fronts crude DoS. App-level IP rate limiting is a documented deferral (there is no IP-keyed limiter in the codebase yet).
5. **HTML safety.** The web page renders user-derived text (titles, names, bios, excerpts) through Astro's default escaping / `textContent`, same as the existing listing pages — never raw markup.

## Section 7 — Testing

- **db.test (`*.db.test.ts`, Node/pg):** `pg_trgm` enabled; both trigram indexes exist; a seeded published post is found by a **partial** and by a **typo** query; a **draft** is NOT found; `word_similarity` ranking orders a closer match first; a seeded onboarded profile is found by partial name, an **un-onboarded** one is not; offset returns the next slice + `hasMore`. Include an `EXPLAIN` assertion that the filter uses the GIN index (bitmap index scan), guarding the index-expression/query-expression match.
- **cloudflare:test:** `GET /public/search` returns ranked results with **no session/cookie**; `type=people` switches corpora; `q` too short/too long → 400; `type=bogus` → 400; `offset` over cap → 400; `nextOffset` present when `hasMore`, null on the last page; response is `no-store`.
- **web:** `search.astro` source-assertion (anonymous `apiFetch` with no `request`, `markFeedCacheable`, `<form ... action="/search">`, Posts/People tab links, pager, empty-state, no-api-call on missing `q`); nav-search-box assertion in the Nav test; the page-cache-inventory test recognizes `/search` as `markFeedCacheable`.
- **e2e:** publish a post with a distinctive title, then `/search?q=<partial+typo>` shows it; switch to People and find a user by partial handle; the pager advances when there are >20 matches (seed enough, or assert the pager renders/links correctly with a smaller set).

Expected dev-harness noise unchanged. The e2e runs against the real `wrangler dev` + Postgres (pg_trgm must be enabled in the dev DB — migration 0009 handles it via global-setup).

## Section 8 — New infra / config (deploy-time)

| Item | Where | Note |
|------|-------|------|
| `CREATE EXTENSION pg_trgm` + 2 GIN indexes | migration 0009 | pg_trgm is in the `postgres:18` image and Neon-allowed; applied by the normal migration step. **Confirm pg_trgm is enabled on the Neon prod DB at deploy** (it's an allowed extension; `CREATE EXTENSION` in the migration handles it). |

No new binding, KV, DO, cron, or secret. Search reuses `HYPERDRIVE_FRESH`.

## Section 9 — Build order (for writing-plans)

1. **Migration 0009** — `pg_trgm` + the two partial expression GIN indexes + schema/behavior db-test (extension present, indexes exist, partial+typo match, draft/un-onboarded excluded, index-used via EXPLAIN).
2. **Shared types** — `search.ts` (`SearchType`, result/page interfaces, the size/limit constants).
3. **API `GET /public/search`** — `handlePublicSearch` (validation, the two trigram queries inside a `SET LOCAL` tx, offset + `hasMore`), register in the anonymous block of `routes.ts`, tests (incl. route-protection: it's a GET public read; error-envelope: 400s go through `errorResponse`).
4. **`/search` page** — `search.astro` (tabs, results, pager, empty state, `markFeedCacheable`) + any shared card partial + tests.
5. **Nav search box** — the `<form>` in `Nav.astro` + nav test + page-cache-inventory recognition.
6. **e2e spine** — partial/typo post search, People-tab person search, pager.

Whole-branch adversarial review (Ultracode) at the end; CI-gated PR → merge (founder merges).

## Section 10 — Deferred / future (documented)

- App-level **IP rate limiting** for `/public/*` (no IP-keyed limiter exists yet; Cloudflare fronts DoS meanwhile).
- **Search-by-tag** and tag facets — fold in at **M2.4c Tags**.
- Result **snippets / highlighting** (trigram highlighting is harder than FTS `ts_headline`).
- **Autocomplete / suggestions** (typeahead).
- **Total-count** pagination ("page X of Y") — using `hasMore` instead.
- **Ranking blends** (recency, popularity/reactions) beyond pure `word_similarity` + `id` tiebreak.
- **Unaccent** / diacritic folding (would need the `unaccent` extension).

## Section 11 — Out of scope (this sub-milestone)

The Discover feed (M2.4b) and Tags (M2.4c); FTS (`tsvector`) — the trigram decision stands for the whole search feature; personalized/authed search; searching comments; saved searches.

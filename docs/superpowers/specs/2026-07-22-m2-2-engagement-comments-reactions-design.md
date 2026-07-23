# M2.2 — Engagement: comments + reactions (design)

**Date:** 2026-07-22
**Status:** approved design; feeds into an implementation plan (`docs/superpowers/plans/`).
**Milestone context:** second sub-milestone of the M2 decomposition (see the M2.1 spec, `2026-07-19-m2-1-social-graph-and-feed-design.md`):

- **M2.1 — Social graph & home feed** — ✅ merged (PR #2)
- **M2.2 — Engagement**: comments (materialized-path) + reactions ← *this doc*
- **M2.3 — Notifications**: in-app (DO Hibernation WebSocket) + email — will consume the rows this milestone creates
- **M2.4 — Discovery**: search + explore/trending + follow recommender

---

## 1. Goal

Turn posts from broadcast into **conversation**: readers comment in threads on published posts and react with a small "thinker-tone" set, on both posts and comments. These rows are also the event source M2.3 notifications will be built on.

## 2. Scope (what ships in M2.2)

1. **Threaded comments** on published posts — create / edit-own / delete (tombstone), materialized-path tree, depth-capped, keyset-paginated, Markdown bodies through the existing sanitize-first pipeline.
2. **Author moderation, minimal form** — the *post author* may also delete comments on their own post (founder decision; independent of the deferred block/report cluster).
3. **Reactions** — four tones (**Insightful / Curious / Agree / Challenging**), independent per-tone toggles, on posts and comments.
4. **Rendering**: comments SSR **into the cached post page** (purged on every comment write); reaction counts + all per-viewer affordances are client-side islands.

Explicitly **out of scope** (see §9): comment counts on feed/profile cards, block/report/moderation cluster, who-reacted lists, Turnstile on comments, denormalized counters, notifications.

## 3. Locked decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| 1 | Reaction set = **insightful, curious, agree, challenging** (founder-final wording, standing decision #12 resolved) | Distinct tones: quality, engagement, endorsement, productive pushback. Small enough to stay meaningful; additive to extend. |
| 2 | **Multiple tones per user per target** — independent toggles | GitHub-emoji model: tones aren't mutually exclusive. Uniqueness = (user, target, kind). |
| 3 | Comment bodies = **Markdown through the same sanitize-first pipeline** | One HTML producer in the whole platform (`renderMarkdown`, rehype-sanitize load-bearing). Code blocks/links fit the audience. 10k-char cap. |
| 4 | Comments **SSR into the cached post page; every comment write purges `post:<id>`** | Comments are *content*: SEO-indexable, rendered by the proven server pipeline. The M1 purge hop already handles post edits identically; the original architecture doc said "purged on edit/comment". |
| 5 | Reaction counts **island-only, `no-store`, never in cached HTML** | Purge-per-reaction would be a purge storm. Deliberate asymmetry with #4: comments are content, counts are volatile metadata. Mirrors M2.1 `/api/social`. |
| 6 | Delete = **soft-delete tombstone, uniformly** | Children survive under "[deleted]"; no orphan/reparent edge cases. Body content is actually emptied (privacy), row structure stays. |
| 7 | **Post author may delete comments on their post** | One ownership predicate on the DELETE (`comment author OR post author`); authors control their space from day one. |
| 8 | Counts **computed on read** | Indexed `COUNT(*)` is microseconds pre-launch; M2.1 follow-count precedent. Denormalization is a measured-cost roadmap item. |
| 9 | **No Turnstile on comments** | Founder: a logged-in, verified, onboarded, rate-limited session is gate enough; spam is handled by delete/moderation, which is easier than pre-filtering. Revisit only on abuse evidence. |
| 10 | **Depth cap 8** (DB CHECK); UI hides Reply at the cap | Bounded indent UI, bounded path length. Materialized path handles any depth; the cap is a product choice. |

Inherited standing decisions still in force: #11 soft gate (verified email for engagement writes); `username_chosen` required for public-identity writes (M2.1 publish/follow precedent — comments show your handle; reactions feed M2.3 notifications that name you); M1 cache discipline (no per-viewer state in cacheable HTML; Cookie is not in the cache key); comments = materialized-path and reactions = dual-nullable-FK `CHECK` + `UNIQUE NULLS NOT DISTINCT` (architecture research).

## 4. Data model — Postgres migration `0004`

**`comments`**

```sql
comments (
  id             uuid  PRIMARY KEY DEFAULT uuidv7(),      -- time-ordered (keyset, path segments)
  post_id        uuid  NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id      uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      uuid  REFERENCES comments(id) ON DELETE CASCADE,   -- NULL = top-level
  path           text  NOT NULL,                          -- see below
  depth          int   NOT NULL CHECK (depth >= 0 AND depth <= 8),
  body_markdown  text  NOT NULL CHECK (char_length(body_markdown) <= 10000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,                             -- set on PATCH
  deleted_at     timestamptz                              -- tombstone marker
)
CREATE INDEX comments_post_path_idx ON comments (post_id, path);
```

- **`path`** = the comment's ancestor id chain joined by `/`, ending in its own id: top-level `path = id::text`, child `path = parent.path || '/' || id::text`. uuidv7 text segments are **fixed-width and time-ordered**, so `ORDER BY path` yields the full tree in correct thread order (siblings oldest-first) from one index scan — the materialized-path payoff. `depth` = number of ancestors (top-level 0). Both computed server-side on insert, never client-supplied.
- **Tombstone**: `DELETE` sets `deleted_at = now()` **and empties `body_markdown` to `''`** (content genuinely removed). The row, its position, and its children remain. Renders as "[deleted]" with no author attribution. Idempotent (already-tombstoned → no-op success).
- v4/v7 invariant holds: users/profiles stay v4; comments join posts/media on uuidv7 (keyset + path ordering need time-ordered ids).
- ⚠️ **Cascade note for the future**: no account-deletion route exists today. When one is designed, note that `author_id … ON DELETE CASCADE` + the `parent_id` cascade would hard-delete a user's comments *and every reply subtree under them* (other people's words). The deletion design should tombstone the user's comments instead of deleting rows. Recorded here so the cascade isn't mistaken for the account-deletion story.

**`reactions`**

```sql
reactions (
  id          uuid  PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid  REFERENCES posts(id) ON DELETE CASCADE,
  comment_id  uuid  REFERENCES comments(id) ON DELETE CASCADE,
  kind        text  NOT NULL CHECK (kind IN ('insightful','curious','agree','challenging')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((post_id IS NULL) <> (comment_id IS NULL)),      -- exactly one target
  UNIQUE NULLS NOT DISTINCT (user_id, post_id, comment_id, kind)
)
CREATE INDEX reactions_post_idx    ON reactions (post_id);
CREATE INDEX reactions_comment_idx ON reactions (comment_id);
```

- The `UNIQUE NULLS NOT DISTINCT` is the idempotency anchor (`INSERT … ON CONFLICT DO NOTHING`), one row per (user, target, tone). Surrogate uuidv7 `id` mirrors the follows-table deviation (future keyset lists; PG PKs can't span nullable columns).
- `kind` is `text` + CHECK, not an enum type — adding a tone later is an additive CHECK swap, no type migration.

## 5. API surface (`apps/api`)

All writes run the full mutating pipeline (origin → session → CSRF → epoch → **verified-email**) + **`username_chosen`** gate, in the M2.1 gate order (pipeline → rate-limit → username → domain checks → write). Two new rate-limiter bindings: `COMMENT_LIMITER` (10/60s), `REACTION_LIMITER` (60/60s) — wrangler.jsonc + regenerated types, per the standing bindings rule.

| Route | Auth | Notes |
|-------|------|-------|
| `POST /comments` `{postId, parentId?, markdownSource}` | full gate + COMMENT_LIMITER | Post must be `published` (else **404**, draft indistinguishable — same parity as reads). `parentId` must exist **and belong to the same post** (else `COMMENT_NOT_FOUND` 404), not be tombstoned (else `COMMENT_DELETED` 409), and have `depth < 8` (else `COMMENT_DEPTH_EXCEEDED` 409). Computes `path`/`depth` server-side. Purges `post:<id>`. |
| `PATCH /comments/:id` `{markdownSource}` | full gate | Own, non-tombstoned only — atomic `UPDATE … WHERE id AND author_id = viewer AND deleted_at IS NULL`; 404 otherwise (no existence/ownership leak). Sets `edited_at`. Purges `post:<id>`. |
| `DELETE /comments/:id` | full gate | **Comment author OR post author** (decision 7) — atomic UPDATE joining posts for the ownership predicate; 404 if neither. Tombstones (empties body). Idempotent. Purges `post:<id>`. |
| `POST /reactions` `{postId?\|commentId?, kind}` | full gate + REACTION_LIMITER | Exactly one target. Target must be a published post / a non-tombstoned comment on a published post (404 / 409 as above). `ON CONFLICT DO NOTHING` — idempotent on. **No purge** (decision 5). |
| `DELETE /reactions?postId=\|commentId=&kind=` | full gate + REACTION_LIMITER | Idempotent off. **No target-state validation** — removal just deletes the matching row if any (a user must always be able to retract a reaction, even from a since-tombstoned comment). No purge. |
| `GET /public/comments?postId=&cursor=` | anonymous | Published posts only (404 parity). Path-order keyset, page size 50 (page may cut mid-thread; the cursor continues it). Rows: `{id, parentId, depth, createdAt, editedAt, deleted, bodyMarkdown, author: {username, displayName} \| null when deleted}`. |
| `GET /public/reactions?postId=` | anonymous | Per-kind counts for the post **and every comment on it** in one call: `{post: {kind: n}, comments: {commentId: {kind: n}}}`. |
| `GET /reactions/mine?postId=` | session | The viewer's own toggles for the post + its comments (same shape, values boolean). `no-store`. |

Every new GET gets an explicit `CASES` entry in `error-envelope.test.ts` (standing M2.1 rule). New `ApiErrorCode` members: `COMMENT_NOT_FOUND`, `COMMENT_DELETED`, `COMMENT_DEPTH_EXCEEDED`, `INVALID_REACTION_KIND`.

**Purge rule:** all three comment *writes* purge `post:<postId>` through the existing M1 purge hop (tag-based purge covers every cached variant of the page, including comment-cursor variants). Reaction writes purge nothing.

## 6. Web + rendering (`apps/web`) — the cache discipline continues

- **Post page (`[handle]/[slug].astro`)** keeps its single `markPublicCacheable` + anonymous-by-construction fetches. It SSRs the comments section: anonymous `apiFetch` to `/public/comments` (no `request` forwarded), each body through the same `renderMarkdown`, indented by `depth` (visual indent clamped by CSS), tombstones as "[deleted]" (no author, no reply affordance), "older comments" as a server-rendered cursor link (`?comments=<cursor>` — a distinct cached URL, still covered by the `post:<id>` tag). **No per-viewer state in the SSR HTML** — comment rows carry public data attributes only (`data-comment-id`, `data-author-id`); the page-cache-inventory guard extends to pin all of this.
- **Islands** (bundled `src/scripts/*.ts` imports — `assetsInlineLimit: 0` already forces externalization, CSP-safe):
  - `comments.ts` — reads viewer identity from `/api/me` (**extended additively with `userId`** — it currently returns `{loggedIn, username, usernameChosen, csrfToken}`; nav-auth is unaffected); injects the top-level form, per-comment Reply forms (hidden at depth 8), and Edit/Delete on rows where the viewer is the comment author or the page's post author. Non-onboarded viewers get a "choose your handle" link (`/choose-username?next=<post url>`) instead of a form — the M2.1 editor-gate pattern. On successful write: `location.reload()` (the api purged before responding; the reload is the fresh render). DOM built via `createElement`/`textContent` only — the island never injects HTML.
  - `reactions.ts` — one `GET /api/reactions?postId=` round trip hydrates every toggle chip on the page (post + all comments): counts always, viewer state when logged in. Toggles POST/DELETE through web proxies and update optimistically.
- **Web proxies** (`src/pages/api/`, flat-file M2.1 style, each `markPrivate`, authed hops forward cookie+origin+CSRF + `applyCookies`): `comment.ts` (create), `comment-update.ts`, `comment-delete.ts`, `react.ts`, `unreact.ts`, and `reactions.ts` (GET merge: anonymous counts always + `/reactions/mine` when a cookie is present — the `/api/social` pattern, upstream-error-honest).

## 7. Security & integrity

- Every write: origin allowlist + CSRF + epoch + verified-email + `username_chosen` + per-family rate limiter. Ownership enforced **atomically in the write's WHERE clause** (M2.1 idiom), answering 404 for not-found and not-owned identically.
- **Draft parity**: commenting on / reacting to / listing comments of an unpublished post 404s exactly like reading it — `status = 'published'` lives in each query.
- **XSS**: `renderMarkdown` (sanitize-first) remains the only Markdown→HTML producer, running server-side in the cached render; islands build DOM exclusively via `textContent`. No new `set:html` sinks.
- Depth and length are DB CHECKs (backstop) *and* app validations (friendly errors). `path`/`depth` are never client-supplied.
- CSP, cookie, and cache-header regimes are unchanged; reaction reads are `no-store` end-to-end.

## 8. Testing strategy (TDD, per the SDD methodology)

- **Migration/schema**: depth + length + one-target + kind CHECKs, `UNIQUE NULLS NOT DISTINCT` idempotency, cascade deletes, tombstone column defaults.
- **Comments routes**: create (top-level + nested; path/depth correctness), cross-post parent rejection, tombstone-parent 409, depth-cap 409, gate matrix (anon/unverified/un-onboarded), rate limit, edit-own (edited_at; not-own → 404; tombstoned → 404), delete by comment-author AND by post-author AND rejection of third parties, tombstone idempotency, purge-wiring (all three writes purge `post:<id>`; reactions don't).
- **Reactions routes**: toggle idempotency both directions, all four kinds, invalid kind, exactly-one-target validation, draft/tombstone targets, counts + mine shapes.
- **Public reads**: path-order keyset (page-boundary test across a thread cut, disjoint + complete + ordered — the M2.1 +1-sentinel pattern), draft 404 parity, tombstone row shape (no author, empty body), error-envelope CASES for the three new GETs.
- **Web**: post-page source/structure tests (comments SSR block, tombstone rendering, data-attribute inventory, no new cache helper, no `set:html`, islands imported not inline), proxy tests (markPrivate, forward/anonymous split), cache-inventory sweep extension.
- **E2E**: A publishes → B comments → **anonymous reader sees the comment** (purge → fresh SSR) → B replies nested → B edits → B reacts to post + comment (counts render via island) → B deletes own reply (tombstone visible) → **A deletes B's comment** (author moderation) → un-onboarded user sees choose-handle affordance, not a form.

## 9. Deferred / roadmap

- **Comment counts on feed/profile cards** — **maybe-ever** (founder: "not sure they're ever needed"). Revisit only on demonstrated demand; additive when wanted (query + template, no schema).
- **Interaction-permission primitives (block/report/moderation cluster)** — deferred to its own milestone so it's designed as ONE general model (comments, follows, profiles, future DMs all consume it — see the live-chat backlog doc). **Standing retrofit note (founder-mandated): when these primitives land, come back and wire them into posts, comments, reactions, and follows.**
- **Who-reacted lists** — needs a deliberate privacy decision (public attribution of tones) first; M2.3 notifications give authors reactor identity meanwhile. Schema already supports it.
- **Turnstile on comments** — only on abuse evidence (decision 9).
- **Denormalized comment/reaction counters** — when count-on-read shows measured cost (with follow counts).
- **KV followee-list cache** — unchanged committed roadmap item from M2.1.
- **M2.3 notifications** — consume `comments`/`reactions` rows as the event source (actor, target, `created_at` are all present).

## 10. Open questions

None outstanding — all scope and architecture decisions are resolved above.

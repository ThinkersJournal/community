# An idempotency key on `POST /posts` — design note

**Status:** DESIGN ONLY. No code. Written 2026-10-13 against `origin/main` 7caf172 (0.1.14). Every `file:line` is at
that ref; re-read before building.

**Why:** the CodeRipper lane and this lane agreed (2026-10-12, route A) that a scan result is posted by the user,
from their own browser session, through the normal editor, with Community adding only an idempotency key. The PM
ruled the same ("A = user's own session + idempotency key"). The key stops a double click, a reload-and-resubmit or
a retry creating two posts. It also gives CodeRipper a stable handle for "this result became that post".

**Not in scope:** a service credential, an automated poster, a per-account rate limit, update-in-place semantics
(those exist: `PATCH /posts/:id`, `routes.ts:204`).

## 1. Facts at 7caf172 this design depends on

- `POST /posts` is **not idempotent**: it inserts, and on a slug collision retries with a random suffix
  (`posts.ts:242-260`, `SLUG_ATTEMPTS = 3` at `:58`). A retry after a lost response is a second post.
- The insert is **not in a transaction**: one `INSERT … RETURNING`, then `writeTags`, then `usernameFor`
  (`posts.ts:233-257`). The code says why (`posts.ts:225-232`): the unique index is the check, never a
  SELECT-then-INSERT.
- The slug retry loop retries on **any** unique violation (`isUniqueViolation(err)`, `posts.ts:259`; the handler's own 409 at `:320`), not on
  `posts_author_slug_key` specifically. **A second unique index on `posts` would be silently retried as a slug
  collision**, burn the three attempts and answer `409 SLUG_TAKEN`. The design must discriminate the constraint
  (§3).
- The create response is `201 { id, slug, status, username }` (`posts.ts:335-338`); the editor already treats
  `200` and `201` as success (`new-post.astro:219`, `succeeded = … 201 || … 200`).
- The create path is the editor's own form POST (`new-post.astro:90`) forwarding the session cookie, the browser's
  Origin and `X-CSRF-Token` through `apiFetch`. There is no other creator.
- Publishing purges cache tags only when `status === "published"` (`posts.ts:328-334`); a replay must purge
  nothing.

## 2. Contract

| | |
|---|---|
| Header | `Idempotency-Key: <key>` on `POST /posts` only |
| Key shape | `[A-Za-z0-9_-]{16,64}` (a UUID fits). Anything else: `400 INVALID_INPUT`, `fields: ["Idempotency-Key"]`, before any write |
| Scope | **(author, key)**. The author is the session's user (`posts.ts:308`), never the body, so one user's key can never touch another user's post |
| First use | exactly today's `201 { id, slug, status, username }` |
| Replay, same request | **`200`** with the same body, taken from the stored row: no new row, no tag write, no purge, no notification |
| Replay, different request | **`422 IDEMPOTENCY_KEY_REUSED`**, nothing changes. "Same request" = the same title, markdownSource, status and tag list **as originally submitted** (a stored SHA-256), so a later edit to the post does not make a legitimate replay look different |
| No header | byte-for-byte today's behaviour |
| Lifetime | the key lives and dies with its post. There is no TTL: a replay after the post was deleted creates a new post, which is what a user who deleted it and pressed submit again wants |

`PATCH`, `DELETE`, hide and unhide take no key (they are already idempotent by shape).

## 3. Storage: two columns on `posts`, not a side table

```sql
ALTER TABLE posts
  ADD COLUMN idempotency_key text,
  ADD COLUMN idempotency_request_sha256 bytea,
  ADD CONSTRAINT posts_idempotency_pair_chk CHECK (
    (idempotency_key IS NULL) = (idempotency_request_sha256 IS NULL)),
  ADD CONSTRAINT posts_idempotency_key_shape_chk CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$');
CREATE UNIQUE INDEX posts_author_idempotency_key
  ON posts (author_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
```

**Why on the row:** the key and the post are then created by the **same single statement**, so "one post per key"
is the unique index, atomic with the insert, with no transaction to add and no second write that can half-fail. A
side table would need either a transaction the insert path does not have, or a two-step write with a window in
which a crash leaves a key pointing nowhere. The key is erased with the post for free (no cleanup job, no
`ON DELETE CASCADE` to get wrong). Rejected: a KV entry (not durable, eventually consistent, so a concurrent
double submit can both win) and storing the whole response (it is derivable from the row).

**Replay algorithm** (inside `handleCreatePost`, after the pipeline and validation, `posts.ts:293-310`):

1. `INSERT … (…, idempotency_key, idempotency_request_sha256) VALUES (…) RETURNING id, slug`.
2. On a unique violation, read `err.constraint`:
   - `posts_author_slug_key` → the existing suffix retry, unchanged;
   - `posts_author_idempotency_key` → **do not retry**. `SELECT id, slug, status, idempotency_request_sha256`
     for `(author_id, key)`; compare the hash; equal → `200` with `{ id, slug, status, username }`, different →
     `422 IDEMPOTENCY_KEY_REUSED`;
   - anything else → rethrow, as today.
3. Skip `writeTags` and the purge on the replay path.

**A concurrent double submit** is two inserts racing on one unique index: exactly one commits, the other takes
step 2. No lock, no advisory lock, no retry loop of its own.

**Request hash:** SHA-256 over `title \0 markdownSource \0 status \0 sorted-unique tag slugs`, computed server
side from the already-validated input. It is not a secret and not a MAC; its only job is "did this client send
the same thing".

## 4. Web side

- `new-post.astro` renders the **create** form (not the edit form) with a hidden `idempotencyKey` set to a fresh
  `crypto.randomUUID()` at GET time, and a failed submit re-renders with the **same** value (no row exists yet, so
  reusing it is correct). A successful create redirects away, so the next form is a new GET and a new key.
- The POST forwards it as the `Idempotency-Key` header through `apiFetch` (a new optional `idempotencyKey`
  option, next to `csrfToken`, `api.ts:133-134`). Validation stays the api's.
- **Prefill from CodeRipper** (agreed 2026-10-12): `GET /new-post#cr=<base64url(JSON)>`, read once by a small
  bundled script (`script-src 'self'` already allows it) that sets the title, textarea, tags and
  **replaces the hidden `idempotencyKey` with the CodeRipper result id**, then clears the hash. Values are set
  with `.value`, never `innerHTML`. No JS, no prefill, nothing breaks. The user still presses Publish.
  A key from the fragment must pass the §2 shape check; otherwise the generated key stays.

## 5. Operator steps, and why this needs CireSnave

This adds two nullable columns and an index to `posts`. It is **additive and backwards compatible**: the running
code ignores the new columns, so the migration can and must be applied to **production before the PR merges**
(README "Deploying, Merge rule"; `docs/runbooks/deploy.md`), exactly like 0027.

1. The PR carries the migration (number: the next free one after what is in flight, never lower than what
   production has applied; at this ref 0027 is #161's and 0028 is reserved for the media-ownership work).
2. **CireSnave applies it** with the runbook's migrate command, as he does for every migration. Nothing in a lane
   may touch production.
3. The deploy gate then lets the merge through; the new code starts accepting the header immediately. Until it
   merges nothing changes, and the editor sends no key.
4. Rollback is dropping the code path; the columns are harmless. They can stay.

## 6. Tests and the mutants they must kill (written first)

| # | Test | Mutant |
|---|---|---|
| T1 | first create with a key: `201`; the same key and body again: `200`, same `id`/`slug`, **one** row, 0 tag writes, 0 purge calls | return `201` on replay; purge or write tags on replay |
| T2 | same key, different title/body/status/tags: `422`, row unchanged | skip the hash compare; compare against the *current* row instead of the stored hash |
| T3 | same key from two different authors: two posts | drop `author_id` from the unique index or from the replay SELECT |
| T4 | no header: response, row and purge calls identical to main's | any behaviour change without the header |
| T5 | two concurrent creates with one key (`Promise.all`): one row, responses `201` + `200` with one id | add a SELECT-then-INSERT pre-check (races) |
| T6 | an idempotency conflict is **not** retried as a slug collision: the post whose title collides with an existing slug still gets its suffix, and a key replay never does | `isUniqueViolation` without the constraint name (the §1 hazard) |
| T7 | a malformed key (15 chars, 65 chars, a space, `;`) is `400` with the field name only, and writes nothing | validate after the insert; echo the value |
| T8 | replay after the post was deleted creates a new post | key kept in a side store beyond the post |
| T9 | web: the hidden field exists on the create form and not on edit; the failed-submit re-render keeps its value; the POST sends the header; the fragment script replaces it and rejects a malformed one | key regenerated per render; sent as a body field |
| T10 | migration: the pair check and shape check reject a key without a hash and a key with a space; the partial index allows many `NULL` keys | a non-partial index (second keyless post collides) |

Each mutant is applied with an anchor-count assertion, must fail the named test, and is reverted.

## 7. Open items

- Whether to also expose the key in `AuthoredPost` (the author's own read) so a client can recover "which post is
  mine for this result" without the response. Not needed for route A, where CodeRipper learns the post URL from the
  user pasting it back; cheap to add later.
- A server-side return-to-dashboard redirect needs an allowlisted return URL and the open-redirect guard
  (`lib/next-url.ts`); out of scope here.
- Per-account post rate limiting stays deferred (`posts.ts:31-39`); under route A a human presses Publish.

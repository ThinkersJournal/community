# Handle-at-Signup — Design

**Status:** Approved 2026-08-13. Pre-launch milestone (fix-list #1, see
`docs/pre-launch-fixes.md`).

**Goal:** Move permanent `@handle` selection onto the signup form and retire the
placeholder-then-claim-at-first-post onboarding flow entirely. Add an
unverified-account reaper so pre-verification handle claims can't be squatted.

**Why:** Today signup mints a throwaway placeholder handle
(`<emaillocal>_<randomsuffix>`) and the user is forced to pick a permanent,
immutable handle — with no warning — inside the first-post editor. The spec
intended a post-verification redirect that was never built, so the gate ambushes
users. Moving selection to signup makes the handle a deliberate, up-front choice.

---

## Decisions (settled during brainstorming)

1. **Handle location:** chosen on the signup form (email + password + @handle),
   before email verification. (Option A.)
2. **Mutability:** immutable, **locked at verification**. Before a user verifies,
   a re-signup of the same (unverified) email updates the handle — a free
   correction window for typos. After verification, the handle never changes.
   A dedicated "change your handle" feature is explicitly **out of scope** here
   (deferred; would need 301/handle-history done properly).
3. **Reaper:** a daily cron **hard-deletes** accounts with `email_verified_at IS
   NULL` older than **7 days** (profiles/media/etc. cascade via existing FKs),
   freeing both the handle and the email.
4. **Collision UX:** on a taken handle, reject at submit with `409
   USERNAME_TAKEN` **plus a few available suggestions**; server-side only, no
   client JS. (Live-as-you-type check was rejected as unneeded scope.)
5. **Onboarding concept:** fully retired. `username_chosen` and everything gating
   on it are removed (full cleanup, ~10 files + a migration), not left vestigial.

**Non-goals:** changeable handles / renames; account deletion (a separate
milestone — it is the escape hatch for post-verification handle regret);
display-name editing.

---

## Architecture / approach

Preserve signup's existing **constraint-driven** philosophy: attempt the write
and let the DB's unique constraints decide the outcome, then translate that
outcome into the wire envelope. We do **not** pre-check availability with a
`SELECT` — check-then-act is a race under the transaction-mode pooler, which the
codebase forbids (`signup.ts` already learned this for the email path). The
chosen handle rides the same atomic transaction the email upsert already uses;
a `profiles.username` unique violation rolls the whole signup back.

---

## Components & changes

### 1. Validation — `packages/shared`

- `SignupInput` (`schemas.ts`) gains a `username` field reusing the existing
  `USERNAME_PATTERN` (`^[a-z0-9_]{3,30}$`) with `trim().toLowerCase()` — the same
  normalization `ChooseUsernameInput` used.
- `RESERVED_USERNAMES` moves from `apps/api/src/routes/username.ts` to a small
  dedicated module `apps/api/src/auth/reserved-usernames.ts`, imported by the
  signup handler. It stays server-side (enforcement only) and returns `400` for a
  reserved handle.
- `ChooseUsernameInput` is deleted (its only consumer, `handleChooseUsername`, is
  removed).

### 2. Signup handler — `apps/api/src/routes/signup.ts`

- **Delete `generateUsername`** and the `USERNAME_BASE_MAX` / `USERNAME_ATTEMPTS`
  / `randomSuffix` machinery for username minting.
- Validation order (pure checks first, no new I/O before the origin check):
  1. `SignupInput.safeParse` (format) → `400 INVALID_INPUT { fields }`
  2. reserved-handle check → `400 INVALID_INPUT { fields: ["username"],
     message: "That handle is reserved." }`
  3. origin (CSRF), rate-limit, Turnstile, hash — unchanged.
- **Profile write** inside the existing transaction becomes a single statement:
  `INSERT INTO profiles (user_id, username) VALUES ($1, $2)
   ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`
  - The `user_id` conflict (re-signup) now **updates** the handle (the
    pre-verification correction window), instead of the old `DO NOTHING`.
  - A `profiles.username` unique violation (another account holds the handle) is
    NOT swallowed/retried — it propagates, the transaction rolls back (no user
    created / no password change committed), and the handler translates it.
  - The savepoint retry loop is removed (there is no random suffix to retry with
    anymore).
- **Outcome translation** (after the transaction):
  - verified-email dup → `409 EMAIL_TAKEN` (unchanged; the email upsert decides
    this first, so email dup wins over a handle collision).
  - `profiles.username` unique violation → `409 USERNAME_TAKEN` **with
    suggestions** (see §3).
  - success (insert or unverified re-signup) → `201` + session cookie
    (unchanged).
- The email/epoch/session/cookie steps are otherwise unchanged.

### 3. Suggestion helper

On a `USERNAME_TAKEN` collision, compute a few available alternatives from the
attempted handle and return them so the web page can offer one-click fills.

- Signature (api-internal): `suggestUsernames(client, base): Promise<string[]>`.
- Generate a bounded candidate set from `base` (e.g. `base2`, `base3`, `base_`,
  and a couple of short numeric suffixes), each truncated so the result stays
  within `USERNAME_PATTERN`'s 30-char max and each excluding `RESERVED_USERNAMES`.
- One `SELECT username FROM profiles WHERE username = ANY($candidates)` marks the
  taken ones; return up to **3** free candidates (possibly fewer / empty — the
  page degrades to "try another" when empty).
- Runs on a fresh `HYPERDRIVE_FRESH` connection AFTER the rolled-back
  transaction, only on the collision path.
- Wire shape: `errorResponse("USERNAME_TAKEN", 409, { fields: ["username"],
  suggestions: string[] })`.

### 4. Retire the onboarding concept (full cleanup)

Every one of these references the now-obsolete `username_chosen` / choose-username
flow and is removed or simplified:

- **Delete** `apps/web/src/pages/choose-username.astro`.
- **Delete** the route + handler: `POST /profile/username`
  (`handleChooseUsername` in `apps/api/src/routes/username.ts`; drop its entry in
  `apps/api/src/routes.ts`). `handleGetMe` stays (see below).
- **Delete** `apps/api/src/db/onboarding.ts` (the `isOnboarded` helper).
- **Remove** `requireChosenUsername` and its two call sites in
  `apps/api/src/routes/posts.ts` — every session user now has a handle, so the
  gate is dead. (Publishing still requires a verified email via the existing
  pipeline; only the chosen-handle gate goes.)
- **Remove** the `WHERE pr.username_chosen = true` filter in
  `apps/api/src/routes/search-sql.ts` (all authors now have a handle).
- **Simplify** the comment islands `apps/web/src/scripts/comments.ts` and
  `comments-live.ts`: drop the `usernameChosen` gate and the `/choose-username`
  redirect; the enabling condition becomes logged-in + `csrfToken` present.
- **Simplify** `apps/web/src/pages/new-post.astro`: remove the `notOnboarded`
  branch and its `/choose-username` link/redirect.
- **Simplify** `Me` (`packages/shared/src/social.ts`) to `{ userId, username }`;
  update `handleGetMe` and the web `apps/web/src/pages/api/me.ts` proxy to stop
  returning `usernameChosen`.
- **Migration `0011`** drops `profiles.username_chosen`.
  - **Deploy ordering:** deploy the code that no longer references the column
    first, then run `0011`. (Dropping it while old code still `SELECT`s it would
    break the old code.) Tests run against the migrated schema with new code, so
    they are unaffected.

### 5. Web signup page — `apps/web/src/pages/signup.astro`

- Add the `@handle` input, forwarded to the api alongside email/password
  (unchanged Origin-forwarding). Copy states permanence: e.g. *"Your @handle is
  permanent — choose carefully."*
- Render the api's statuses: `USERNAME_TAKEN` shows the error with the returned
  `suggestions` rendered as **plain server-rendered text** (e.g. "@ada is taken —
  try @ada2, @ada3, or @ada_"); the user retypes their choice. **No client JS** —
  this honors the no-JS collision-UX decision and the page's current
  `script-src 'self'`. (Click-to-fill chips are a deferred nice-to-have.)
  Reserved → its message; bad format → generic field error.
- The Turnstile placeholder field stays as-is (real widget is a separate
  pre-launch item).

### 6. The reaper — `apps/api`

- **New cron** `"30 3 * * *"` added to `apps/api/wrangler.jsonc`'s
  `triggers.crons` (offset from the 14:00 digest).
- **Dispatcher** (`apps/api/src/index.ts` `scheduled`) routes explicitly:
  `if (controller.cron === "30 3 * * *") reap; else <existing digest/instant
  drain>`. (The current dispatcher treats every non-`0 14` pattern as the instant
  drain, so the reaper needs its own explicit branch.)
- **New** `reapUnverifiedAccounts(env, ctx)` (e.g.
  `apps/api/src/auth/reap-unverified.ts`):
  `DELETE FROM users WHERE email_verified_at IS NULL AND created_at < now() -
  interval '7 days'` on `HYPERDRIVE_FRESH`. Profiles/media/posts/etc. cascade via
  existing `ON DELETE CASCADE` FKs, freeing the handle and email.
  - Bounded: delete in capped batches (e.g. `... AND id IN (SELECT id ... LIMIT
    N)`) so one run can't hold an unbounded delete; log the count reaped.
  - Keyed on `created_at` age (never last-activity), grace period comfortably
    longer than the verification email's life — never reaps mid-verification.
- **Test hook:** a `TEST_ROUTES`-gated way to invoke the reaper (mirroring the
  email-drain test affordances) so e2e/integration can exercise it deterministically.

---

## Error / wire envelopes

| Case | Status | Envelope |
|------|--------|----------|
| Bad format | 400 | `INVALID_INPUT { fields }` |
| Reserved handle | 400 | `INVALID_INPUT { fields:["username"], message }` |
| Handle taken | 409 | `USERNAME_TAKEN { fields:["username"], suggestions }` |
| Verified email dup | 409 | `EMAIL_TAKEN` |
| Success | 201 | `{ userId }` + `Set-Cookie` |

---

## Testing

- **`apps/api/test/signup.test.ts`** — chosen-handle happy path; taken → `409
  USERNAME_TAKEN` with non-empty `suggestions` that are themselves available and
  non-reserved; reserved → `400`; bad-format → `400`; unverified re-signup
  updates the handle; verified-email dup still `409 EMAIL_TAKEN` (email wins over
  a simultaneous handle collision). The existing account-takeover / epoch-bump
  invariants must keep passing.
- **Reaper unit test** — deletes unverified accounts older than the window,
  keeps verified accounts and recent unverified ones; the cascade frees the
  handle (a reaped handle becomes claimable again).
- **`packages/shared`** — `SignupInput` accepts a valid handle and rejects bad
  format/length/casing (normalized).
- **e2e (`e2e/signup.spec.ts` / helpers)** — sign up choosing a handle end to
  end (through the web page → api → verify), then a second signup attempting the
  same handle is rejected with the taken message. Update `signUpAndVerify` /
  `chooseUsername` helpers: signup now takes a handle and there is no separate
  choose-username step. A reaper e2e via the test hook is optional if the unit
  coverage is sufficient.
- **Remove** the choose-username tests (unit + any e2e step).

---

## Rollout notes

- Migration `0011` (drop `username_chosen`) runs **after** the code deploy that
  stops referencing the column.
- The reaper cron is new; confirm it registers on deploy (`wrangler deploy`
  surfaces the cron triggers).
- No data backfill needed: existing rows already have a `username`; the dropped
  `username_chosen` was already effectively true for anyone who had posted.

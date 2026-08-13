# Handle-at-Signup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move permanent `@handle` selection onto the signup form, retire the placeholder-then-claim onboarding flow entirely, and add a reaper that deletes never-verified accounts after 7 days.

**Architecture:** Keep signup's constraint-driven philosophy — attempt the write, let the DB's unique constraints decide, translate the outcome. The chosen handle rides the existing atomic upsert; a `profiles.username` collision rolls the whole signup back and becomes `409 USERNAME_TAKEN` + suggestions. Everything gating on the now-obsolete `username_chosen` flag is removed and the column dropped. A daily cron hard-deletes unverified accounts older than 7 days, freeing squatted handles.

**Tech Stack:** Cloudflare Workers (api + Astro web), Postgres 18 via Hyperdrive, zod (shared schemas), vitest (unit, `cloudflare:test`), Playwright (e2e, two-Worker harness), node-pg-migrate (SQL migrations).

**Spec:** `docs/superpowers/specs/2026-08-13-handle-at-signup-design.md`

## Global Constraints

- **Handle format:** `USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/`, normalized `trim().toLowerCase()`. Reuse the existing constant; never redefine it.
- **Password:** `z.string().min(12)` (unchanged).
- **Mutability:** handle is immutable, **locked at verification**. Unverified re-signup updates the handle (correction window). No change-handle feature in this milestone.
- **Reaper:** daily `30 3 * * *`; hard-`DELETE` `users WHERE email_verified_at IS NULL AND created_at < now() - interval '7 days'`, in bounded batches; cascades free handle + email.
- **Collision UX:** `409 USERNAME_TAKEN` with `suggestions: string[]`; **no client JS** on the signup page (stays within `script-src 'self'`).
- **Error envelope:** `{ code, message?, fields?, suggestions? }` — every non-2xx goes through `errorResponse` (backstopped by `apps/api/test/error-envelope.test.ts`).
- **DB access:** all signup/auth/reaper DB work uses `env.HYPERDRIVE_FRESH` (cache-disabled). Never `HYPERDRIVE_CACHED` here.
- **No pre-check:** never `SELECT`-then-`INSERT` for uniqueness — check-then-act is a race under the transaction-mode pooler.
- **Migration ordering:** migration `0011` (drop `username_chosen`) is the LAST code-affecting change; in prod it runs AFTER the code deploy that stops referencing the column.
- **Branch:** `handle-at-signup` (already created off `main`).

---

## File Structure

**Shared (`packages/shared/src/`)**
- `schemas.ts` — `SignupInput` gains `username` (MODIFY).
- `errors.ts` — `ApiErrorBody` gains `suggestions?` (MODIFY).
- `social.ts` — `Me` → `{ userId, username }`; delete `ChooseUsernameInput` (MODIFY).

**api (`apps/api/src/`)**
- `auth/reserved-usernames.ts` — the reserved-handle set, moved here (CREATE).
- `auth/username-suggest.ts` — `candidateHandles` + `suggestUsernames` (CREATE).
- `auth/reap-unverified.ts` — `reapUnverifiedAccounts` (CREATE).
- `routes/signup.ts` — accept + validate chosen handle; collision→suggestions; re-signup update; drop `generateUsername`/savepoint retry (MODIFY).
- `routes/username.ts` — delete `handleChooseUsername` + `RESERVED_USERNAMES` (moved); keep `handleGetMe`, return `{ userId, username }` (MODIFY).
- `routes.ts` — drop the `POST /profile/username` entry + import (MODIFY).
- `routes/posts.ts` — delete `requireChosenUsername` + its 2 call sites (MODIFY).
- `routes/search-sql.ts` — drop `WHERE pr.username_chosen = true` (MODIFY).
- `routes/__test.ts` — add the `POST /__test/reap-unverified` hook (MODIFY).
- `db/onboarding.ts` — DELETE.
- `index.ts` — `scheduled` dispatcher gains the reaper branch (MODIFY).
- `http/errors.ts` — `errorResponse` serializes `suggestions` (MODIFY).
- `migrations/0011_drop_username_chosen.sql` — CREATE.
- `wrangler.jsonc` — add `"30 3 * * *"` cron (MODIFY).

**web (`apps/web/src/`)**
- `pages/signup.astro` — handle field + suggestion rendering (MODIFY).
- `pages/choose-username.astro` — DELETE.
- `pages/api/me.ts` — drop `usernameChosen` from the proxied shape (MODIFY).
- `pages/new-post.astro` — remove the `notOnboarded` branch/redirect (MODIFY).
- `scripts/comments.ts`, `scripts/comments-live.ts` — drop the `usernameChosen` gate + `/choose-username` redirect (MODIFY).

**e2e (`e2e/`)**
- `helpers.ts` — `signUp`/`signUpAndVerify` take + return a handle; delete `chooseUsername`; `publishPost` uses the signup handle (MODIFY).
- `signup.spec.ts` — add signup-with-handle + taken-handle cases (MODIFY).
- all specs calling `chooseUsername`/`publishPost` — update call sites (MODIFY).

**ApiErrorCode cleanup:** after the flow is gone, `USERNAME_ALREADY_SET` and `USERNAME_REQUIRED` are unreferenced — remove them from `ApiErrorCode` (verify with a repo grep first).

---

## Task 1: Shared — `SignupInput.username` + `suggestions` envelope

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/api/src/http/errors.ts`
- Test: `packages/shared/test/schemas.test.ts` (or the existing shared schema test file), `apps/api/test/error-envelope.test.ts`

**Interfaces:**
- Consumes: `USERNAME_PATTERN` from `packages/shared/src/social.ts` (`/^[a-z0-9_]{3,30}$/`).
- Produces: `SignupInput` now `{ email, password, username, turnstileToken }` with `username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN)`; `ApiErrorBody`/`ErrorResponseInit` gain `suggestions?: string[]`; `errorResponse` serializes `suggestions`.

- [ ] **Step 1: Write the failing shared-schema test**

In the shared schema test file:
```ts
import { SignupInput } from "../src/schemas";

it("SignupInput requires a valid normalized handle", () => {
  const ok = SignupInput.safeParse({
    email: "A@B.com", password: "x".repeat(12), username: "  Ada_1  ", turnstileToken: "t",
  });
  expect(ok.success).toBe(true);
  if (ok.success) expect(ok.data.username).toBe("ada_1"); // trimmed + lowercased

  expect(SignupInput.safeParse({ email: "a@b.com", password: "x".repeat(12), username: "ab", turnstileToken: "t" }).success).toBe(false); // too short
  expect(SignupInput.safeParse({ email: "a@b.com", password: "x".repeat(12), username: "bad handle", turnstileToken: "t" }).success).toBe(false); // space
});
```

- [ ] **Step 2: Run it — expect FAIL** (`username` not in `SignupInput`). Command: `pnpm --filter @thinkersjournal/shared test` (or the repo's shared test command).

- [ ] **Step 3: Add `username` to `SignupInput`**

In `schemas.ts`, import the pattern and extend the object:
```ts
import { USERNAME_PATTERN } from "./social";

export const SignupInput = z.object({
  email: NormalizedEmail,
  password: z.string().min(12),
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
  turnstileToken: z.string().min(1),
});
```
(If `schemas.ts` importing from `social.ts` creates a cycle, move `USERNAME_PATTERN` to a leaf module both import; verify no cycle with `pnpm --filter @thinkersjournal/shared build`.)

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 4b: Keep the api signup suite green.** Adding a REQUIRED `username`
  makes every existing `apps/api/test/signup.test.ts` payload fail zod. Update
  those payloads to include a valid `username` (e.g. a `uniqHandle()` helper).
  The handler still ignores it until Task 3, but the schema now requires it, so
  this keeps the suite green at this task's boundary. Run
  `pnpm --filter api test signup` → PASS. (The signup PAGE gains its field in
  Task 7 and the e2e helpers in Task 9; e2e is verified at the end, not per-task.)

- [ ] **Step 5: Write the failing envelope test** in `apps/api/test/error-envelope.test.ts` (add a case):
```ts
it("errorResponse carries optional suggestions", async () => {
  const res = errorResponse("USERNAME_TAKEN", 409, { fields: ["username"], suggestions: ["ada2", "ada3"] });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toMatchObject({ code: "USERNAME_TAKEN", fields: ["username"], suggestions: ["ada2", "ada3"] });
});
```

- [ ] **Step 6: Run — expect FAIL** (suggestions dropped).

- [ ] **Step 7: Extend the envelope**

`packages/shared/src/errors.ts` — add to `ApiErrorBody`:
```ts
  /** For USERNAME_TAKEN: a few available handle suggestions. Advisory; never branch on it. */
  suggestions?: string[];
```
`apps/api/src/http/errors.ts` — add `suggestions?: string[]` to `ErrorResponseInit`, and in `errorResponse`:
```ts
  if (init.suggestions !== undefined) body.suggestions = init.suggestions;
```

- [ ] **Step 8: Run the envelope test + full shared + api error tests — expect PASS.**

- [ ] **Step 9: Commit** — `git add ... && git commit -m "feat(shared): SignupInput.username + suggestions error envelope"`

---

## Task 2: `reserved-usernames.ts` + `suggestUsernames`

**Files:**
- Create: `apps/api/src/auth/reserved-usernames.ts`
- Create: `apps/api/src/auth/username-suggest.ts`
- Test: `apps/api/test/username-suggest.test.ts`

**Interfaces:**
- Consumes: `USERNAME_PATTERN` (shared), `Client` (pg), `withClient` is NOT used here (helper takes a `Client`).
- Produces: `RESERVED_USERNAMES: ReadonlySet<string>`; `candidateHandles(base: string): string[]`; `suggestUsernames(client: Client, base: string): Promise<string[]>` (≤3 available, non-reserved).

- [ ] **Step 1: Move the reserved set.** Create `apps/api/src/auth/reserved-usernames.ts` with the exact set currently in `apps/api/src/routes/username.ts` (lines ~22–27):
```ts
/** Handles that would let an account impersonate the platform or a role. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "support", "help", "official", "staff", "team",
  "moderator", "mod", "root", "system", "security", "abuse", "billing",
  "thinkersjournal", "thinkers_journal", "tj", "api", "www", "mail",
  "about", "login", "logout", "signup", "settings", "me", "feed", "authors",
]);
```

- [ ] **Step 2: Write the failing test** `apps/api/test/username-suggest.test.ts` (uses `cloudflare:test` + a real client via the test DB, same idiom as other api DB tests — see any `*.db.test.ts`):
```ts
import { env } from "cloudflare:test";
import { candidateHandles, suggestUsernames } from "../src/auth/username-suggest";
import { withClient } from "../src/db/client";

it("candidateHandles yields valid, non-reserved, length-capped variants", () => {
  const c = candidateHandles("ada");
  expect(c).toContain("ada2");
  expect(c.every((h) => /^[a-z0-9_]{3,30}$/.test(h))).toBe(true);
  expect(candidateHandles("me")).not.toContain("me"); // base too short is not returned as-is
  // a 30-char base still yields <=30-char suggestions
  expect(candidateHandles("a".repeat(30)).every((h) => h.length <= 30)).toBe(true);
});

it("suggestUsernames returns only AVAILABLE variants", async () => {
  await withClient(env.HYPERDRIVE_FRESH, {} as ExecutionContext, async (client) => {
    // seed: create a user+profile holding "sugbase2" so it is excluded
    const { rows } = await client.query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`sug-${crypto.randomUUID()}@e.com`]);
    await client.query(`INSERT INTO profiles (user_id, username) VALUES ($1,'sugbase2')`, [rows[0].id]);
    const out = await suggestUsernames(client, "sugbase");
    expect(out).not.toContain("sugbase2");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((h) => /^[a-z0-9_]{3,30}$/.test(h))).toBe(true);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (module not found).

- [ ] **Step 4: Implement `username-suggest.ts`:**
```ts
import { USERNAME_PATTERN } from "@thinkersjournal/shared";
import { RESERVED_USERNAMES } from "./reserved-usernames";
import type { Client } from "pg";

const MAX_LEN = 30;
const SUGGESTION_COUNT = 3;

/** Candidate variants of `base`, all valid + non-reserved, in preference order. */
export function candidateHandles(base: string): string[] {
  const out: string[] = [];
  const push = (h: string): void => {
    if (USERNAME_PATTERN.test(h) && !RESERVED_USERNAMES.has(h) && !out.includes(h)) out.push(h);
  };
  for (const suffix of ["2", "3", "4", "5", "_", "1", "7", "99"]) {
    push(`${base.slice(0, MAX_LEN - suffix.length)}${suffix}`);
  }
  return out;
}

/** Up to SUGGESTION_COUNT available (unclaimed, non-reserved) handles near `base`. */
export async function suggestUsernames(client: Client, base: string): Promise<string[]> {
  const candidates = candidateHandles(base);
  if (candidates.length === 0) return [];
  const { rows } = await client.query<{ username: string }>(
    `SELECT username FROM profiles WHERE username = ANY($1::citext[])`,
    [candidates],
  );
  const taken = new Set(rows.map((r) => r.username.toLowerCase()));
  return candidates.filter((h) => !taken.has(h)).slice(0, SUGGESTION_COUNT);
}
```

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Commit** — `git commit -m "feat(api): reserved-usernames module + suggestUsernames helper"`

---

## Task 3: Signup handler — accept + validate the chosen handle

**Files:**
- Modify: `apps/api/src/routes/signup.ts`
- Test: `apps/api/test/signup.test.ts`

**Interfaces:**
- Consumes: `SignupInput` (now with `username`), `RESERVED_USERNAMES`, `suggestUsernames`, `errorResponse(..., { suggestions })`, `isUniqueViolation`.
- Produces: `POST /auth/signup` accepting `username`; `409 USERNAME_TAKEN { fields:["username"], suggestions }` on collision; `400 INVALID_INPUT { fields:["username"], message }` on reserved; unverified re-signup updates the handle.

- [ ] **Step 1: Write failing tests** (add to `signup.test.ts`, following its existing helpers):
```ts
it("creates an account with the chosen handle", async () => {
  const res = await signup({ email: uniq(), password: "x".repeat(12), username: uniqHandle(), turnstileToken: "t" });
  expect(res.status).toBe(201);
});

it("409 USERNAME_TAKEN with available suggestions when the handle is claimed", async () => {
  const handle = uniqHandle();
  await signup({ email: uniq(), password: "x".repeat(12), username: handle, turnstileToken: "t" }); // verify it in the harness so it isn't reaped/overwritten if needed
  const res = await signup({ email: uniq(), password: "x".repeat(12), username: handle, turnstileToken: "t" });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("USERNAME_TAKEN");
  expect(Array.isArray(body.suggestions)).toBe(true);
  expect(body.suggestions.length).toBeGreaterThan(0);
});

it("400 for a reserved handle", async () => {
  const res = await signup({ email: uniq(), password: "x".repeat(12), username: "admin", turnstileToken: "t" });
  expect(res.status).toBe(400);
  expect((await res.json()).fields).toContain("username");
});

it("unverified re-signup UPDATES the handle", async () => {
  const email = uniq();
  const h1 = uniqHandle(), h2 = uniqHandle();
  await signup({ email, password: "x".repeat(12), username: h1, turnstileToken: "t" });
  await signup({ email, password: "x".repeat(12), username: h2, turnstileToken: "t" }); // same unverified email
  // assert via the DB that the profile now holds h2 (use the test client)
});
```
Keep the EXISTING signup tests (account-takeover, epoch bump, EMAIL_TAKEN) — they must still pass; update their payloads to include a `username`.

- [ ] **Step 2: Run — expect FAIL** (username unused; reserved/collision not handled).

- [ ] **Step 3: Implement the handler change.**
- Delete `generateUsername`, `USERNAME_BASE_MAX`, `USERNAME_ATTEMPTS`, the `randomSuffix` import, and the whole `insertProfile` savepoint-retry function.
- After `const { email, password, turnstileToken } = parsed.data;` → also destructure `username`, and immediately after the zod check add the reserved check (pure, no I/O):
```ts
const { email, password, username, turnstileToken } = parsed.data;
if (RESERVED_USERNAMES.has(username)) {
  return errorResponse("INVALID_INPUT", 400, { fields: ["username"], message: "That handle is reserved." });
}
```
- Replace the `insertProfile(c, row.id, email)` call inside the transaction with:
```ts
await c.query(
  `INSERT INTO profiles (user_id, username) VALUES ($1, $2)
   ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
  [row.id, username],
);
```
- Wrap the `withClient(...)` upsert call in a try/catch that translates a username collision (the only unique violation that can escape the transaction — email and user_id are both `ON CONFLICT DO UPDATE`):
```ts
let upserted;
try {
  upserted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => { /* existing tx body */ });
} catch (err) {
  if (isUniqueViolation(err)) {
    const suggestions = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => suggestUsernames(c, username));
    return errorResponse("USERNAME_TAKEN", 409, { fields: ["username"], suggestions });
  }
  throw err;
}
```
- Add imports: `RESERVED_USERNAMES` from `../auth/reserved-usernames`, `suggestUsernames` from `../auth/username-suggest`.

- [ ] **Step 4: Run signup tests — expect PASS** (new + existing).

- [ ] **Step 5: Commit** — `git commit -m "feat(api): choose @handle at signup (reserved 400, collision 409+suggestions, re-signup update)"`

---

## Task 4: Cleanup (api) — retire the onboarding gate

**Files:**
- Modify: `apps/api/src/routes/username.ts` (delete `handleChooseUsername`; keep `handleGetMe`, return `{ userId, username }`)
- Modify: `apps/api/src/routes.ts` (drop the route + import)
- Modify: `apps/api/src/routes/posts.ts` (delete `requireChosenUsername` + 2 call sites)
- Modify: `apps/api/src/routes/search-sql.ts` (drop the `username_chosen` filter)
- Modify: `packages/shared/src/social.ts` (`Me` → `{ userId, username }`; delete `ChooseUsernameInput`)
- Modify: `packages/shared/src/errors.ts` (remove `USERNAME_ALREADY_SET`, `USERNAME_REQUIRED` from `ApiErrorCode` — grep first)
- Delete: `apps/api/src/db/onboarding.ts`
- Test: `apps/api/test/username.test.ts`, `apps/api/test/posts.test.ts`, `apps/api/test/search*.test.ts`

**Interfaces:**
- Produces: `Me = { userId, username }`; `GET /profile/me` returns it; posts publish is no longer handle-gated; search returns all authors.

- [ ] **Step 1: Update/failing tests.** In `username.test.ts` remove the `handleChooseUsername` suite and assert `handleGetMe` returns `{ userId, username }` (no `usernameChosen`). In `posts.test.ts` remove any `USERNAME_REQUIRED` expectation and assert a verified user with a handle can publish. In the search test, assert a freshly-created author appears (no `username_chosen` precondition).

- [ ] **Step 2: Run — expect FAIL** where the code still references the flag.

- [ ] **Step 3: Implement removals.**
- `social.ts`: `export interface Me { userId: string; username: string; }`; delete `ChooseUsernameInput` + `ChooseUsernameValue`.
- `username.ts`: delete `handleChooseUsername`, the `RESERVED_USERNAMES` const (now in `reserved-usernames.ts`), the `ChooseUsernameInput` import, and the `json()` helper if now unused; `handleGetMe` selects `user_id, username` only and returns `{ userId, username }`.
- `routes.ts`: remove the `{ method:"POST", pattern:"/profile/username", handler: handleChooseUsername }` line and drop `handleChooseUsername` from the import.
- `posts.ts`: delete `requireChosenUsername` and both `const gate = await requireChosenUsername(...)` blocks (the verified-email gate via the pipeline stays).
- `search-sql.ts`: remove `WHERE pr.username_chosen = true` (adjust surrounding `WHERE`/`AND` so the SQL stays valid).
- Delete `db/onboarding.ts`.
- `errors.ts`: after `grep -rn "USERNAME_ALREADY_SET\|USERNAME_REQUIRED" apps packages` confirms zero remaining references, remove both from `ApiErrorCode`.

- [ ] **Step 4: Run api + shared tests — expect PASS.** Also `pnpm --filter api typecheck`-equivalent (the api build) to catch dangling references.

- [ ] **Step 5: Commit** — `git commit -m "refactor(api): remove choose-username flow + username_chosen gates"`

---

## Task 5: Cleanup (web) — delete the picker + its redirects

**Files:**
- Delete: `apps/web/src/pages/choose-username.astro`
- Modify: `apps/web/src/pages/api/me.ts` (drop `usernameChosen`)
- Modify: `apps/web/src/pages/new-post.astro` (remove `notOnboarded` branch + redirect)
- Modify: `apps/web/src/scripts/comments.ts`, `apps/web/src/scripts/comments-live.ts` (drop the gate + `/choose-username` redirect)
- Test: `apps/web/test/*` covering the comment islands / new-post (update source-text assertions)

**Interfaces:**
- Consumes: `Me = { userId, username }` (Task 4).

- [ ] **Step 1: Update failing tests.** Where a web test asserts a `/choose-username` redirect or `usernameChosen` handling, replace with the new behavior (comment enabling condition = logged-in + `csrfToken`; new-post shows the editor for any signed-in verified user). If the comment islands have source-text tests asserting the redirect string, flip them to assert its ABSENCE.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.**
- `api/me.ts`: the logged-out shape drops `usernameChosen`; the logged-in shape returns `{ loggedIn, userId, username, csrfToken }` (mirror `Me`). Keep `csrfToken` — the bell/comment islands rely on it.
- `new-post.astro`: delete `const notOnboarded = ...`, the `notOnboarded ?` branch, and the `Location: "/choose-username?next=/new-post"` redirect; a signed-in verified user goes straight to the editor.
- `comments.ts` / `comments-live.ts`: delete the `usernameChosen` field from the local `Me` shape and the `if (!me.usernameChosen) location.href = "/choose-username..."` branch; the enabling condition becomes `me.loggedIn && me.csrfToken !== null && me.userId !== null`.

- [ ] **Step 4: Run web tests — expect PASS.** Run `pnpm --filter web typecheck` (astro check) to catch dangling `usernameChosen`.

- [ ] **Step 5: Commit** — `git commit -m "refactor(web): remove choose-username page + onboarding redirects"`

---

## Task 6: Migration 0011 — drop `username_chosen`

**Files:**
- Create: `apps/api/migrations/0011_drop_username_chosen.sql`
- Test: existing DB/schema tests run against the migrated schema (no new test needed beyond green suites).

- [ ] **Step 1: Write the migration:**
```sql
-- Up Migration
-- Handle selection moved to signup (see docs/superpowers/specs/2026-08-13-handle-at-signup-design.md),
-- so the onboarding flag is obsolete. Runs AFTER the code that stopped reading it.
ALTER TABLE profiles DROP COLUMN username_chosen;

-- Down Migration
ALTER TABLE profiles ADD COLUMN username_chosen boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Apply it to the dev/test DB** — `node scripts/migrate.mjs dev up` (per the repo's migrate runner), then run the full api suite: `pnpm --filter api test`. Expected: PASS (no code references the dropped column).

- [ ] **Step 3: Grep guard** — `grep -rn "username_chosen" apps packages` returns ONLY this migration file (and the spec/plan). Any code hit is a miss from Task 4/5 — fix it.

- [ ] **Step 4: Commit** — `git commit -m "feat(db): migration 0011 drop profiles.username_chosen"`

**Deploy note (not a code step):** in production, deploy the Task 3–5/7/8 code first, THEN run `0011`. Dropping the column while old code still `SELECT`s it would break the old code.

---

## Task 7: Web signup page — handle field + suggestions

**Files:**
- Modify: `apps/web/src/pages/signup.astro`
- Test: `apps/web/test/signup*.test.ts` (source-text assertions, matching the repo's Astro-page test style)

**Interfaces:**
- Consumes: the api's `201` / `400 INVALID_INPUT` / `409 USERNAME_TAKEN { suggestions }` / `409 EMAIL_TAKEN` / `429`.

- [ ] **Step 1: Write failing tests** asserting the page has a `username` input, forwards it, and renders suggestions on `USERNAME_TAKEN`:
```ts
const s = read("apps/web/src/pages/signup.astro");
expect(s).toMatch(/name="username"/);
expect(s).toMatch(/permanent/i);              // permanence copy
expect(s).toContain("USERNAME_TAKEN");        // branches on the code
expect(s).toMatch(/suggestions/);             // renders the suggested handles
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.**
- Add the field to the form and to the api body (alongside `email`/`password`/`turnstileToken`):
```astro
<label>
  Handle
  <input type="text" name="username" required minlength="3" maxlength="30"
         pattern="[a-z0-9_]+" title="3–30 lowercase letters, numbers, or _" />
  <small>Your @handle is permanent — choose carefully.</small>
</label>
```
Forward `username: form.get("username")` in the `apiFetch("/auth/signup", { body: { ... } })` call.
- After the POST, branch on the response: on `409` with `code === "USERNAME_TAKEN"`, set `message` to include the suggestions as plain text, e.g.:
```ts
const taken = response.data?.code === "USERNAME_TAKEN";
const suggestions: string[] = response.data?.suggestions ?? [];
message = taken
  ? suggestions.length
    ? `That handle is taken. Available: ${suggestions.map((h) => "@" + h).join(", ")}.`
    : "That handle is taken — please choose another."
  : /* existing 400/409-email/429 mapping */;
```
(No client JS — the suggestions are rendered as text in the existing `#error` block. Keep the Turnstile placeholder field as-is.)
- Ensure the `apiFetch` type includes `suggestions?: string[]` / `code?: string` so the branch type-checks.

- [ ] **Step 4: Run — expect PASS**; `pnpm --filter web typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): choose @handle on the signup form + taken-handle suggestions"`

---

## Task 8: The reaper

**Files:**
- Create: `apps/api/src/auth/reap-unverified.ts`
- Modify: `apps/api/src/index.ts` (`scheduled` dispatcher)
- Modify: `apps/api/src/routes/__test.ts` (test hook)
- Modify: `apps/api/wrangler.jsonc` (cron)
- Test: `apps/api/test/reap-unverified.test.ts`

**Interfaces:**
- Produces: `reapUnverifiedAccounts(env: Env, ctx: ExecutionContext): Promise<number>` (count reaped); cron `"30 3 * * *"`; `POST /__test/reap-unverified` (TEST_ROUTES-gated) → `{ reaped }`.

- [ ] **Step 1: Write the failing test:**
```ts
import { env } from "cloudflare:test";
import { reapUnverifiedAccounts } from "../src/auth/reap-unverified";
import { withClient } from "../src/db/client";

it("deletes unverified accounts older than 7 days, keeps verified and recent", async () => {
  const mk = async (c, opts: { verified: boolean; ageDays: number }) => {
    const { rows } = await c.query(
      `INSERT INTO users (email, password_hash, email_verified_at, created_at)
       VALUES ($1,'x',$2, now() - ($3 || ' days')::interval) RETURNING id`,
      [`reap-${crypto.randomUUID()}@e.com`, opts.verified ? new Date() : null, String(opts.ageDays)],
    );
    return rows[0].id as string;
  };
  const ids = await withClient(env.HYPERDRIVE_FRESH, {} as ExecutionContext, async (c) => ({
    oldUnverified: await mk(c, { verified: false, ageDays: 8 }),
    recentUnverified: await mk(c, { verified: false, ageDays: 1 }),
    oldVerified: await mk(c, { verified: true, ageDays: 30 }),
  }));

  await reapUnverifiedAccounts(env, {} as ExecutionContext);

  await withClient(env.HYPERDRIVE_FRESH, {} as ExecutionContext, async (c) => {
    const present = async (id: string) => (await c.query(`SELECT 1 FROM users WHERE id=$1`, [id])).rowCount === 1;
    expect(await present(ids.oldUnverified)).toBe(false);   // reaped
    expect(await present(ids.recentUnverified)).toBe(true); // too recent
    expect(await present(ids.oldVerified)).toBe(true);      // verified
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `reap-unverified.ts`:**
```ts
import { withClient } from "../db/client";

const REAP_BATCH = 500;

/**
 * Hard-delete accounts that never verified within the grace window. Profiles /
 * media / posts cascade via ON DELETE CASCADE, freeing the squatted handle and
 * the email. Bounded so one run cannot issue an unbounded DELETE; keyed on
 * created_at age (never last-activity) so it can never reap mid-verification.
 * Returns the number reaped.
 */
export async function reapUnverifiedAccounts(env: Env, ctx: ExecutionContext): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM users
        WHERE id IN (
          SELECT id FROM users
           WHERE email_verified_at IS NULL
             AND created_at < now() - interval '7 days'
           ORDER BY created_at
           LIMIT $1
        )`,
      [REAP_BATCH],
    );
    return rowCount ?? 0;
  });
  if (n > 0) console.log(`reap-unverified: deleted ${n} account(s)`);
  return n;
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire the cron + dispatcher.** `wrangler.jsonc` triggers:
```jsonc
"triggers": { "crons": ["*/2 * * * *", "0 14 * * *", "30 3 * * *"] },
```
`index.ts` `scheduled` — add an explicit branch BEFORE the drain dispatch:
```ts
async scheduled(controller, env, ctx) {
  if (controller.cron === "30 3 * * *") {
    ctx.waitUntil(reapUnverifiedAccounts(env, ctx));
    return;
  }
  const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
  ctx.waitUntil(runEmailDrain(env, ctx, disposition));
},
```
(Import `reapUnverifiedAccounts`.)

- [ ] **Step 6: Add the test hook** in `__test.ts` (inside the `TEST_ROUTES === "1"` block, following the existing pattern):
```ts
if (request.method === "POST" && pathname === "/__test/reap-unverified") {
  const reaped = await reapUnverifiedAccounts(env, /* ctx not available here */ ctx ?? ({} as ExecutionContext));
  return new Response(JSON.stringify({ reaped }), { status: 200, headers: { "content-type": "application/json" } });
}
```
If `handleTestRoute` has no `ctx`, thread one through from `index.ts`'s `fetch` (it already has `ctx`) — a small signature change to `handleTestRoute(request, env, ctx)`; update its call site.

- [ ] **Step 7: Run the api suite + a dispatcher unit test** asserting `controller.cron === "30 3 * * *"` routes to the reaper (mock/spy per the repo's `scheduled` test style, if one exists; otherwise assert via the `__test` hook path). Expect PASS.

- [ ] **Step 8: Commit** — `git commit -m "feat(api): daily reaper for unverified accounts (7-day hard delete)"`

---

## Task 9: e2e — signup-with-handle end to end + helper migration

**Files:**
- Modify: `e2e/helpers.ts` (`signUp`, `signUpAndVerify`, delete `chooseUsername`, `publishPost`)
- Modify: `e2e/signup.spec.ts`
- Modify: every spec calling `chooseUsername`/`publishPost` (grep `e2e/*.spec.ts`)
- Test: the e2e suite itself is the test.

**Interfaces:**
- Consumes: the new signup page (Task 7) and api (Task 3).
- Produces: `signUpAndVerify(page, request, handle?)` → `{ email, username }`; `publishPost(page, post)` uses the already-signed-up handle.

- [ ] **Step 1: Update the helpers.**
- `signUp(page, email)` → `signUp(page, email, handle)`: also `page.fill('input[name="username"]', handle)`.
- `signUpAndVerify(page, request, handle = uniqueHandle("user"))`: pass `handle` into `signUp`; return `{ email, username: handle }`.
- Delete `chooseUsername` (the page is gone).
- `publishPost(page, post)`: remove the `const username = uniqueHandle("author"); await chooseUsername(...)` lines. The handle now comes from signup — read it back so the return stays accurate, e.g. `const username = (await (await page.request.get("/api/me")).json()).username;` (or accept it as a param and thread from the test). Keep the draft-then-publish flow unchanged.

- [ ] **Step 2: Update all call sites.** For each `e2e/*.spec.ts` that calls `signUpAndVerify` then `publishPost`/`chooseUsername`: drop the separate `chooseUsername` step; where a test needs the author handle, take it from `signUpAndVerify`'s `{ username }` return or `publishPost`'s `PublishedPost.username`.

- [ ] **Step 3: Add signup.spec.ts cases:**
```ts
test("signs up choosing a permanent @handle", async ({ page, request }) => {
  const { username } = await signUpAndVerify(page, request);
  // the handle is live: the author page resolves
  await page.goto(`/@${username}`);
  await expect(page).toHaveURL(new RegExp(`/@${username}$`));
});

test("rejects a handle already taken, offering suggestions", async ({ page, request, browser }) => {
  const { username } = await signUpAndVerify(page, request);
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signUp(p2, uniqueEmail("dupe"), username); // reuse the taken handle
  await expect(p2.locator("#error")).toContainText(/taken/i);
  await ctx.close();
});
```

- [ ] **Step 4: Run the e2e suite** — `pnpm test:e2e` (or the specific specs). Expected: PASS. Fix any missed call site.

- [ ] **Step 5: Commit** — `git commit -m "test(e2e): sign up with a chosen @handle; drop choose-username step"`

---

## Final (controller, after all tasks): whole-branch adversarial review

Run the whole-branch review (superpowers:requesting-code-review) over `main...handle-at-signup` before the PR. Focus areas: the signup transaction's collision→rollback→suggestions path (no user created on collision; email-dup still wins); the re-signup handle-update correctness (immutability truly locks only at verification); the reaper's cascade + batch bound + created_at keying; and that `grep -rn "username_chosen\|usernameChosen\|choose-username\|ChooseUsernameInput\|requireChosenUsername" apps packages` is empty outside the migration. Then finish via superpowers:finishing-a-development-branch (push + PR).

---

## Self-Review

**Spec coverage:** §Decisions 1–5 → Tasks 3 (handle at signup), 3 (re-signup correction window), 8 (reaper), 3+7 (collision+suggestions), 4+5+6 (full cleanup). §Components 1 → Task 1/2; 2 → Task 3; 3 → Task 2/3; 4 → Tasks 4/5/6; 5 → Task 7; 6 → Task 8. §Testing → Tasks 1–9. §Wire envelope → Task 1 (suggestions) + Task 3. No gaps.

**Placeholder scan:** every code step carries real code or an exact edit target; the two "grep first" steps (ApiErrorCode prune, username_chosen guard) are verification actions, not deferred work.

**Type consistency:** `Me = { userId, username }` used consistently (Tasks 4, 5); `suggestUsernames(client, base): Promise<string[]>` defined Task 2, consumed Task 3; `reapUnverifiedAccounts(env, ctx): Promise<number>` defined Task 8, consumed in its hook + dispatcher; `SignupInput.username` defined Task 1, consumed Task 3/7/9; `suggestions?: string[]` envelope field defined Task 1, consumed Task 3/7.

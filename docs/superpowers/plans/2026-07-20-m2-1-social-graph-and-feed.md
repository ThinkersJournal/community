# M2.1 — Social Graph & Home Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the platform from isolated public post URLs into a social graph with a personalized home feed — users choose a durable `@handle`, follow each other, see follower/following counts and lists, and read a reverse-chronological feed of posts from the people they follow.

**Architecture:** Postgres-first social graph (`follows` table) behind a single `getFolloweeIds` seam (KV-cache-ready). New `api` routes run the existing hand-rolled table router + mutating pipeline; new `web` pages follow the M1 cache discipline (anonymous-by-construction public pages, `markPrivate` authed pages). Follower counts / lists / the Follow button hydrate **client-side** (bundled Astro `<script>` islands calling same-origin `web` proxy endpoints that forward the cookie to `api`), so the public profile page stays edge-cacheable. The authed `/feed` and the anonymous `/authors` pages server-render their keyset lists (no island needed) exactly like the existing profile listing.

**Tech Stack:** Cloudflare Workers (two: `api` + `web`), Astro 7 `output:'server'` + `@astrojs/cloudflare`, `pg` (node-postgres) over dual Hyperdrive bindings, Postgres 18 (native `uuidv7()`), `node-pg-migrate` (raw-SQL), zod, vitest (`@cloudflare/vitest-pool-workers` + node project), Playwright.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the codebase and the approved spec (`docs/superpowers/specs/2026-07-19-m2-1-social-graph-and-feed-design.md`).

- **Node** `26` (`.nvmrc`), **pnpm** `9.15.9`, **TypeScript** pinned `6.0.3`, **vitest** `4.1.10`, **Playwright** `1.61.1`.
- **Postgres 18** required (`uuidv7()`). Ids: `uuidv7()` PK **only** on keyset-paginated tables (`follows`); `users`/`profiles` stay v4 (`gen_random_uuid()`).
- **DB bindings:** `HYPERDRIVE_FRESH` for **all** auth/session/permission/dup-check/read-after-write/mutation queries and every new read in this milestone. `HYPERDRIVE_CACHED` stays used in **exactly one** place (`handlePublicRecent`) — do not add a second call site (`apps/api/test/hyperdrive-binding-inventory.node.test.ts` fails if you do).
- **Mutating pipeline:** every non-GET `api` route calls `runMutatingPipeline(request, env, ctx, opts)` or is added to `PIPELINE_EXEMPT` (a reviewed security decision). `route-protection.test.ts` and `error-envelope.test.ts` import `ROUTES` and auto-cover new routes (no-Origin→403, no-session→401, `{code}` envelope).
- **Error envelope:** every non-2xx body is `{ code, message?, fields? }` built via `errorResponse(code, status, init?)`. New `code` strings live only in `packages/shared/src/errors.ts`. `message` never carries a submitted value; `fields` carries offending field **names** only.
- **Soft gate (decision #11):** verified email required to publish, follow, and choose a username. Enforced via `runMutatingPipeline(..., { requireVerifiedEmail: true })` / `requireVerifiedEmail(...)`.
- **Username onboarding gate (decision #7):** a user must have `profiles.username_chosen = true` before their **first publish or follow**. Enforced server-side in `api` (returns `USERNAME_REQUIRED`); `web` redirects to `/choose-username`.
- **Cache discipline (M1, decision #5/#6):** public pages are anonymous-by-construction (`apiFetch` **without** `request` → no Cookie forwarded). Every executable file under `apps/web/src/pages/` calls **exactly one** of `markPublicCacheable` / `markFeedCacheable` / `markPrivate` (`page-cache-inventory.test.ts`). No per-viewer state in cached HTML — viewer-specific UI hydrates client-side. Never `s-maxage`. Public pages set `setPublicPageCsp` (`script-src 'self'`, no `unsafe-inline`), so island scripts on public pages must be **bundled external modules** (an Astro `<script>` with an `import`), never inline.
- **Username format:** `^[a-z0-9_]{3,30}$`, lowercased, reserved-word protected, unique (`profiles.username` is `citext UNIQUE`), immutable once chosen. Handles live under the `/@` namespace (the `[handle]` route requires `startsWith("@")`), so a chosen handle never collides with a static route like `/login`.
- **Keyset pagination:** `WHERE <key> < $cursor ORDER BY <key> DESC LIMIT $n + 1`; the `+1` row is a next-page sentinel; `nextCursor` is the last returned id or `null` (never a cursor onto an empty page). First-page sentinel `MAX_CURSOR = "ffffffff-ffff-ffff-ffff-ffffffffffff"`. A malformed cursor throws `22P02` → `errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] })`.
- **Test commands** (verbatim): `pnpm --filter @thinkersjournal/api test`, `pnpm --filter @thinkersjournal/web test`, `pnpm --filter @thinkersjournal/shared test`, `pnpm --filter @thinkersjournal/markdown test`, `pnpm --filter @thinkersjournal/markdown run check:workerd`, `pnpm typecheck`, `pnpm test:e2e`. Migrate dev DB: `pnpm --filter @thinkersjournal/api migrate`; migrate test DB standalone: `pnpm --filter @thinkersjournal/api migrate:test` (vitest `globalSetup` also migrates `thinkersjournal_test` automatically).
- **Test file suffixes:** plain `*.test.ts` → `pool` project (real workerd, `env`/bindings). `*.db.test.ts` → `node` project (direct `pg`, schema/`information_schema`). `*.node.test.ts` → `node` project (reads real repo files). Web tests are plain-Node **source/structure** assertions + built-manifest greps — there is no in-vitest Astro render harness; runtime header/HTML behavior is proven only by E2E.
- **After changing `apps/api/wrangler.jsonc` bindings:** run `wrangler types` and commit the regenerated `apps/api/src/worker-configuration.d.ts`.

## File Structure

**New files — `packages/shared`:**
- `packages/shared/src/social.ts` — DTOs + zod input schemas for usernames, follows, feed, social reads, authors. Re-exported from `index.ts`.

**New files — `apps/api`:**
- `apps/api/migrations/0003_social_graph.sql` — `follows` table + `profiles.username_chosen`.
- `apps/api/src/routes/username.ts` — `handleChooseUsername`, `handleGetMe`, `RESERVED_USERNAMES`.
- `apps/api/src/routes/follows.ts` — `handleFollow`, `handleUnfollow`, `handleFollowStatus`.
- `apps/api/src/social/followees.ts` — `getFolloweeIds` seam (KV-cache-ready).
- `apps/api/src/routes/feed.ts` — `handleFeed`.
- `apps/api/src/routes/social-public.ts` — `handlePublicSocial`, `handlePublicFollowers`, `handlePublicFollowing`, `handlePublicAuthors`.

**Modified files — `apps/api`:**
- `apps/api/src/routes.ts` — register the 10 new routes.
- `apps/api/src/routes/posts.ts` — username-onboarding gate on the publish path.
- `apps/api/wrangler.jsonc` — add `FOLLOW_LIMITER`.
- `packages/shared/src/errors.ts` — add `USERNAME_TAKEN`, `USERNAME_ALREADY_SET`, `USERNAME_REQUIRED`, `CANNOT_FOLLOW_SELF`.

**New files — `apps/web`:**
- `apps/web/src/pages/choose-username.astro` — onboarding form (POST-back, `markPrivate`).
- `apps/web/src/pages/feed.astro` — authed home feed (`markPrivate`, server-rendered keyset).
- `apps/web/src/pages/authors.astro` — recent-authors discovery (`markFeedCacheable`, server-rendered keyset).
- `apps/web/src/pages/api/follow.ts` — `POST` proxy → `api POST /follows` (`markPrivate`).
- `apps/web/src/pages/api/unfollow.ts` — `POST` proxy → `api DELETE /follows/:id` (`markPrivate`).
- `apps/web/src/pages/api/social.ts` — `GET` proxy → counts + viewer follow-state + lists (`markPrivate`).
- `apps/web/src/scripts/social.ts` — bundled island: Follow/Unfollow button, counts, lists.

**Modified files — `apps/web`:**
- `apps/web/src/pages/[handle]/index.astro` — embed public `data-*` (profile userId/username), add the bundled social island, keep the page anonymous & cacheable.
- `apps/web/src/pages/index.astro` — home nav links to `/feed` + `/authors` for logged-in viewers.

**Modified files — `e2e`:**
- `e2e/helpers.ts` — `chooseUsername` helper; `publishPost` performs onboarding when gated.
- `e2e/social.spec.ts` — new: follow → feed → unfollow; onboarding gate.

---

## Task 1: Migration 0003 — `follows` table + `username_chosen`

**Files:**
- Create: `apps/api/migrations/0003_social_graph.sql`
- Test: `apps/api/test/follows-schema.db.test.ts`

**Interfaces:**
- Produces (schema other tasks rely on): table `follows(id uuid PK = uuidv7(), follower_id uuid FK users, followee_id uuid FK users, created_at timestamptz, UNIQUE(follower_id,followee_id), CHECK(follower_id<>followee_id))`; indexes `follows_followee_id_desc_idx (followee_id, id DESC)`, `follows_follower_id_desc_idx (follower_id, id DESC)`; column `profiles.username_chosen boolean NOT NULL DEFAULT false`.

**Design note — surrogate `id` (a deliberate refinement of the spec's `0003`):** the approved spec used composite PK `(follower_id, followee_id)`. Follower/following **lists are keyset-paginated**, which needs a single monotonic cursor column the composite key doesn't provide. So `follows` gets a `uuidv7()` surrogate `id` PK for keyset ordering, and `(follower_id, followee_id)` becomes a `UNIQUE` constraint (still the membership / idempotency / self-follow guard). This matches the "uuidv7 PK on keyset-paginated tables" convention from `0002`.

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/test/follows-schema.db.test.ts` (runs in the `node` project — direct `pg`):

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let userA: string;
let userB: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`follows-${crypto.randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  userA = await makeUser();
  userB = await makeUser();
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1)", [[userA, userB]]);
  await client.end();
});

describe("follows schema", () => {
  it("assigns a uuidv7 id (version nibble 7)", async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) RETURNING id",
      [userA, userB],
    );
    expect(rows[0]!.id[14]).toBe("7");
    await client.query("DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2", [userA, userB]);
  });

  it("rejects a self-follow (CHECK violation 23514)", async () => {
    await expect(
      client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$1)", [userA]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a duplicate (follower,followee) pair (unique violation 23505)", async () => {
    await client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [userA, userB]);
    await expect(
      client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [userA, userB]),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2", [userA, userB]);
  });

  it("cascade-deletes a follow when either user is deleted", async () => {
    const temp = await makeUser();
    await client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [userA, temp]);
    await client.query("DELETE FROM users WHERE id = $1", [temp]);
    const { rows } = await client.query(
      "SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2",
      [userA, temp],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("profiles.username_chosen", () => {
  it("defaults to false for a freshly inserted profile", async () => {
    const uid = await makeUser();
    await client.query("INSERT INTO profiles (user_id, username) VALUES ($1,$2)", [
      uid,
      `u${uid.replace(/-/g, "").slice(0, 20)}`,
    ]);
    const { rows } = await client.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id=$1",
      [uid],
    );
    expect(rows[0]!.username_chosen).toBe(false);
    await client.query("DELETE FROM users WHERE id=$1", [uid]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test follows-schema`
Expected: FAIL — `relation "follows" does not exist` / `column "username_chosen" does not exist`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/0003_social_graph.sql`:

```sql
-- Up Migration

-- Onboarding gate flag: existing system-username rows keep the default false and
-- are prompted to choose a durable handle before their next publish/follow.
ALTER TABLE profiles ADD COLUMN username_chosen boolean NOT NULL DEFAULT false;

CREATE TABLE follows (
  -- uuidv7 surrogate: the single monotonic cursor column that keyset-paginates
  -- follower/following lists (v7 ids are time-ordered, newest-first is id DESC).
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  follower_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- No self-follow, DB-enforced (an app guard alone is raceable under a pooler).
  CONSTRAINT follows_no_self CHECK (follower_id <> followee_id),
  -- Membership + idempotency (ON CONFLICT target) + "who I follow" (getFolloweeIds).
  CONSTRAINT follows_pair_unique UNIQUE (follower_id, followee_id)
);

-- "who follows X" keyset list + followers_count.
CREATE INDEX follows_followee_id_desc_idx ON follows (followee_id, id DESC);
-- "who X follows" keyset list + following_count.
CREATE INDEX follows_follower_id_desc_idx ON follows (follower_id, id DESC);

-- Down Migration
DROP TABLE IF EXISTS follows;
ALTER TABLE profiles DROP COLUMN IF EXISTS username_chosen;
```

- [ ] **Step 4: Apply the migration to the test DB and re-run**

Run: `pnpm --filter @thinkersjournal/api migrate:test && pnpm --filter @thinkersjournal/api test follows-schema`
Expected: PASS (all cases). Also apply to the dev DB for later E2E: `pnpm --filter @thinkersjournal/api migrate`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/0003_social_graph.sql apps/api/test/follows-schema.db.test.ts
git commit -m "feat(m2.1): migration 0003 — follows table + username_chosen"
```

---

## Task 2: Shared DTOs, zod schemas, and error codes

**Files:**
- Create: `packages/shared/src/social.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './social';`)
- Modify: `packages/shared/src/errors.ts` (extend `ApiErrorCode`)
- Test: `packages/shared/test/social.test.ts`

**Interfaces:**
- Produces (consumed by every later task): `ChooseUsernameInput`, `FollowInput` (zod); `USERNAME_PATTERN`; interfaces `Me`, `SocialCounts`, `FollowUser`, `FollowList`, `FollowStatusResult`, `FeedPost`, `Feed`, `AuthorSummary`, `AuthorsPage`. Error codes `USERNAME_TAKEN` (409), `USERNAME_ALREADY_SET` (409), `USERNAME_REQUIRED` (409), `CANNOT_FOLLOW_SELF` (400).

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/social.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { ChooseUsernameInput, FollowInput, USERNAME_PATTERN } from "../src/social";

describe("ChooseUsernameInput", () => {
  it("accepts a valid lowercased handle", () => {
    const parsed = ChooseUsernameInput.parse({ username: "ada_lovelace" });
    expect(parsed.username).toBe("ada_lovelace");
  });

  it("lowercases and trims before validating", () => {
    const parsed = ChooseUsernameInput.parse({ username: "  AdaLovelace  " });
    expect(parsed.username).toBe("adalovelace");
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(31)],
    ["a hyphen", "ada-lovelace"],
    ["a dot", "ada.lovelace"],
    ["a space", "ada lovelace"],
    ["unicode", "adaé"],
  ])("rejects %s", (_name, username) => {
    expect(ChooseUsernameInput.safeParse({ username }).success).toBe(false);
  });
});

describe("USERNAME_PATTERN", () => {
  it("matches 3–30 chars of [a-z0-9_]", () => {
    expect(USERNAME_PATTERN.test("abc")).toBe(true);
    expect(USERNAME_PATTERN.test("a".repeat(30))).toBe(true);
    expect(USERNAME_PATTERN.test("AB")).toBe(false);
  });
});

describe("FollowInput", () => {
  it("accepts a uuid followeeId", () => {
    const id = "018f6c1e-0000-7000-8000-000000000000";
    expect(FollowInput.parse({ followeeId: id }).followeeId).toBe(id);
  });
  it("rejects a non-uuid followeeId", () => {
    expect(FollowInput.safeParse({ followeeId: "nope" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/shared test social`
Expected: FAIL — cannot find module `../src/social`.

- [ ] **Step 3: Create the shared module**

Create `packages/shared/src/social.ts`:

```ts
/**
 * SOCIAL-GRAPH WIRE TYPES — shared by the `api` Worker (which emits them) and
 * the `web` Worker (which renders/consumes them). Public reads are anonymous
 * and viewer-independent (safe to cache); viewer-scoped shapes (Me, FollowStatus)
 * are never cached.
 */
import { z } from "zod";

/** Chosen handles: 3–30 chars of lowercase letters, digits, underscore. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

export const ChooseUsernameInput = z.object({
  // Trim + lowercase BEFORE the pattern check so "  Ada  " → "ada", and casing
  // never causes a spurious reject (profiles.username is citext-unique anyway).
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
});
export type ChooseUsernameValue = z.infer<typeof ChooseUsernameInput>;

export const FollowInput = z.object({
  followeeId: z.string().uuid(),
});
export type FollowValue = z.infer<typeof FollowInput>;

/** `GET /profile/me` — the signed-in viewer's own handle + onboarding state. */
export interface Me {
  username: string;
  usernameChosen: boolean;
}

/** `GET /public/social` — viewer-independent counts. */
export interface SocialCounts {
  followersCount: number;
  followingCount: number;
}

/** A row in a follower/following list. */
export interface FollowUser {
  username: string;
  displayName: string | null;
}

/** `GET /public/followers` / `GET /public/following` — keyset page of users. */
export interface FollowList {
  users: FollowUser[];
  /** The last follows.id on this page, or null when there are no more. */
  nextCursor: string | null;
}

/** `GET /follows/status?id=…&id=…` — the subset of ids the viewer follows. */
export interface FollowStatusResult {
  following: string[];
}

/** A feed card: a published post plus its author's handle. */
export interface FeedPost {
  id: string;
  title: string;
  slug: string;
  excerptSource: string;
  publishedAt: string;
  updatedAt: string;
  username: string;
  displayName: string | null;
}

/** `GET /feed` — keyset page of feed cards. */
export interface Feed {
  posts: FeedPost[];
  /** The last post id on this page, or null when there are no more. */
  nextCursor: string | null;
}

/** A recently-active author for the discovery page. */
export interface AuthorSummary {
  /** Public, viewer-independent — safe to embed in cached HTML for the Follow island. */
  userId: string;
  username: string;
  displayName: string | null;
  /** This author's latest published post id — also the keyset cursor. */
  latestPostId: string;
}

/** `GET /public/authors` — keyset page of recent authors. */
export interface AuthorsPage {
  authors: AuthorSummary[];
  /** The last author's latestPostId on this page, or null when there are no more. */
  nextCursor: string | null;
}
```

- [ ] **Step 4: Wire up the export and error codes**

Edit `packages/shared/src/index.ts` — add the new re-export (alphabetical, before `./timing-safe`):

```ts
export * from './cookie';
export * from './errors';
export * from './posts';
export * from './schemas';
export * from './social';
export * from './timing-safe';
```

Edit `packages/shared/src/errors.ts` — extend the `ApiErrorCode` union. Add these members (place them in the sections shown, mirroring the existing `SLUG_TAKEN`/`INVALID_INPUT` comment style):

```ts
  // --- request shape -------------------------------------------------------
  | "CANNOT_FOLLOW_SELF"      // 400 — a user cannot follow themselves (M2.1)
  // --- authorization -------------------------------------------------------
  | "USERNAME_REQUIRED"       // 409 — must choose a durable handle before publish/follow (M2.1)
  // --- resources -----------------------------------------------------------
  | "USERNAME_TAKEN"          // 409 — the requested handle is already in use (M2.1)
  | "USERNAME_ALREADY_SET"    // 409 — the handle was already chosen; it is immutable (M2.1)
```

(Insert each line adjacent to the matching existing comment banner; the union order is not significant, only that every member is present.)

- [ ] **Step 5: Run the tests + typecheck**

Run: `pnpm --filter @thinkersjournal/shared test social && pnpm --filter @thinkersjournal/shared run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/social.ts packages/shared/src/index.ts packages/shared/src/errors.ts packages/shared/test/social.test.ts
git commit -m "feat(m2.1): shared social DTOs, zod schemas, error codes"
```

---

## Task 3: API — choose username (`POST /profile/username`) + `GET /profile/me`

**Files:**
- Create: `apps/api/src/routes/username.ts`
- Modify: `apps/api/src/routes.ts` (register both routes; `POST /profile/username` literal must precede any future `/profile/:x`)
- Test: `apps/api/test/username.test.ts`

**Interfaces:**
- Consumes: `runMutatingPipeline` (`../auth/pipeline`), `readCurrentSession` (`../auth/pipeline`), `withClient` (`../db/client`), `errorResponse` (`../http/errors`), `isUniqueViolation` (`../db/errors`), `ChooseUsernameInput`, `Me` (`@thinkersjournal/shared`).
- Produces: `handleChooseUsername(request, env, ctx): Promise<Response>`, `handleGetMe(request, env, ctx): Promise<Response>`, `RESERVED_USERNAMES: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/username.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function chooseUsername(actor: Actor, username: string): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/profile/username", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ username }),
    }),
  );
}

async function usernameChosenFlag(userId: string): Promise<boolean> {
  const ctx = createExecutionContext();
  const flag = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id=$1",
      [userId],
    );
    return rows[0]!.username_chosen;
  });
  await waitOnExecutionContext(ctx);
  return flag;
}

let actor: Actor;
beforeAll(async () => { actor = await createVerifiedActor(); });
afterAll(async () => { await deleteCreatedUsers(); });

describe("POST /profile/username", () => {
  it("sets a unique handle and flips username_chosen", async () => {
    const chosen = `ada${Date.now().toString(36)}${Math.floor(0)}`.slice(0, 20);
    const unique = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const response = await chooseUsername(actor, unique);
    expect(response.status).toBe(200);
    expect(await usernameChosenFlag(actor.userId)).toBe(true);
    // avoid an unused-var lint on the illustrative `chosen`
    expect(typeof chosen).toBe("string");
  });

  it.each([
    ["too short", "ab"],
    ["a hyphen", "ada-lovelace"],
    ["uppercase-only invalid chars", "ADA!"],
  ])("400s INVALID_INPUT on %s", async (_name, username) => {
    const a = await createVerifiedActor();
    const response = await chooseUsername(a, username);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it.each(["admin", "support", "official", "staff", "thinkersjournal"])(
    "409s USERNAME_TAKEN-style reject on reserved word %s",
    async (word) => {
      const a = await createVerifiedActor();
      const response = await chooseUsername(a, word);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    },
  );

  it("409s USERNAME_TAKEN when the handle is already in use", async () => {
    const first = await createVerifiedActor();
    const taken = `dup${crypto.randomUUID().replace(/-/g, "").slice(0, 17)}`;
    expect((await chooseUsername(first, taken)).status).toBe(200);
    const second = await createVerifiedActor();
    const response = await chooseUsername(second, taken);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_TAKEN");
  });

  it("409s USERNAME_ALREADY_SET on a second choice (immutable)", async () => {
    const a = await createVerifiedActor();
    expect((await chooseUsername(a, `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`)).status).toBe(200);
    const response = await chooseUsername(a, `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_ALREADY_SET");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified user", async () => {
    const unverified = await createUnverifiedActor();
    const response = await chooseUsername(unverified, `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });
});

describe("GET /profile/me", () => {
  it("returns the handle and usernameChosen for a session", async () => {
    const a = await createVerifiedActor();
    const response = await fetchWorker(
      new Request("https://api.test/profile/me", { headers: { Cookie: a.cookie } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { username: string; usernameChosen: boolean };
    expect(body.username).toBe(a.username);
    expect(body.usernameChosen).toBe(false);
  });

  it("401s LOGIN_REQUIRED without a session", async () => {
    const response = await fetchWorker(new Request("https://api.test/profile/me"));
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test username`
Expected: FAIL — route not found (404s), no `handleChooseUsername`.

- [ ] **Step 3: Implement the handlers**

Create `apps/api/src/routes/username.ts`:

```ts
/**
 * USER-CHOSEN HANDLES. A handle is picked ONCE and is then immutable — that
 * keeps profile URLs (`/@handle`) durable without rename→301/handle-history/SEO
 * complexity. Uniqueness and immutability are enforced against the DB, not by a
 * pre-check (a transaction-mode pooler makes check-then-act a race): we attempt
 * the write and translate the constraint outcome into the wire envelope.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { errorResponse } from "../http/errors";

import { ChooseUsernameInput } from "@thinkersjournal/shared";

import type { Me } from "@thinkersjournal/shared";

/**
 * Handles that would let an account impersonate the platform or a role. Route
 * collisions are NOT the concern (handles live under `/@`); impersonation is.
 * All entries are already lowercase — the input is lowercased before this check.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "support", "help", "official", "staff", "team",
  "moderator", "mod", "root", "system", "security", "abuse", "billing",
  "thinkersjournal", "thinkers_journal", "tj", "api", "www", "mail",
  "about", "login", "logout", "signup", "settings", "me", "feed", "authors",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleChooseUsername(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const parsed = ChooseUsernameInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["username"] });
  }
  const { username } = parsed.data;

  if (RESERVED_USERNAMES.has(username)) {
    return errorResponse("INVALID_INPUT", 400, {
      message: "That handle is reserved.",
      fields: ["username"],
    });
  }

  try {
    return await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // Immutable: only flip when it has NOT already been chosen. The WHERE guard
      // makes a second attempt a no-op we can distinguish from "wrote it".
      const { rowCount } = await c.query(
        `UPDATE profiles
            SET username = $2, username_chosen = true
          WHERE user_id = $1 AND username_chosen = false`,
        [userId, username],
      );
      if (rowCount === 0) {
        // Either already chosen (immutable) — the only reason the guard fails,
        // since the row always exists for a session user.
        return errorResponse("USERNAME_ALREADY_SET", 409);
      }
      return json({ username, usernameChosen: true } satisfies Me);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return errorResponse("USERNAME_TAKEN", 409);
    throw err;
  }
}

export async function handleGetMe(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const ctx = _ctx;
  const me = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username: string; usernameChosen: boolean }>(
      `SELECT username, username_chosen AS "usernameChosen"
         FROM profiles WHERE user_id = $1`,
      [session.userId],
    );
    return rows[0] ?? null;
  });
  if (me === null) return errorResponse("NOT_FOUND", 404);
  return json(me satisfies Me);
}
```

> **Verify the `readCurrentSession` signature before implementing** (`apps/api/src/auth/pipeline.ts`): it is `readCurrentSession(env, request, onFailure)` returning `SessionData | Response`. If the real signature differs, adapt the two call sites here and in later tasks accordingly (Tasks 5 & 6 reuse it).

- [ ] **Step 4: Register the routes**

Edit `apps/api/src/routes.ts` — add the import and two route entries (place the literal `POST /profile/username` and `GET /profile/me` together; both are literal paths so ordering vs. dynamic routes is moot):

```ts
import { handleChooseUsername, handleGetMe } from "./routes/username";
```

```ts
  // Durable-handle onboarding + the viewer's own profile state (M2.1).
  { method: "POST", pattern: "/profile/username", handler: handleChooseUsername },
  { method: "GET", pattern: "/profile/me", handler: handleGetMe },
```

- [ ] **Step 5: Run the tests + full api suite (route-protection/error-envelope auto-cover the new routes)**

Run: `pnpm --filter @thinkersjournal/api test username && pnpm --filter @thinkersjournal/api test route-protection error-envelope`
Expected: PASS. (`GET /profile/me` needs no Origin/CSRF; `POST /profile/username` runs the pipeline so default-deny holds.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/username.ts apps/api/src/routes.ts apps/api/test/username.test.ts
git commit -m "feat(m2.1): api choose-username + profile/me"
```

---

## Task 4: API — follow / unfollow (`POST /follows`, `DELETE /follows/:followeeId`) + rate limiter

**Files:**
- Create: `apps/api/src/routes/follows.ts` (this task adds `handleFollow` + `handleUnfollow`; Task 5 adds `handleFollowStatus` to the same file)
- Modify: `apps/api/wrangler.jsonc` (add `FOLLOW_LIMITER`), then regenerate `apps/api/src/worker-configuration.d.ts` via `wrangler types`
- Modify: `apps/api/src/routes.ts` (register both routes)
- Test: `apps/api/test/follows.test.ts`

**Interfaces:**
- Consumes: `runMutatingPipeline`, `enforceRateLimit` (`../auth/ratelimit`), `withClient`, `errorResponse`, `isUniqueViolation` + a foreign-key predicate, `FollowInput` (`@thinkersjournal/shared`).
- Produces: `handleFollow(request, env, ctx)`, `handleUnfollow(request, env, ctx, params)`; env binding `FOLLOW_LIMITER: RateLimit`.

**Gate order in `handleFollow` (load-bearing):** pipeline (origin→session→CSRF→epoch→**verified-email**) → **rate-limit** (keyed on the session user) → **username-onboarding gate** (`username_chosen` must be true, else `USERNAME_REQUIRED`) → self-follow reject → insert.

- [ ] **Step 1: Add the rate-limiter binding**

Edit `apps/api/wrangler.jsonc` — append to the `ratelimits` array:

```jsonc
    { "name": "FOLLOW_LIMITER", "namespace_id": "1005", "simple": { "limit": 30, "period": 60 } }
```

Then regenerate types:

Run: `pnpm --filter @thinkersjournal/api exec wrangler types`
This rewrites `apps/api/src/worker-configuration.d.ts` to include `FOLLOW_LIMITER: RateLimit;`. Commit the regenerated file with this task.

Also add `FOLLOW_LIMITER` to the test bindings so the `pool` project can resolve it. Edit `apps/api/vitest.config.ts` — the `cloudflareTest` plugin reads `wrangler.jsonc`, so the `ratelimits` binding is picked up automatically; no vitest change is required. (Verify by running the suite in Step 6.)

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/follows.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A verified actor who has ALSO chosen a handle (so the onboarding gate passes). */
async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
}

function follow(actor: Actor, followeeId: string): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/follows", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ followeeId }),
    }),
  );
}

function unfollow(actor: Actor, followeeId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/follows/${followeeId}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function edgeExists(followerId: string, followeeId: string): Promise<boolean> {
  const ctx = createExecutionContext();
  const exists = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2",
      [followerId, followeeId],
    );
    return rows.length > 0;
  });
  await waitOnExecutionContext(ctx);
  return exists;
}

let alice: Actor;
let bob: Actor;
beforeAll(async () => {
  alice = await onboardedActor();
  bob = await onboardedActor();
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("POST /follows", () => {
  it("creates the edge (idempotently) and 201s", async () => {
    const r1 = await follow(alice, bob.userId);
    expect(r1.status).toBe(201);
    expect(await edgeExists(alice.userId, bob.userId)).toBe(true);
    // Idempotent: a repeat is still 201 and does not error.
    const r2 = await follow(alice, bob.userId);
    expect(r2.status).toBe(201);
  });

  it("400s CANNOT_FOLLOW_SELF", async () => {
    const response = await follow(alice, alice.userId);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("CANNOT_FOLLOW_SELF");
  });

  it("404s NOT_FOUND for a nonexistent followee", async () => {
    const response = await follow(alice, crypto.randomUUID());
    expect(response.status).toBe(404);
  });

  it("400s INVALID_INPUT for a non-uuid followeeId", async () => {
    const response = await follow(alice, "not-a-uuid");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified follower", async () => {
    const unverified = await createUnverifiedActor();
    const response = await follow(unverified, bob.userId);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("409s USERNAME_REQUIRED for a verified follower who has not chosen a handle", async () => {
    const noHandle = await createVerifiedActor(); // username_chosen stays false
    const response = await follow(noHandle, bob.userId);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
  });
});

describe("DELETE /follows/:followeeId", () => {
  it("removes the edge and 200s", async () => {
    await follow(alice, bob.userId);
    const response = await unfollow(alice, bob.userId);
    expect(response.status).toBe(200);
    expect(await edgeExists(alice.userId, bob.userId)).toBe(false);
  });

  it("is a no-op (still 200) when not following", async () => {
    const response = await unfollow(alice, bob.userId);
    expect(response.status).toBe(200);
  });

  it("400s INVALID_INPUT for a non-uuid followeeId", async () => {
    const response = await unfollow(alice, "not-a-uuid");
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test follows`
Expected: FAIL — route not found; `handleFollow` undefined.

- [ ] **Step 4: Implement the handlers**

Create `apps/api/src/routes/follows.ts`:

```ts
/**
 * FOLLOW / UNFOLLOW — the write side of the social graph. Idempotent by
 * construction: the edge is `INSERT ... ON CONFLICT DO NOTHING` and the delete
 * is unconditional, so a double-tap or a retry is never an error. Self-follow is
 * blocked in the app AND by the DB CHECK (defense in depth). The verified-email
 * soft gate and the username-onboarding gate both apply before any write.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { errorResponse } from "../http/errors";

import { FollowInput } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** true iff this user has chosen a durable handle (onboarding gate). */
async function hasChosenUsername(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.username_chosen === true;
  });
}

export async function handleFollow(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.FOLLOW_LIMITER, `follow:${userId}`);
  if (limited !== null) return limited;

  if (!(await hasChosenUsername(env, ctx, userId))) {
    return errorResponse("USERNAME_REQUIRED", 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = FollowInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["followeeId"] });
  }
  const { followeeId } = parsed.data;

  if (followeeId === userId) return errorResponse("CANNOT_FOLLOW_SELF", 400);

  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(
        `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
           ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [userId, followeeId],
      ),
    );
  } catch (err) {
    // followee_id references a nonexistent user → FK violation (23503).
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  return new Response(null, { status: 201 });
}

export async function handleUnfollow(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const followeeId = params.followeeId ?? "";
  // The router does not decode/validate the shape — reject a non-uuid before the
  // DB throws 22P02 on it (matches the public-reads cursor discipline).
  if (!UUID_RE.test(followeeId)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["followeeId"] });
  }

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [userId, followeeId]),
  );
  return new Response(null, { status: 200 });
}
```

Add the foreign-key predicate to `apps/api/src/db/errors.ts` (mirroring `isUniqueViolation`):

```ts
/** Postgres 23503 — a referenced row does not exist (e.g. following a ghost user). */
export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23503";
}
```

- [ ] **Step 5: Register the routes**

Edit `apps/api/src/routes.ts` — add the import and entries. **The literal `DELETE /follows/:followeeId` and `POST /follows` share a first segment; no dynamic-vs-literal shadowing exists (different methods).**

```ts
import { handleFollow, handleUnfollow } from "./routes/follows";
```

```ts
  // Social-graph writes (M2.1).
  { method: "POST", pattern: "/follows", handler: handleFollow },
  { method: "DELETE", pattern: "/follows/:followeeId", handler: handleUnfollow },
```

- [ ] **Step 6: Run the tests + auto-coverage suites**

Run: `pnpm --filter @thinkersjournal/api test follows route-protection error-envelope`
Expected: PASS. If `route-protection` flags `DELETE /follows/:followeeId` — confirm it runs the pipeline (it does) so no-Origin→403/no-session→401 hold.

- [ ] **Step 7: Commit**

```bash
git add apps/api/wrangler.jsonc apps/api/src/worker-configuration.d.ts apps/api/src/routes/follows.ts apps/api/src/db/errors.ts apps/api/src/routes.ts apps/api/test/follows.test.ts
git commit -m "feat(m2.1): api follow/unfollow + FOLLOW_LIMITER"
```

---

## Task 5: API — social reads (`/public/social`, `/public/followers`, `/public/following`, `/follows/status`)

**Files:**
- Create: `apps/api/src/routes/social-public.ts` (`handlePublicSocial`, `handlePublicFollowers`, `handlePublicFollowing`; `handlePublicAuthors` is added here in Task 7)
- Modify: `apps/api/src/routes/follows.ts` (add `handleFollowStatus`)
- Modify: `apps/api/src/routes.ts` (register 4 routes)
- Test: `apps/api/test/social-reads.test.ts`

**Interfaces:**
- Consumes: `withClient`, `errorResponse`, `isInvalidTextRepresentation` (`../db/errors`), `readCurrentSession`, `MAX_CURSOR`, `SocialCounts`, `FollowList`, `FollowUser`, `FollowStatusResult` (`@thinkersjournal/shared`).
- Produces: `handlePublicSocial`, `handlePublicFollowers`, `handlePublicFollowing` (anonymous, `HYPERDRIVE_FRESH`); `handleFollowStatus` (session, `HYPERDRIVE_FRESH`).

All four reads use `HYPERDRIVE_FRESH` (they change on every follow; there is no edge cache in front of the island fetches — they are `no-store`, island-consumed live).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/social-reads.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Seed a follow edge directly (bypasses the write path — this suite tests reads). */
async function seedFollow(followerId: string, followeeId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      "INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [followerId, followeeId],
    ),
  );
  await waitOnExecutionContext(ctx);
}

let star: Actor;   // followed by many
let fan: Actor;    // follows star
beforeAll(async () => {
  star = await createVerifiedActor();
  fan = await createVerifiedActor();
  await seedFollow(fan.userId, star.userId);
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("GET /public/social", () => {
  it("returns viewer-independent counts", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/social?username=${star.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { followersCount: number; followingCount: number };
    expect(body.followersCount).toBeGreaterThanOrEqual(1);
    expect(body.followingCount).toBe(0);
  });

  it("404s for an unknown username", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/social?username=nobody_xyz"));
    expect(response.status).toBe(404);
  });
});

describe("GET /public/followers", () => {
  it("lists the followers of a user (keyset)", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/followers?username=${star.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username: string }[]; nextCursor: string | null };
    expect(body.users.some((u) => u.username === fan.username)).toBe(true);
  });

  it("400s on a malformed cursor", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/followers?username=${star.username}&cursor=not-a-uuid`),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /public/following", () => {
  it("lists who a user follows", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/following?username=${fan.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username: string }[] };
    expect(body.users.some((u) => u.username === star.username)).toBe(true);
  });
});

describe("GET /follows/status", () => {
  it("returns the subset of ids the viewer follows", async () => {
    const other = await createVerifiedActor();
    const response = await fetchWorker(
      new Request(`https://api.test/follows/status?id=${star.userId}&id=${other.userId}`, {
        headers: { Cookie: fan.cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { following: string[] };
    expect(body.following).toContain(star.userId);
    expect(body.following).not.toContain(other.userId);
  });

  it("401s without a session", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/follows/status?id=${star.userId}`),
    );
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test social-reads`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement the public social reads**

Create `apps/api/src/routes/social-public.ts`:

```ts
/**
 * ANONYMOUS social reads. Like src/routes/public.ts these read NO session and
 * are viewer-independent — BUT unlike the post/profile reads they are NOT
 * edge-cached: they change on every follow and are fetched live by the profile
 * page's client-side social island (web marks them no-store). So they use
 * HYPERDRIVE_FRESH (never CACHED) and carry no cache-tag.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";

import type { FollowList, FollowUser, SocialCounts } from "@thinkersjournal/shared";

const PAGE_SIZE = 30;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function notFound(): Response {
  return errorResponse("NOT_FOUND", 404);
}

/** Resolve a handle to its user id, or null. */
async function userIdForUsername(
  env: Env,
  ctx: ExecutionContext,
  username: string,
): Promise<string | null> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ user_id: string }>(
      "SELECT user_id FROM profiles WHERE username = $1",
      [username],
    );
    return rows[0]?.user_id ?? null;
  });
}

export async function handlePublicSocial(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const username = new URL(request.url).searchParams.get("username");
  if (username === null) return notFound();
  const userId = await userIdForUsername(env, ctx, username);
  if (userId === null) return notFound();

  const counts = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ followers: string; following: string }>(
      `SELECT
         (SELECT count(*) FROM follows WHERE followee_id = $1) AS followers,
         (SELECT count(*) FROM follows WHERE follower_id = $1) AS following`,
      [userId],
    );
    // count(*) comes back as a bigint string — coerce to number.
    return {
      followersCount: Number(rows[0]!.followers),
      followingCount: Number(rows[0]!.following),
    } satisfies SocialCounts;
  });
  return json(counts);
}

/** Shared keyset list body for followers/following, parameterized by which column anchors the list. */
async function listUsers(
  env: Env,
  ctx: ExecutionContext,
  anchorColumn: "followee_id" | "follower_id",
  joinColumn: "follower_id" | "followee_id",
  username: string,
  cursorParam: string | null,
): Promise<Response> {
  const userId = await userIdForUsername(env, ctx, username);
  if (userId === null) return notFound();
  const cursor = cursorParam ?? MAX_CURSOR;

  try {
    const list = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<FollowUser & { cursorId: string }>(
        `SELECT pr.username, pr.display_name AS "displayName", f.id AS "cursorId"
           FROM follows f
           JOIN profiles pr ON pr.user_id = f.${joinColumn}
          WHERE f.${anchorColumn} = $1 AND f.id < $2
          ORDER BY f.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [userId, cursor],
      );
      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      return {
        users: page.map(({ username: u, displayName }) => ({ username: u, displayName })),
        nextCursor: hasMore ? page[page.length - 1]!.cursorId : null,
      } satisfies FollowList;
    });
    return json(list);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}

/** Who follows X: anchor on followee_id, join the follower to get their profile. */
export function handlePublicFollowers(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  if (username === null) return Promise.resolve(notFound());
  return listUsers(env, ctx, "followee_id", "follower_id", username, url.searchParams.get("cursor"));
}

/** Who X follows: anchor on follower_id, join the followee to get their profile. */
export function handlePublicFollowing(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  if (username === null) return Promise.resolve(notFound());
  return listUsers(env, ctx, "follower_id", "followee_id", username, url.searchParams.get("cursor"));
}
```

- [ ] **Step 4: Implement `handleFollowStatus` in `follows.ts`**

Add to `apps/api/src/routes/follows.ts` (import `readCurrentSession` alongside the existing pipeline import; import `errorResponse` is already present):

```ts
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
```

```ts
/**
 * GET /follows/status?id=<uuid>&id=<uuid>… — for the signed-in viewer, which of
 * the given ids they already follow. A GET (not POST) so it needs no CSRF and is
 * not held to the mutating default-deny; it authenticates via readCurrentSession.
 * Bounded so an over-long query string can't fan out an unbounded IN-list.
 */
const STATUS_MAX_IDS = 100;

export async function handleFollowStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const ids = new URL(request.url).searchParams
    .getAll("id")
    .filter((id) => UUID_RE.test(id))
    .slice(0, STATUS_MAX_IDS);

  if (ids.length === 0) {
    return new Response(JSON.stringify({ following: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const following = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ followee_id: string }>(
      `SELECT followee_id FROM follows
        WHERE follower_id = $1 AND followee_id = ANY($2::uuid[])`,
      [session.userId, ids],
    );
    return rows.map((r) => r.followee_id);
  });
  return new Response(JSON.stringify({ following }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 5: Register the four routes**

Edit `apps/api/src/routes.ts`:

```ts
import { handleFollow, handleFollowStatus, handleUnfollow } from "./routes/follows";
import {
  handlePublicFollowers,
  handlePublicFollowing,
  handlePublicSocial,
} from "./routes/social-public";
```

Registration — **`GET /follows/status` is a literal and MUST be registered; it shares no pattern conflict** (there is no `GET /follows/:x`). Add:

```ts
  { method: "GET", pattern: "/follows/status", handler: handleFollowStatus },
  { method: "GET", pattern: "/public/social", handler: handlePublicSocial },
  { method: "GET", pattern: "/public/followers", handler: handlePublicFollowers },
  { method: "GET", pattern: "/public/following", handler: handlePublicFollowing },
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @thinkersjournal/api test social-reads error-envelope route-protection`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/social-public.ts apps/api/src/routes/follows.ts apps/api/src/routes.ts apps/api/test/social-reads.test.ts
git commit -m "feat(m2.1): api social reads — counts, follower/following lists, follow-status"
```

---

## Task 6: API — the home feed (`getFolloweeIds` seam + `GET /feed`)

**Files:**
- Create: `apps/api/src/social/followees.ts` (the KV-cache-ready seam)
- Create: `apps/api/src/routes/feed.ts`
- Modify: `apps/api/src/routes.ts`
- Test: `apps/api/test/feed.test.ts`

**Interfaces:**
- Consumes: `withClient`, `readCurrentSession`, `errorResponse`, `isInvalidTextRepresentation`, `MAX_CURSOR`, `Feed`, `FeedPost` (`@thinkersjournal/shared`).
- Produces: `getFolloweeIds(client, userId): Promise<string[]>` (exported from `src/social/followees.ts`); `handleFeed(request, env, ctx)`.

**Seam contract (the roadmapped KV cache drops in HERE, no call-site change):** `getFolloweeIds` takes a live `pg` client and a user id and returns that user's followee ids. Today one indexed query; later a KV read with Postgres fallback, invalidated on follow/unfollow. See memory `m2-kv-followee-cache-roadmap`.

**Index note:** the feed query `author_id = ANY($1) AND status='published' ORDER BY id DESC` is served by the existing partial index `posts_author_published_key ON posts (author_id, id DESC) WHERE status='published'` (from migration `0002`). No new index is required.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/feed.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedFollow(followerId: string, followeeId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
      followerId,
      followeeId,
    ]),
  );
  await waitOnExecutionContext(ctx);
}

/** Insert a post directly (status controls visibility) and return its id. */
async function seedPost(authorId: string, title: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body',$4, CASE WHEN $4='published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, title, `${title}-${crypto.randomUUID()}`.slice(0, 40), status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

function getFeed(actor: Actor, cursor?: string): Promise<Response> {
  const q = cursor === undefined ? "" : `?cursor=${cursor}`;
  return fetchWorker(new Request(`https://api.test/feed${q}`, { headers: { Cookie: actor.cookie } }));
}

let viewer: Actor;
let followed: Actor;
let stranger: Actor;
beforeAll(async () => {
  viewer = await createVerifiedActor();
  followed = await createVerifiedActor();
  stranger = await createVerifiedActor();
  await seedFollow(viewer.userId, followed.userId);
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("GET /feed", () => {
  it("shows a followed author's PUBLISHED post", async () => {
    await seedPost(followed.userId, "followed-published", "published");
    const response = await getFeed(viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { posts: { username: string; title: string }[] };
    expect(body.posts.some((p) => p.username === followed.username)).toBe(true);
  });

  it("never shows a followed author's DRAFT", async () => {
    await seedPost(followed.userId, "followed-draft", "draft");
    const body = (await getFeed(viewer).then((r) => r.json())) as { posts: { title: string }[] };
    expect(body.posts.some((p) => p.title === "followed-draft")).toBe(false);
  });

  it("never shows a NON-followed author's post", async () => {
    await seedPost(stranger.userId, "stranger-published", "published");
    const body = (await getFeed(viewer).then((r) => r.json())) as { posts: { title: string }[] };
    expect(body.posts.some((p) => p.title === "stranger-published")).toBe(false);
  });

  it("returns an empty feed (not an error) for a viewer who follows no one", async () => {
    const lonely = await createVerifiedActor();
    const response = await getFeed(lonely);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: unknown[]; nextCursor: string | null };
    expect(body.posts).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("401s without a session", async () => {
    const response = await fetchWorker(new Request("https://api.test/feed"));
    expect(response.status).toBe(401);
  });

  it("400s on a malformed cursor", async () => {
    const response = await getFeed(viewer, "not-a-uuid");
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test feed`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement the seam**

Create `apps/api/src/social/followees.ts`:

```ts
/**
 * THE FOLLOWEE-GRAPH SEAM. Every feed read routes its "whose posts?" question
 * through this one function. Today it is a single indexed Postgres query; the
 * roadmapped KV followee-list cache (memory: m2-kv-followee-cache-roadmap) drops
 * in HERE — a KV read with a Postgres fallback, invalidated on follow/unfollow —
 * without touching a single feed call site. Do not inline this query elsewhere.
 */
import type { Client } from "pg";

export async function getFolloweeIds(client: Client, userId: string): Promise<string[]> {
  const { rows } = await client.query<{ followee_id: string }>(
    "SELECT followee_id FROM follows WHERE follower_id = $1",
    [userId],
  );
  return rows.map((r) => r.followee_id);
}
```

> **Verify the `pg` `Client` import path.** `apps/api/src/db/client.ts` imports `pg` as `import pg from "pg"` and types clients as `pg.Client`. Match whatever type name `withClient`'s callback parameter uses (likely `import type { Client } from "pg"` works; if the repo uses `pg.Client`, change the annotation to match). The callback in `handleFeed` passes exactly that client in.

- [ ] **Step 4: Implement the feed handler**

Create `apps/api/src/routes/feed.ts`:

```ts
/**
 * THE HOME FEED — pull-on-read, reverse-chronological, keyset-paginated. Per
 * viewer, so ALWAYS no-store and NEVER edge-cacheable (Cookie is not in the
 * cache key; a cached feed would be one viewer's graph served to everyone).
 * uuidv7 post ids are time-ordered, so ORDER BY id DESC is newest-first with no
 * created_at index — served by posts_author_published_key.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { readCurrentSession } from "../auth/pipeline";
import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { getFolloweeIds } from "../social/followees";

import type { Feed, FeedPost } from "@thinkersjournal/shared";

const PAGE_SIZE = 20;
const EXCERPT_SOURCE_CHARS = 400;

function feedJson(body: Feed): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    // Per-viewer: never stored anywhere shared.
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleFeed(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const feed = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const followeeIds = await getFolloweeIds(c, session.userId);
      if (followeeIds.length === 0) {
        return { posts: [], nextCursor: null } satisfies Feed;
      }

      const { rows } = await c.query<FeedPost>(
        `SELECT p.id, p.title, p.slug,
                left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt",
                pr.username, pr.display_name AS "displayName"
           FROM posts p
           JOIN profiles pr ON pr.user_id = p.author_id
          WHERE p.author_id = ANY($1::uuid[])
            AND p.status = 'published'
            AND p.id < $2
          ORDER BY p.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [followeeIds, cursor],
      );

      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      return {
        posts: page,
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      } satisfies Feed;
    });
    return feedJson(feed);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}
```

- [ ] **Step 5: Register the route**

Edit `apps/api/src/routes.ts`:

```ts
import { handleFeed } from "./routes/feed";
```

```ts
  // Per-viewer home feed (M2.1) — no-store, never edge-cached.
  { method: "GET", pattern: "/feed", handler: handleFeed },
```

- [ ] **Step 6: Run the tests + full api suite**

Run: `pnpm --filter @thinkersjournal/api test feed && pnpm --filter @thinkersjournal/api test`
Expected: PASS (feed suite + the whole api suite green, including `route-protection`, `error-envelope`, `hyperdrive-binding-inventory`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/social/followees.ts apps/api/src/routes/feed.ts apps/api/src/routes.ts apps/api/test/feed.test.ts
git commit -m "feat(m2.1): api home feed + getFolloweeIds seam"
```

---

## Task 7: API — recent-authors discovery (`GET /public/authors`)

**Files:**
- Modify: `apps/api/src/routes/social-public.ts` (add `handlePublicAuthors`)
- Modify: `apps/api/src/routes.ts`
- Test: `apps/api/test/authors.test.ts`

**Interfaces:**
- Consumes: `withClient`, `errorResponse`, `isInvalidTextRepresentation`, `MAX_CURSOR`, `AuthorsPage`, `AuthorSummary` (`@thinkersjournal/shared`).
- Produces: `handlePublicAuthors(request, env, ctx)` — anonymous, `HYPERDRIVE_FRESH`.

**Binding decision (documented deviation from the spec's "CACHED-eligible"):** this reads via `HYPERDRIVE_FRESH`, not `HYPERDRIVE_CACHED`. The `web` `/authors` page is edge-cached 60s via `markFeedCacheable`, so the DB is hit at most ~once/60s/PoP already; a second 60s Hyperdrive cache buys ~nothing and would require expanding the single-`CACHED`-site security exception guarded by `hyperdrive-binding-inventory.node.test.ts`. Keeping it FRESH is the conservative choice. (The spec said "eligible", not required.)

**Keyset shape:** authors are ordered by their latest published post id (a uuidv7, time-ordered). The cursor is that `latestPostId`. Query groups posts by author, takes `max(id)` as the anchor, keysets `WHERE max(id) < cursor`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/authors.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedPost(authorId: string, status: "draft" | "published"): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,'t',$2,'b',$3, CASE WHEN $3='published' THEN now() ELSE NULL END)`,
      [authorId, `s-${crypto.randomUUID()}`, status],
    ),
  );
  await waitOnExecutionContext(ctx);
}

let author: Actor;
let draftOnly: Actor;
beforeAll(async () => {
  author = await createVerifiedActor();
  draftOnly = await createVerifiedActor();
  await seedPost(author.userId, "published");
  await seedPost(draftOnly.userId, "draft");
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("GET /public/authors", () => {
  it("lists an author with a published post", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/authors"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authors: { username: string; userId: string; latestPostId: string }[] };
    expect(body.authors.some((a) => a.username === author.username)).toBe(true);
    expect(body.authors.every((a) => typeof a.latestPostId === "string")).toBe(true);
  });

  it("excludes an author with only drafts", async () => {
    const body = (await fetchWorker(new Request("https://api.test/public/authors")).then((r) => r.json())) as {
      authors: { username: string }[];
    };
    expect(body.authors.some((a) => a.username === draftOnly.username)).toBe(false);
  });

  it("400s on a malformed cursor", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/authors?cursor=not-a-uuid"));
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test authors`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement the handler**

Add to `apps/api/src/routes/social-public.ts` (extend the imports with the author types):

```ts
import type { AuthorSummary, AuthorsPage, FollowList, FollowUser, SocialCounts } from "@thinkersjournal/shared";
```

```ts
const AUTHORS_PAGE_SIZE = 24;

/**
 * Recently-active published authors, keyset by each author's LATEST published
 * post id (uuidv7 → time-ordered). An author with only drafts never appears
 * (the inner filter is status='published'). FRESH binding — the edge TTL on the
 * web /authors page is the only cache (see this route's task note).
 */
export async function handlePublicAuthors(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const pageData = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<AuthorSummary>(
        `SELECT pr.user_id AS "userId", pr.username, pr.display_name AS "displayName",
                latest.latest_post_id AS "latestPostId"
           FROM (
             SELECT author_id, max(id) AS latest_post_id
               FROM posts
              WHERE status = 'published'
              GROUP BY author_id
           ) latest
           JOIN profiles pr ON pr.user_id = latest.author_id
          WHERE latest.latest_post_id < $1
          ORDER BY latest.latest_post_id DESC
          LIMIT ${AUTHORS_PAGE_SIZE + 1}`,
        [cursor],
      );
      const hasMore = rows.length > AUTHORS_PAGE_SIZE;
      const authors = rows.slice(0, AUTHORS_PAGE_SIZE);
      return {
        authors,
        nextCursor: hasMore ? authors[authors.length - 1]!.latestPostId : null,
      } satisfies AuthorsPage;
    });
    return json(pageData);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}
```

- [ ] **Step 4: Register the route**

Edit `apps/api/src/routes.ts` — extend the `social-public` import and add the route:

```ts
import {
  handlePublicAuthors,
  handlePublicFollowers,
  handlePublicFollowing,
  handlePublicSocial,
} from "./routes/social-public";
```

```ts
  { method: "GET", pattern: "/public/authors", handler: handlePublicAuthors },
```

- [ ] **Step 5: Run the tests + the CACHED-inventory guard (must stay green)**

Run: `pnpm --filter @thinkersjournal/api test authors && pnpm --filter @thinkersjournal/api test hyperdrive-binding-inventory`
Expected: PASS — and the inventory guard still sees exactly one `HYPERDRIVE_CACHED` use (this route used FRESH).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/social-public.ts apps/api/src/routes.ts apps/api/test/authors.test.ts
git commit -m "feat(m2.1): api recent-authors discovery"
```

---

## Task 8: API — username-onboarding gate on the publish path

**Files:**
- Modify: `apps/api/src/routes/posts.ts` (gate `status='published'` on `username_chosen`)
- Test: `apps/api/test/posts.test.ts` (extend) or `apps/api/test/publish-username-gate.test.ts` (new)

**Interfaces:**
- Consumes: existing `handleCreatePost` / `handleUpdatePost`, `withClient`, `errorResponse`.
- Produces: publishing (`status: "published"`) now returns `USERNAME_REQUIRED` (409) when `profiles.username_chosen = false`. **Draft save stays ungated** (private content, no public handle needed).

**Why this modifies M1 code:** a published post appears under the author's `@handle`; per decision #7 the author must have chosen a durable handle before their first publish. Drafts remain ungated so the editor still works pre-onboarding.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/publish-username-gate.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

function post(actor: Actor, body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  return worker
    .fetch(
      new Request("https://api.test/posts", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    )
    .then(async (r) => {
      await waitOnExecutionContext(ctx);
      return r;
    });
}

async function chooseHandle(userId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [userId]),
  );
  await waitOnExecutionContext(ctx);
}

let actor: Actor;
beforeAll(async () => { actor = await createVerifiedActor(); });
afterAll(async () => { await deleteCreatedUsers(); });

describe("publish requires a chosen username", () => {
  it("lets a not-yet-onboarded user save a DRAFT", async () => {
    const response = await post(actor, { title: "Draft ok", markdownSource: "x", status: "draft" });
    expect(response.status).toBe(201);
  });

  it("blocks PUBLISH with USERNAME_REQUIRED before onboarding", async () => {
    const response = await post(actor, { title: "Pub blocked", markdownSource: "x", status: "published" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
  });

  it("allows PUBLISH after a handle is chosen", async () => {
    await chooseHandle(actor.userId);
    const response = await post(actor, { title: "Pub ok", markdownSource: "x", status: "published" });
    expect(response.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/api test publish-username-gate`
Expected: FAIL — publish currently 201s regardless of `username_chosen`.

- [ ] **Step 3: Add the gate to the publish path**

In `apps/api/src/routes/posts.ts`, locate where `handleCreatePost` and `handleUpdatePost` decide the post is being **published** (after the pipeline + input parse, where `status === "published"` is known). Add a helper and call it on the publish branch of BOTH handlers, before the INSERT/UPDATE:

```ts
/** The onboarding gate: a public post needs a durable @handle. Drafts are exempt. */
async function requireChosenUsername(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<Response | null> {
  const chosen = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.username_chosen === true;
  });
  return chosen ? null : errorResponse("USERNAME_REQUIRED", 409);
}
```

Then, in each handler, immediately after the parsed input shows `status === "published"` and before writing:

```ts
if (parsed.data.status === "published") {
  const gate = await requireChosenUsername(env, ctx, authorId);
  if (gate !== null) return gate;
}
```

> **Match the handlers' existing variable names.** Use whatever the handler calls the session user id (the API report shows `authorId = result.session.userId` in `handleCreatePost`) and the parsed body (`parsed.data` / a `status` local). If `handleUpdatePost` reads the existing row first, place the gate on the branch where the *incoming* status is `published`. Do not gate a draft→draft or published→published-metadata edit differently: gate whenever the resulting status is `published` and `username_chosen` is false.

- [ ] **Step 4: Run the tests (gate + existing posts suite + e2e-relevant regressions)**

Run: `pnpm --filter @thinkersjournal/api test publish-username-gate posts`
Expected: PASS. **The existing `posts.test.ts` may now fail** where it publishes with an actor whose `username_chosen` is false — if so, update those cases to choose a handle first (set `username_chosen=true` via a direct UPDATE in the test's `beforeAll`, mirroring `onboardedActor()` from Task 4). This is expected fallout of the new gate; fix the fixtures, do not weaken the gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/posts.ts apps/api/test/publish-username-gate.test.ts apps/api/test/posts.test.ts
git commit -m "feat(m2.1): gate first publish on chosen username"
```

---

## Web tasks — shared conventions (read before Tasks 9–13)

- **Cache-context calls (verbatim from the repo):** In an `.astro` **page**, pass `Astro` directly — `markPrivate(Astro)`, `markFeedCacheable(Astro)`, `markPublicCacheable(Astro, tags)` (AstroGlobal has `.request`/`.response`/`.cache`). In a `.ts` **APIRoute**, `APIContext` has **no** `.response`, so wrap: `markPrivate({ request: context.request, response: { headers }, cache: context.cache })` (the `media-upload.ts` / `internal/purge.ts` idiom).
- **`apiFetch` (`../lib/api` / `../../lib/api` by depth):** anonymous read → **omit** `request`. Authed call → pass `{ request: context.request /* or Astro.request */, origin: <that request>.headers.get("Origin") ?? "", csrfToken }`. After any authed call, `applyCookies(headers, response.setCookies)` onto the outgoing headers. Branch on `apiErrorCode(response)` (the `{code}` value), never status alone.
- **CSP & islands:** public/cacheable pages call `setPublicPageCsp(Astro)` (`script-src 'self'`). Interactive scripts there must be **bundled** Astro `<script>` blocks that contain an `import` (Astro externalizes them to `/_astro/*.js`, served from `'self'`). Never inline JS on a CSP page.
- **The page-cache-inventory guard** (`page-cache-inventory.test.ts`): every new executable file under `src/pages/` must call **exactly one** cache helper. No inventory list to edit — the file is covered the moment it exists.
- **Web tests are source/structure** (`readFileSync` + `stripComments` + regex/`toContain`) plus built-manifest greps (`it.skipIf(!existsSync(dist/server/entry.mjs))`). There is no in-vitest render. Every negative assertion is preceded by a positive one (anti-vacuity), per the repo convention.
- **The `web` proxy endpoints below live under `src/pages/api/`.** `api/` is a normal Astro route segment here (it does not clash with the `api` Worker — that is reached only over the Service Binding). These give the browser islands a same-origin authed hop, exactly like `/media-upload`.

---

## Task 9: Web — `/choose-username` onboarding page

**Files:**
- Create: `apps/web/src/pages/choose-username.astro`
- Test: `apps/web/test/choose-username-page.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `apiErrorCode`, `applyCookies` (`../lib/api`), `markPrivate` (`../lib/cache`), `Me` (`@thinkersjournal/shared`).
- Produces: a POST-back form page that sets the viewer's handle via `api POST /profile/username` and redirects to `/feed` on success.

**Behavior:** GET → if `GET /profile/me` shows `usernameChosen === true`, redirect to `/feed` (nothing to do); else render the form (needs a live session — if `/profile/me` 401s, render a "log in first" link). POST → submit `{ username }` with cookie+origin+CSRF; on 200 redirect to `/feed`; on `INVALID_INPUT` show "invalid or reserved handle"; on `USERNAME_TAKEN` show "that handle is taken"; on `USERNAME_ALREADY_SET` redirect to `/feed`; on `EMAIL_NOT_VERIFIED` link to resend-verification.

- [ ] **Step 1: Write the failing source/structure test**

Create `apps/web/test/choose-username-page.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/choose-username.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("choose-username.astro", () => {
  it("declares its cacheability via markPrivate (never cacheable — it is authed)", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("posts the chosen handle to the api username route with the CSRF token", () => {
    expect(code).toContain("/profile/username");
    expect(code).toMatch(/csrfToken/);
  });

  it("forwards the browser cookie on its api calls (it is an authed page)", () => {
    expect(code).toMatch(/request:\s*Astro\.request/);
  });

  it("branches on the api error codes, not raw status", () => {
    expect(code).toContain("USERNAME_TAKEN");
    expect(code).toContain("apiErrorCode(");
  });

  it("redirects to /feed on success", () => {
    expect(code).toMatch(/redirect\(["']\/feed["']\)/);
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /choose-username route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/choose-username"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test choose-username-page`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the page**

Create `apps/web/src/pages/choose-username.astro`:

```astro
---
import { apiErrorCode, apiFetch, applyCookies } from "../lib/api";
import { markPrivate } from "../lib/cache";

import type { Me } from "@thinkersjournal/shared";

// Authed page — never cacheable. Declares exactly one cache helper.
markPrivate(Astro);

// A CSRF token proves a live session; null means "not logged in".
const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: Astro.request });
const csrfToken = csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null;

let error: string | null = null;

if (csrfToken !== null) {
  // Already onboarded? Nothing to do here.
  const me = await apiFetch<Me>("/profile/me", { request: Astro.request });
  if (me.status === 200 && me.data?.usernameChosen === true) {
    return Astro.redirect("/feed");
  }

  if (Astro.request.method === "POST") {
    const form = await Astro.request.formData();
    const username = String(form.get("username") ?? "");
    const submittedToken = String(form.get("csrfToken") ?? "");

    const response = await apiFetch<Me>("/profile/username", {
      method: "POST",
      body: { username },
      request: Astro.request,
      origin: Astro.request.headers.get("Origin") ?? "",
      csrfToken: submittedToken,
    });
    applyCookies(Astro.response.headers, response.setCookies);

    if (response.status === 200) return Astro.redirect("/feed");

    switch (apiErrorCode(response)) {
      case "USERNAME_TAKEN":
        error = "That handle is already taken — try another.";
        break;
      case "USERNAME_ALREADY_SET":
        return Astro.redirect("/feed");
      case "EMAIL_NOT_VERIFIED":
        error = "Please verify your email before choosing a handle.";
        break;
      default:
        error = "That handle isn’t valid. Use 3–30 lowercase letters, numbers, or underscores.";
    }
  }
}
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Choose your handle — Thinker’s Journal</title>
  </head>
  <body>
    <main>
      <h1>Choose your handle</h1>
      {csrfToken === null ? (
        <p>You need to <a href="/login">log in</a> to choose a handle.</p>
      ) : (
        <>
          <p>Pick a permanent <code>@handle</code> — 3–30 lowercase letters, numbers, or underscores. This can’t be changed later.</p>
          {error && <p id="error" role="alert">{error}</p>}
          <form method="POST">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <label for="username">Handle</label>
            <input id="username" name="username" required minlength="3" maxlength="30"
                   pattern="[a-z0-9_]{3,30}" autocapitalize="none" autocomplete="off" />
            <button type="submit">Claim handle</button>
          </form>
        </>
      )}
    </main>
  </body>
</html>
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm --filter @thinkersjournal/web test choose-username-page && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS (source assertions); typecheck clean. (The built-manifest case skips until a build runs.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/choose-username.astro apps/web/test/choose-username-page.test.ts
git commit -m "feat(m2.1): web choose-username onboarding page"
```

---

## Task 10: Web — social proxy endpoints (`/api/follow`, `/api/unfollow`, `/api/social`)

**Files:**
- Create: `apps/web/src/pages/api/follow.ts`
- Create: `apps/web/src/pages/api/unfollow.ts`
- Create: `apps/web/src/pages/api/social.ts`
- Test: `apps/web/test/social-proxies.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `applyCookies` (`../../lib/api`), `markPrivate` (`../../lib/cache`).
- Produces (browser-facing, same-origin):
  - `POST /api/follow` body `{followeeId}` → forwards to `api POST /follows`.
  - `POST /api/unfollow` body `{followeeId}` → forwards to `api DELETE /follows/:followeeId`.
  - `GET /api/social` — three modes: `?status=id1,id2,…` → `{following, viewerLoggedIn, csrfToken}`; `?counts=<username>` → `{followersCount, followingCount}`; `?list=followers|following&username=X&cursor=` → `FollowList`.
- All three call `markPrivate({ request, response: { headers }, cache })` (per-viewer, never cached).

**CSRF for islands:** the profile/authors pages are cached & anonymous, so they cannot embed a per-session CSRF token. `GET /api/social?status=…` returns the token (via `api GET /auth/csrf`) when logged in; the island holds it and echoes it as `X-CSRF-Token` to `/api/follow`/`/api/unfollow`. This is the standard double-submit flow (the session cookie stays HttpOnly; only the CSRF token is JS-readable, by design).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/social-proxies.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../src/pages/api");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe.each([
  ["follow.ts", "POST", "/follows"],
  ["unfollow.ts", "DELETE", "/follows/"],
  ["social.ts", "GET", "/public/social"],
])("%s", (file, method, apiPath) => {
  const code = stripComments(readFileSync(join(DIR, file), "utf8"));

  it(`exports the ${method} APIRoute`, () => {
    expect(code).toMatch(new RegExp(`export const ${method}\\s*:\\s*APIRoute`));
  });

  it("declares prerender = false", () => {
    expect(code).toContain("export const prerender = false");
  });

  it("marks itself private (per-viewer, never cached) with the wrapped context", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toMatch(/response:\s*\{\s*headers\s*\}/);
  });

  it(`proxies to the api path ${apiPath}`, () => {
    expect(code).toContain(apiPath);
  });

  it("forwards the browser cookie to the api (authed hop)", () => {
    expect(code).toMatch(/request:\s*context\.request/);
  });
});

describe("mutating proxies forward the CSRF token + origin", () => {
  it.each(["follow.ts", "unfollow.ts"])("%s echoes X-CSRF-Token and Origin", (file) => {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    expect(code).toMatch(/csrfToken/);
    expect(code).toMatch(/origin/i);
    expect(code).toContain("applyCookies(");
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains all three /api/* routes", () => {
    const entry = readFileSync(SERVER_ENTRY, "utf8");
    expect(entry).toContain('"route":"/api/follow"');
    expect(entry).toContain('"route":"/api/unfollow"');
    expect(entry).toContain('"route":"/api/social"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test social-proxies`
Expected: FAIL — files do not exist.

- [ ] **Step 3: Implement the mutating proxies**

Create `apps/web/src/pages/api/follow.ts`:

```ts
/**
 * BROWSER → api authed hop for FOLLOW. Same pattern as /media-upload: the
 * island fetches this same-origin endpoint, which forwards the HttpOnly session
 * cookie + the browser's Origin + the double-submit CSRF token to the api over
 * the Service Binding. Never cached (markPrivate).
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let followeeId = "";
  try {
    const body = (await context.request.json()) as { followeeId?: unknown };
    followeeId = typeof body.followeeId === "string" ? body.followeeId : "";
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>("/follows", {
    method: "POST",
    body: { followeeId },
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};
```

Create `apps/web/src/pages/api/unfollow.ts`:

```ts
/**
 * BROWSER → api authed hop for UNFOLLOW. Forwards to DELETE /follows/:id.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let followeeId = "";
  try {
    const body = (await context.request.json()) as { followeeId?: unknown };
    followeeId = typeof body.followeeId === "string" ? body.followeeId : "";
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }
  if (!UUID_RE.test(followeeId)) {
    return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>(`/follows/${encodeURIComponent(followeeId)}`, {
    method: "DELETE",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};
```

- [ ] **Step 4: Implement the read proxy**

Create `apps/web/src/pages/api/social.ts`:

```ts
/**
 * BROWSER read hop for the social island. Three modes:
 *   ?status=id,id,…            → { following, viewerLoggedIn, csrfToken }  (per-viewer)
 *   ?counts=<username>         → { followersCount, followingCount }        (public)
 *   ?list=followers|following&username=X&cursor=  → FollowList             (public)
 * Never cached (markPrivate) — the profile/authors pages that consume it ARE
 * cached, so their viewer-specific bits must be fetched live from here.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { FollowStatusResult, SocialCounts } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const url = new URL(context.request.url);
  const status = url.searchParams.get("status");
  const counts = url.searchParams.get("counts");
  const list = url.searchParams.get("list");

  // Mode 1: per-viewer follow-status + CSRF token for subsequent mutations.
  if (status !== null) {
    const idsQuery = status
      .split(",")
      .filter((s) => s.length > 0)
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join("&");
    const statusResp = await apiFetch<FollowStatusResult>(`/follows/status?${idsQuery}`, {
      request: context.request,
    });
    if (statusResp.status !== 200) {
      // 401 → not logged in: buttons render as "Follow" that prompt login on click.
      return new Response(JSON.stringify({ following: [], viewerLoggedIn: false, csrfToken: null }), {
        status: 200,
        headers,
      });
    }
    const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
    return new Response(
      JSON.stringify({
        following: statusResp.data?.following ?? [],
        viewerLoggedIn: true,
        csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
      }),
      { status: 200, headers },
    );
  }

  // Mode 2: public counts.
  if (counts !== null) {
    const resp = await apiFetch<SocialCounts>(`/public/social?username=${encodeURIComponent(counts)}`);
    return new Response(resp.text, { status: resp.status, headers });
  }

  // Mode 3: public follower/following list.
  if (list === "followers" || list === "following") {
    const username = url.searchParams.get("username") ?? "";
    const cursor = url.searchParams.get("cursor");
    const q = new URLSearchParams({ username });
    if (cursor !== null) q.set("cursor", cursor);
    const resp = await apiFetch<unknown>(`/public/${list}?${q.toString()}`);
    return new Response(resp.text, { status: resp.status, headers });
  }

  return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
};
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `pnpm --filter @thinkersjournal/web test social-proxies && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/api/follow.ts apps/web/src/pages/api/unfollow.ts apps/web/src/pages/api/social.ts apps/web/test/social-proxies.test.ts
git commit -m "feat(m2.1): web social proxy endpoints"
```

---

## Task 11: Web — profile social island (Follow button, counts, lists)

**Files:**
- Create: `apps/web/src/scripts/social.ts` (the bundled client island)
- Modify: `apps/web/src/pages/[handle]/index.astro` (embed viewer-independent `data-*`, mount the island, keep the page anonymous & cacheable)
- Test: `apps/web/test/social-island.test.ts`

**Interfaces:**
- Consumes (browser globals only): `fetch`, `document`. Talks to `/api/social`, `/api/follow`, `/api/unfollow`.
- Produces: `initSocialIsland(): void` — scans the page for `[data-follow-btn]` (each with `data-user-id`) and an optional `[data-social-counts]` (with `data-username`), hydrates counts + follow-state, wires follow/unfollow.

**Cacheability invariant (do not break):** the profile page stays `markPublicCacheable` and anonymous-by-construction. The only new server-rendered data is the **profile owner's** `userId`/`username` (viewer-independent → safe in shared HTML). Counts, the Follow button's state, and lists are fetched **client-side** by the island — never in the SSR HTML.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/social-island.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PROFILE = join(import.meta.dirname, "../src/pages/[handle]/index.astro");
const ISLAND = join(import.meta.dirname, "../src/scripts/social.ts");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const profileCode = stripComments(readFileSync(PROFILE, "utf8"));
const islandExists = existsSync(ISLAND);

describe("profile page keeps the M1 cache discipline while mounting the island", () => {
  it("still declares exactly one cache helper: markPublicCacheable", () => {
    expect(profileCode).toContain("markPublicCacheable(Astro,");
    expect(profileCode).not.toContain("markPrivate(");
    expect(profileCode).not.toContain("markFeedCacheable(");
  });

  it("its /public/profile fetch stays anonymous (no request forwarded)", () => {
    const call = /apiFetch<[^;]*\/public\/profile[^;]*\);/.exec(profileCode);
    expect(call, "profile page no longer fetches /public/profile").not.toBeNull();
    expect(call![0]).not.toMatch(/request:/);
  });

  it("embeds only the profile OWNER's viewer-independent ids for the island", () => {
    // Positive: the island mount point carries the owner's public id + handle.
    expect(profileCode).toMatch(/data-user-id=\{profile\.userId\}/);
    expect(profileCode).toMatch(/data-username=\{profile\.username\}/);
  });

  it("mounts the island as a BUNDLED module (an import), not inline JS", () => {
    // A <script> containing an import → Astro externalizes it → satisfies script-src 'self'.
    expect(profileCode).toMatch(/import\s+\{\s*initSocialIsland\s*\}\s+from\s+["']\.\.\/\.\.\/scripts\/social["']/);
  });
});

describe("the island module", () => {
  it("exists and talks only to same-origin /api/* endpoints", () => {
    expect(islandExists).toBe(true);
    const island = stripComments(readFileSync(ISLAND, "utf8"));
    expect(island).toContain("/api/social");
    expect(island).toContain("/api/follow");
    expect(island).toContain("/api/unfollow");
    // Never reaches the api Worker directly (it has no public origin).
    expect(island).not.toMatch(/https?:\/\//);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test social-island`
Expected: FAIL — island missing; profile page has no mount point.

- [ ] **Step 3: Implement the island**

Create `apps/web/src/scripts/social.ts`:

```ts
/**
 * THE SOCIAL ISLAND — hydrates viewer-specific social UI onto CACHED, anonymous
 * pages (profile, authors). The page HTML is shared across all viewers, so this
 * runs client-side: it reads follow-state, follower counts, and the CSRF token
 * live from same-origin /api/* proxies, then renders the Follow button + counts.
 * Talks ONLY to same-origin endpoints (the api Worker has no public origin).
 */
interface StatusResponse {
  following: string[];
  viewerLoggedIn: boolean;
  csrfToken: string | null;
}

let csrfToken: string | null = null;

async function loadStatus(userIds: string[]): Promise<StatusResponse> {
  if (userIds.length === 0) return { following: [], viewerLoggedIn: false, csrfToken: null };
  const resp = await fetch(`/api/social?status=${encodeURIComponent(userIds.join(","))}`);
  if (!resp.ok) return { following: [], viewerLoggedIn: false, csrfToken: null };
  return (await resp.json()) as StatusResponse;
}

async function loadCounts(username: string): Promise<{ followersCount: number; followingCount: number } | null> {
  const resp = await fetch(`/api/social?counts=${encodeURIComponent(username)}`);
  if (!resp.ok) return null;
  return (await resp.json()) as { followersCount: number; followingCount: number };
}

function renderButton(btn: HTMLElement, following: boolean): void {
  btn.textContent = following ? "Unfollow" : "Follow";
  btn.dataset.following = following ? "true" : "false";
  btn.hidden = false;
}

async function toggleFollow(btn: HTMLButtonElement): Promise<void> {
  const followeeId = btn.dataset.userId ?? "";
  const following = btn.dataset.following === "true";
  if (csrfToken === null) {
    // Not logged in — send the viewer to log in, then back here.
    window.location.href = "/login";
    return;
  }
  btn.disabled = true;
  const endpoint = following ? "/api/unfollow" : "/api/follow";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ followeeId }),
  });
  btn.disabled = false;
  if (resp.ok) renderButton(btn, !following);
}

export function initSocialIsland(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-follow-btn]"));
  const counts = document.querySelector<HTMLElement>("[data-social-counts]");

  // Counts (public, viewer-independent) — fetched live so the cached HTML carries none.
  if (counts?.dataset.username) {
    void loadCounts(counts.dataset.username).then((c) => {
      if (c === null) return;
      const f = counts.querySelector<HTMLElement>("[data-followers-count]");
      const g = counts.querySelector<HTMLElement>("[data-following-count]");
      if (f) f.textContent = String(c.followersCount);
      if (g) g.textContent = String(c.followingCount);
    });
  }

  // Follow buttons (per-viewer) — one batched status call for all targets.
  if (buttons.length > 0) {
    const ids = buttons.map((b) => b.dataset.userId ?? "").filter((id) => id.length > 0);
    void loadStatus(ids).then((status) => {
      csrfToken = status.csrfToken;
      for (const btn of buttons) {
        const id = btn.dataset.userId ?? "";
        if (!status.viewerLoggedIn) {
          // Show a Follow button that will route to /login on click.
          renderButton(btn, false);
        } else if (btn.dataset.self === "true") {
          btn.hidden = true; // no self-follow affordance
        } else {
          renderButton(btn, status.following.includes(id));
        }
        btn.addEventListener("click", () => void toggleFollow(btn));
      }
    });
  }
}
```

- [ ] **Step 4: Wire the island into the profile page**

Edit `apps/web/src/pages/[handle]/index.astro`. **Keep every existing line** (the anonymous `/public/profile` fetch, `markPublicCacheable(Astro, [...])`, `setPublicPageCsp(Astro)`, the RSS `<link>`). Add, in the rendered body (near the profile header), the counts container + Follow button mount point, then mount the island at the end of `<body>`:

```astro
<!-- Social: hydrated client-side (cached HTML carries no viewer state). -->
<section data-social-counts data-username={profile.username}>
  <span><strong data-followers-count>—</strong> followers</span>
  <span><strong data-following-count>—</strong> following</span>
</section>
<button data-follow-btn data-user-id={profile.userId} hidden>Follow</button>

<script>
  import { initSocialIsland } from "../../scripts/social";
  initSocialIsland();
</script>
```

> The `<button>` is `hidden` in SSR and revealed by the island only for a logged-in, non-self viewer. `data-user-id={profile.userId}` is the profile OWNER's id (viewer-independent) — safe in cached HTML. Do NOT render counts or follow-state values server-side.

- [ ] **Step 5: Run the tests + typecheck + the existing profile-page tripwires**

Run: `pnpm --filter @thinkersjournal/web test social-island profile-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS — the island is present, the profile page still declares exactly one cache helper and keeps its anonymous `/public/profile` fetch.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/scripts/social.ts "apps/web/src/pages/[handle]/index.astro" apps/web/test/social-island.test.ts
git commit -m "feat(m2.1): web profile follow island (button, counts)"
```

---

## Task 12: Web — the home feed page (`/feed`)

**Files:**
- Create: `apps/web/src/pages/feed.astro`
- Test: `apps/web/test/home-feed-page.test.ts` (named to avoid confusion with the existing `feed-pages.test.ts`, which covers `sitemap.xml`/`rss.xml`)

**Interfaces:**
- Consumes: `apiFetch`, `applyCookies` (`../lib/api`), `markPrivate` (`../lib/cache`), `Feed` (`@thinkersjournal/shared`).
- Produces: an authed, server-rendered, keyset-paginated feed. `markPrivate` (never cacheable). No island — the page is per-viewer and uncached, so it renders viewer content server-side (like the author's own editor), paging via a plain `?cursor=` link.

**Behavior:** forward the cookie to `api GET /feed?cursor=`. On 401 → `Astro.redirect("/login")` (carry any cleared cookie via `applyCookies`). Render each `FeedPost` as a card (title links to `/@username/slug`, shows `@username`, a text excerpt, the date). Empty feed → a message linking to `/authors`. `nextCursor !== null` → an "Older posts" link to `/feed?cursor=<nextCursor>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/home-feed-page.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/feed.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("feed.astro", () => {
  it("declares markPrivate (per-viewer, never cacheable) and nothing else", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("forwards the browser cookie to /feed (it is per-viewer)", () => {
    const call = /apiFetch<[^;]*\/feed[^;]*\);/.exec(code);
    expect(call, "feed page does not call /feed").not.toBeNull();
    expect(call![0]).toMatch(/request:\s*Astro\.request/);
  });

  it("redirects a logged-out viewer to /login", () => {
    expect(code).toMatch(/redirect\(["']\/login["']\)/);
  });

  it("links its empty state to /authors discovery", () => {
    expect(code).toContain("/authors");
  });

  it("pages older posts via a ?cursor= link", () => {
    expect(code).toMatch(/\/feed\?cursor=/);
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /feed route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/feed"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test home-feed-page`
Expected: FAIL — file missing.

- [ ] **Step 3: Implement the page**

Create `apps/web/src/pages/feed.astro`:

```astro
---
import { apiFetch, applyCookies } from "../lib/api";
import { markPrivate } from "../lib/cache";

import type { Feed } from "@thinkersjournal/shared";

// Per-viewer, uncached.
markPrivate(Astro);

const cursor = Astro.url.searchParams.get("cursor");
const path = cursor === null ? "/feed" : `/feed?cursor=${encodeURIComponent(cursor)}`;

const response = await apiFetch<Feed>(path, { request: Astro.request });
applyCookies(Astro.response.headers, response.setCookies);

// No session (or stale) → the api answered 401; send them to log in.
if (response.status === 401) return Astro.redirect("/login");

const feed: Feed = response.data ?? { posts: [], nextCursor: null };
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your feed — Thinker’s Journal</title>
  </head>
  <body>
    <main>
      <h1>Your feed</h1>
      {feed.posts.length === 0 ? (
        <p>Your feed is empty. <a href="/authors">Discover authors to follow →</a></p>
      ) : (
        <ul>
          {feed.posts.map((post) => (
            <li>
              <h2><a href={`/@${post.username}/${post.slug}`}>{post.title}</a></h2>
              <p>by <a href={`/@${post.username}`}>@{post.username}</a> · <time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></p>
              <p>{post.excerptSource.slice(0, 200)}</p>
            </li>
          ))}
        </ul>
      )}
      {feed.nextCursor !== null && (
        <a rel="next" href={`/feed?cursor=${encodeURIComponent(feed.nextCursor)}`}>Older posts →</a>
      )}
    </main>
  </body>
</html>
```

- [ ] **Step 4: Run the test + typecheck + inventory**

Run: `pnpm --filter @thinkersjournal/web test home-feed-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/feed.astro apps/web/test/home-feed-page.test.ts
git commit -m "feat(m2.1): web home feed page"
```

---

## Task 13: Web — recent-authors discovery page (`/authors`) + home nav links

**Files:**
- Create: `apps/web/src/pages/authors.astro`
- Modify: `apps/web/src/pages/index.astro` (add `/authors` + `/feed` nav links)
- Test: `apps/web/test/authors-page.test.ts`

**Interfaces:**
- Consumes: `apiFetch` (`../lib/api`, **anonymous** — no `request`), `markFeedCacheable` (`../lib/cache`), `setPublicPageCsp` (`../lib/csp`), `initSocialIsland` (`../scripts/social`), `AuthorsPage` (`@thinkersjournal/shared`).
- Produces: an anonymous, edge-cacheable (60s, untagged) discovery page. Follow buttons are the same island as the profile page (hydrated client-side), so the HTML stays viewer-independent and cacheable.

**Behavior:** anonymous `apiFetch("/public/authors?cursor=")` (no cookie). Render each author (link to `/@username`, `displayName`) with a `[data-follow-btn] data-user-id={author.userId}` button (island hydrates state). `setPublicPageCsp(Astro)` because the page carries the bundled island script. `nextCursor !== null` → a "More" link to `/authors?cursor=`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/authors-page.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/authors.astro");
const HOME = join(import.meta.dirname, "../src/pages/index.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("authors.astro", () => {
  it("declares markFeedCacheable (short-TTL, untagged) and nothing else", () => {
    expect(code).toContain("markFeedCacheable(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markPrivate(");
  });

  it("⚠️ is ANONYMOUS by construction — its /public/authors fetch forwards no cookie", () => {
    const call = /apiFetch<[^;]*\/public\/authors[^;]*\);/.exec(code);
    expect(call, "authors page does not call /public/authors").not.toBeNull();
    expect(call![0]).not.toMatch(/request:/);
  });

  it("sets a CSP (it carries the bundled follow island)", () => {
    expect(code).toContain("setPublicPageCsp(");
  });

  it("renders a follow button per author (island hydrates state) and mounts the island", () => {
    expect(code).toMatch(/data-follow-btn/);
    expect(code).toMatch(/data-user-id=\{author\.userId\}/);
    expect(code).toMatch(/import\s+\{\s*initSocialIsland\s*\}\s+from\s+["']\.\.\/scripts\/social["']/);
  });

  it("pages via a ?cursor= link", () => {
    expect(code).toMatch(/\/authors\?cursor=/);
  });
});

describe("home page nav (index.astro)", () => {
  const home = stripComments(readFileSync(HOME, "utf8"));
  it("links to /authors and /feed", () => {
    expect(home).toContain('href="/authors"');
    expect(home).toContain('href="/feed"');
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /authors route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/authors"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test authors-page`
Expected: FAIL — authors page missing; home page lacks the links.

- [ ] **Step 3: Implement the authors page**

Create `apps/web/src/pages/authors.astro`:

```astro
---
import { apiFetch } from "../lib/api";
import { markFeedCacheable } from "../lib/cache";
import { setPublicPageCsp } from "../lib/csp";

import type { AuthorsPage } from "@thinkersjournal/shared";

const cursor = Astro.url.searchParams.get("cursor");
const query = new URLSearchParams();
if (cursor !== null) query.set("cursor", cursor);

// ⚠️ ANONYMOUS — no `request`. The list is viewer-independent; follow-state
// hydrates client-side via the island, so this HTML is shared across viewers.
const path = query.toString() === "" ? "/public/authors" : `/public/authors?${query.toString()}`;
const response = await apiFetch<AuthorsPage>(path);

const page: AuthorsPage = response.status === 200 && response.data !== null
  ? response.data
  : { authors: [], nextCursor: null };

// Short-TTL, untagged edge cache (same class as sitemap/rss). CSP for the island.
markFeedCacheable(Astro);
setPublicPageCsp(Astro);
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Recent authors — Thinker’s Journal</title>
  </head>
  <body>
    <main>
      <h1>Recent authors</h1>
      {page.authors.length === 0 ? (
        <p>No authors yet — be the first to <a href="/new-post">publish</a>.</p>
      ) : (
        <ul>
          {page.authors.map((author) => (
            <li>
              <a href={`/@${author.username}`}>{author.displayName ?? `@${author.username}`}</a>
              <span> @{author.username}</span>
              <button data-follow-btn data-user-id={author.userId} hidden>Follow</button>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor !== null && (
        <a rel="next" href={`/authors?cursor=${encodeURIComponent(page.nextCursor)}`}>More →</a>
      )}
    </main>
    <script>
      import { initSocialIsland } from "../scripts/social";
      initSocialIsland();
    </script>
  </body>
</html>
```

> **Order matters:** call `markFeedCacheable(Astro)` / `setPublicPageCsp(Astro)` on a path that is reached for BOTH the 200 and the empty/error case (as written, after the fetch, unconditionally) — a page that declares cacheability only on the happy path would be flagged. There is no `notFound` early-return here (an empty list is a valid 200), so this is straightforward.

- [ ] **Step 4: Add the home nav links**

Edit `apps/web/src/pages/index.astro` — add `/authors` and `/feed` to the existing link list. Locate the `<ul>` of links (Sign up / Log in / New post) and add:

```astro
      <li><a href="/authors">Discover authors</a></li>
      <li><a href="/feed">Your feed</a></li>
```

(The home page is `markPrivate`; `/authors` is public and `/feed` redirects to `/login` when logged out, so both links are safe to render for everyone. Keep the page's single `markPrivate` call unchanged.)

- [ ] **Step 5: Run the tests + typecheck**

Run: `pnpm --filter @thinkersjournal/web test authors-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/authors.astro apps/web/src/pages/index.astro apps/web/test/authors-page.test.ts
git commit -m "feat(m2.1): web recent-authors discovery + home nav links"
```

---

## Task 14: Web — route `USERNAME_REQUIRED` to onboarding from the editor

**Files:**
- Modify: `apps/web/src/pages/new-post.astro` (on publish, catch `USERNAME_REQUIRED` → redirect to `/choose-username`)
- Test: `apps/web/test/new-post-onboarding.test.ts`

**Why:** Task 8 makes `api POST /posts` return `USERNAME_REQUIRED` when a not-yet-onboarded user tries to publish. Without this, the editor would surface a raw error. This closes the loop: publish-before-onboarding sends the author to choose a handle.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/new-post-onboarding.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/new-post.astro");
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("new-post.astro onboarding gate", () => {
  it("redirects to /choose-username when the api reports USERNAME_REQUIRED", () => {
    expect(code).toContain("USERNAME_REQUIRED");
    expect(code).toMatch(/redirect\(["']\/choose-username["']\)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test new-post-onboarding`
Expected: FAIL — no such branch yet.

- [ ] **Step 3: Add the redirect branch**

In `apps/web/src/pages/new-post.astro`, find where the publish `apiFetch("/posts", …)` (or the update call) response is handled. **Immediately after that call and its `applyCookies`, before the existing success/redirect handling**, add:

```ts
if (apiErrorCode(response) === "USERNAME_REQUIRED") {
  return Astro.redirect("/choose-username");
}
```

> Use the response variable name already in the file. Ensure `apiErrorCode` is imported from `../lib/api` (add it to the existing import if absent). Apply the same branch to both the create and (if present) update publish paths.

- [ ] **Step 4: Run the test + typecheck + the existing new-post test**

Run: `pnpm --filter @thinkersjournal/web test new-post-onboarding new-post-page && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/new-post.astro apps/web/test/new-post-onboarding.test.ts
git commit -m "feat(m2.1): editor routes USERNAME_REQUIRED to onboarding"
```

---

## Task 15: Web — browsable follower / following lists (island list mode)

**Files:**
- Modify: `apps/web/src/scripts/social.ts` (add list loading + wiring)
- Modify: `apps/web/src/pages/[handle]/index.astro` (add the list disclosures)
- Test: `apps/web/test/social-lists.test.ts`

**Interfaces:**
- Consumes: `/api/social?list=followers|following&username=X` (Task 10, mode 3).
- Produces: on the profile page, "Followers" / "Following" disclosure buttons that load and render the first page of each list client-side. (Deeper in-island cursor paging is deferred — `FollowList.nextCursor` is available for a later "More" affordance.)

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/social-lists.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ISLAND = join(import.meta.dirname, "../src/scripts/social.ts");
const PROFILE = join(import.meta.dirname, "../src/pages/[handle]/index.astro");
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const island = stripComments(readFileSync(ISLAND, "utf8"));
const profile = stripComments(readFileSync(PROFILE, "utf8"));

describe("island list mode", () => {
  it("loads follower/following lists from the /api/social list endpoint", () => {
    expect(island).toMatch(/\/api\/social\?list=/);
  });
});

describe("profile page list disclosures", () => {
  it("renders load-list controls anchored to the profile handle", () => {
    expect(profile).toMatch(/data-load-list="followers"/);
    expect(profile).toMatch(/data-load-list="following"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test social-lists`
Expected: FAIL — no list mode / no disclosures.

- [ ] **Step 3: Extend the island**

Add to `apps/web/src/scripts/social.ts` — a list loader and its wiring:

```ts
interface FollowUserRow {
  username: string;
  displayName: string | null;
}

async function loadList(username: string, list: "followers" | "following"): Promise<FollowUserRow[]> {
  const resp = await fetch(
    `/api/social?list=${list}&username=${encodeURIComponent(username)}`,
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as { users: FollowUserRow[] };
  return data.users;
}

function wireListButtons(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-load-list]"));
  for (const btn of buttons) {
    const list = btn.dataset.loadList === "following" ? "following" : "followers";
    const username = btn.dataset.username ?? "";
    const target = document.querySelector<HTMLElement>(`[data-list-panel="${list}"]`);
    btn.addEventListener("click", () => {
      void loadList(username, list).then((users) => {
        if (target === null) return;
        target.replaceChildren(
          ...users.map((u) => {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = `/@${u.username}`;
            a.textContent = u.displayName ?? `@${u.username}`;
            li.append(a);
            return li;
          }),
        );
      });
    });
  }
}
```

Then, inside `initSocialIsland()`, add a call at the end of the function body:

```ts
  wireListButtons();
```

- [ ] **Step 4: Add the list disclosures to the profile page**

Edit `apps/web/src/pages/[handle]/index.astro` — extend the social `<section>` from Task 11 with the disclosure buttons and empty panels:

```astro
<div>
  <button data-load-list="followers" data-username={profile.username}>Followers</button>
  <ul data-list-panel="followers"></ul>
  <button data-load-list="following" data-username={profile.username}>Following</button>
  <ul data-list-panel="following"></ul>
</div>
```

(These carry only `profile.username` — viewer-independent. The lists themselves load client-side, so no viewer state enters the cached HTML.)

- [ ] **Step 5: Run the tests + typecheck + profile tripwires**

Run: `pnpm --filter @thinkersjournal/web test social-lists social-island profile-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/scripts/social.ts "apps/web/src/pages/[handle]/index.astro" apps/web/test/social-lists.test.ts
git commit -m "feat(m2.1): browsable follower/following lists"
```

---

## Task 16: E2E — the social spine (follow → feed → unfollow) + onboarding gate

**Files:**
- Modify: `e2e/helpers.ts` (add `uniqueHandle`, `chooseUsername`; `publishPost` chooses a handle first — publish is now gated)
- Create: `e2e/social.spec.ts`
- Test: `pnpm test:e2e`

**Prerequisite:** the **dev** DB (`thinkersjournal`) must have migration `0003` applied — the CI `e2e` job's `pnpm --filter @thinkersjournal/api migrate` step covers this; locally run `pnpm --filter @thinkersjournal/api migrate` once.

**Interfaces:**
- Produces: `uniqueHandle(prefix): string` (a valid `^[a-z0-9_]{3,30}$` handle), `chooseUsername(page, handle): Promise<void>`; `publishPost` now returns the **chosen** handle as `username`.

- [ ] **Step 1: Update the E2E helpers**

Edit `e2e/helpers.ts` — add the two helpers and make `publishPost` onboard first. Add:

```ts
/** A valid chosen handle: lowercase, 3–30 of [a-z0-9_]. */
export function uniqueHandle(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Claim a durable @handle via the onboarding page. Assumes not-yet-onboarded. */
export async function chooseUsername(page: Page, handle: string): Promise<void> {
  await page.goto("/choose-username");
  await page.fill('input[name="username"]', handle);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/feed$/);
}
```

Then change `publishPost` to choose a handle before publishing (publish is gated as of Task 8). Replace its body's opening so it onboards first and returns the chosen handle:

```ts
export async function publishPost(
  page: Page,
  post: { title: string; markdownSource: string },
): Promise<PublishedPost> {
  // M2.1: a public post needs a chosen @handle. Claim one, then publish.
  const username = uniqueHandle("author");
  await chooseUsername(page, username);

  await page.goto("/new-post");
  await page.fill("#title", post.title);
  await page.fill("#markdownSource", post.markdownSource);

  await page.click("button[value='draft']");
  await expect(page.locator("#saved")).toBeVisible();
  const postId = new URL(page.url()).searchParams.get("post");
  expect(postId, "draft save did not surface ?post=<id>").not.toBeNull();

  await page.click("button[value='publish']");
  await page.waitForURL(/\/@[^/]+\/[^/]+$/);

  const slug = new URL(page.url()).pathname.split("/")[2]!;
  return { username, slug, postId: postId!, url: page.url() };
}
```

> This keeps `publishPost`'s return contract (`{username, slug, postId, url}`) so the existing M1 publish specs stay green — they now publish under a chosen handle instead of a system one, and their `slug`/URL assertions are unaffected. `chooseUsername` assumes the caller hasn't already onboarded (each E2E user calls `publishPost` at most once).

- [ ] **Step 2: Write the social E2E spec (it will fail until both Workers serve the new routes)**

Create `e2e/social.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("follow → the feed shows the followee's post → unfollow removes it", async ({ page, browser }) => {
  // Author A publishes a post (publishPost onboards A with a chosen handle).
  await signUpAndVerify(page, page.request);
  const { username: authorHandle } = await publishPost(page, {
    title: "Alice On Systems",
    markdownSource: "a thought from alice",
  });

  // Reader B in a fresh browser context.
  const ctxB = await browser.newContext();
  try {
    const b = await ctxB.newPage();
    await signUpAndVerify(b, b.request);
    await chooseUsername(b, uniqueHandle("reader"));

    // B follows A from A's profile — the island reveals the button, then flips it.
    await b.goto(`/@${authorHandle}`);
    const followBtn = b.locator("[data-follow-btn]");
    await expect(followBtn).toBeVisible();
    await expect(followBtn).toHaveText("Follow");
    await followBtn.click();
    await expect(followBtn).toHaveText("Unfollow");

    // B's feed now shows A's post.
    await b.goto("/feed");
    await expect(b.locator("a", { hasText: "Alice On Systems" })).toBeVisible();

    // B unfollows → the feed no longer shows it.
    await b.goto(`/@${authorHandle}`);
    await b.locator("[data-follow-btn]").click();
    await expect(b.locator("[data-follow-btn]")).toHaveText("Follow");
    await b.goto("/feed");
    await expect(b.locator("a", { hasText: "Alice On Systems" })).toHaveCount(0);
  } finally {
    await ctxB.close();
  }
});

test("publishing before choosing a handle routes to onboarding", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  await page.goto("/new-post");
  await page.fill("#title", "Too Early");
  await page.fill("#markdownSource", "body");
  await page.click("button[value='publish']");
  await expect(page).toHaveURL(/\/choose-username$/);
});

test("a new user's feed is empty and points at discovery", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  await chooseUsername(page, uniqueHandle("lonely"));
  await page.goto("/feed");
  await expect(page.locator("a", { hasText: "Discover authors" })).toBeVisible();
});
```

- [ ] **Step 3: Build web, then run the full E2E suite**

Run: `pnpm test:e2e`
Expected: PASS — the new `social.spec.ts` (3 tests) plus every existing spec (`publish.spec.ts`, `signup.spec.ts`) still green under the modified `publishPost`. If a pre-existing spec fails, it is the `publishPost` change rippling — reconcile it, do not weaken the onboarding gate.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers.ts e2e/social.spec.ts
git commit -m "test(m2.1): e2e social spine — follow, feed, unfollow, onboarding"
```

---

## Milestone-end verification & whole-branch review (controller task, not a subagent task)

After Task 16, before merging M2.1, the controller independently verifies green state and runs the whole-branch adversarial review (per the SDD methodology).

- [ ] **Verify the full green sweep** (run from repo root):

```
pnpm typecheck
pnpm --filter @thinkersjournal/shared test
pnpm --filter @thinkersjournal/markdown test
pnpm --filter @thinkersjournal/markdown run check:workerd
pnpm --filter @thinkersjournal/api test
pnpm --filter @thinkersjournal/web test
pnpm test:e2e
```

All must pass — including the **auto-coverage guards** (`route-protection`, `error-envelope`, `hyperdrive-binding-inventory`, `page-cache-inventory`) which the new routes/pages exercise, and the **build-gated web tests** (they require a prior `pnpm --filter @thinkersjournal/web build` so `dist/server/entry.mjs` exists and the `/feed`, `/authors`, `/choose-username`, `/api/*` route-survival greps run rather than skip).

- [ ] **Whole-branch adversarial review** via `superpowers:requesting-code-review` (multi-lens, per methodology). Priority lenses for this milestone:
  - **Cache leak:** does any cached page (`profile`, `authors`) carry per-viewer state in SSR HTML? Confirm counts/follow-state/lists are island-only and `data-*` values are viewer-independent (the profile owner's id, not the viewer's).
  - **Draft leak:** does the feed, or any social read, ever surface a non-`published` post? (`status='published'` must be *in* every query.)
  - **Auth/gate bypass:** can a non-verified or non-onboarded user publish/follow? Can `POST /follows` be driven without Origin/CSRF? (Confirm `route-protection` covers the new mutations.)
  - **Keyset correctness:** off-by-one at page boundaries; a `nextCursor` onto an empty page; malformed cursor → 400 not 500.
  - **Seam integrity:** is `getFolloweeIds` the *only* place the feed reads the graph (so the KV cache drops in cleanly)?
  - **HYPERDRIVE_CACHED discipline:** still exactly one live use.
- [ ] Address findings (implementer→reviewer→adjudicate), re-verify green, then proceed to `superpowers:finishing-a-development-branch`.

---

## Self-Review (author's checklist — completed against the spec)

**1. Spec coverage** — every spec section maps to a task:
- Usernames (spec §2.1, §4, §5, §7) → Tasks 1 (`username_chosen`), 2 (zod), 3 (`POST /profile/username`, `GET /profile/me`), 8 (publish gate), 9 (`/choose-username`), 14 (editor redirect).
- Follow/unfollow (§2.2, §4 `follows`, §5) → Tasks 1 (table), 4 (routes + limiter), 10/11 (web island + proxies).
- Counts + lists (§2.3, §5, §6 island discipline) → Tasks 5 (reads), 11 (counts island), 15 (lists island).
- Home feed (§2.4, §4 feed query, §5 `GET /feed`, §6 `/feed` page) → Tasks 6 (seam + api), 12 (page).
- Recent-authors (§2.5, §5 `GET /public/authors`, §6 `/authors`) → Tasks 7 (api), 13 (page + nav).
- Security/integrity (§7) → Tasks 4/8 (gates), 5/6/7 (`status='published'`), 11/13 (no viewer state in cached HTML), plus the auto-coverage guards.
- Testing (§8) → each task's TDD steps + Task 16 E2E + the milestone sweep.
- KV seam / roadmap (§9, decision #4) → Task 6 `getFolloweeIds` (documented as the single drop-in point).

**2. Placeholder scan** — no "TBD/handle edge cases/similar-to"; every code step carries real, runnable code. The three "verify the exact signature/variable name" notes (Tasks 3/6/8/14) point at *existing* symbols the implementer must match, not gaps in this plan.

**3. Type consistency** — DTO/field names are used identically across api and web: `Feed{posts,nextCursor}`, `FeedPost{…,username,displayName}`, `SocialCounts{followersCount,followingCount}`, `FollowList{users,nextCursor}`, `FollowUser{username,displayName}`, `AuthorSummary{userId,username,displayName,latestPostId}`, `AuthorsPage{authors,nextCursor}`, `Me{username,usernameChosen}`, `FollowStatusResult{following}`. Error codes (`USERNAME_TAKEN`, `USERNAME_ALREADY_SET`, `USERNAME_REQUIRED`, `CANNOT_FOLLOW_SELF`) are defined once in Task 2 and consumed by name thereafter. `initSocialIsland` and the `data-*` attribute names match between `social.ts` and the pages.

**Two deliberate, documented deviations from the spec's letter (both preserve its intent):**
- `follows` gains a `uuidv7()` surrogate `id` PK (spec used a composite PK) — required to keyset-paginate the follower/following lists the spec asks for (Task 1 note).
- `GET /public/authors` reads via `HYPERDRIVE_FRESH`, not `HYPERDRIVE_CACHED` — the spec said "CACHED-eligible"; behind the `/authors` 60s edge TTL the DB cache buys ~nothing and would expand the single-`CACHED`-site security exception (Task 7 note).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-20-m2-1-social-graph-and-feed.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks (implementer→reviewer→adjudicate), fast iteration. This matches the SDD methodology used for M0/M1.

**2. Inline Execution** — I execute tasks in this session via `superpowers:executing-plans`, batching with checkpoints for review.

**Which approach?**





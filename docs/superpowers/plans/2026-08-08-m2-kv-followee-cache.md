# M2 KV Followee-Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache each viewer's followee-id list in Cloudflare KV behind the existing `getFolloweeIds` seam, so a `/feed` load costs zero Postgres for the follow graph on a cache hit and zero Postgres entirely for a zero-follow viewer.

**Architecture:** A thin KV module (`social/followee-cache.ts`) owns get/put/bust with fail-open semantics. `getFolloweeIds` (the single feed-graph seam) becomes cache-aside: read KV → on miss run the existing Postgres SELECT over `HYPERDRIVE_FRESH`, populate KV, return. The feed handler resolves followees before opening any posts client and short-circuits an empty follow set. `handleFollow`/`handleUnfollow` bust the acting viewer's key via `ctx.waitUntil`.

**Tech Stack:** Cloudflare Workers KV (new `FOLLOWEES` namespace), TypeScript, Postgres via Hyperdrive (`pg`), Vitest under `cloudflare:test` (miniflare provides a real KV binding).

## Global Constraints

- **KV entry:** key `followees:<userId>`; value `JSON.stringify(string[])`; `put` always with `{ expirationTtl: 300 }`. The key format lives ONLY in `followeeKey(userId)`.
- **KV read idiom:** read as text (`env.FOLLOWEES.get(key)` → `string | null`) and `JSON.parse` manually — matches the codebase (`auth/session.ts`, `auth/email-verify.ts`); no `"json"`-typed `get`.
- **Fail-open:** any KV `get` error OR malformed JSON is treated as a miss (`null`) so the read degrades to Postgres, never a failed feed. A failed `put`/`delete` is swallowed (the 300s TTL self-heals a lost bust).
- **`HYPERDRIVE_FRESH` for the fallback SELECT.** Never `HYPERDRIVE_CACHED` — `handlePublicRecent` is the SOLE cached route and a test enforces exactly one `HYPERDRIVE_CACHED` reference in `apps/api/src`. Do not add another.
- **Bust keys on the follower** (`result.session.userId`, the acting viewer) and only on the write's SUCCESS path, via `ctx.waitUntil(bustFolloweeCache(env, userId))` — best-effort, latency-free, never fails the write.
- **Binding:** `FOLLOWEES` added to `apps/api/wrangler.jsonc` `kv_namespaces` with a placeholder id (mirrors `SESSIONS`) AND to `apps/api/src/worker-configuration.d.ts`'s `__BaseEnv_Env` interface by hand (the file is `wrangler types`-generated but `wrangler` is not on PATH here).
- **No** database migration, secret, or cron. **No** feed-result caching, **no** change to `GET /follows/status`, **no** metrics (explicit non-goals — do not add).
- **TDD**, frequent commits. **Every commit message MUST end with these two trailers verbatim:**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012sdN4Y44W3bVtUb6qqtsGm
  ```
- Test command: `cd apps/api && pnpm test <filter>` (vitest filename filter). Typecheck: `cd apps/api && pnpm typecheck`.

---

### Task 1: `FOLLOWEES` binding + `followee-cache.ts` module

**Files:**
- Modify: `apps/api/wrangler.jsonc` (the `kv_namespaces` array)
- Modify: `apps/api/src/worker-configuration.d.ts` (the `__BaseEnv_Env` interface)
- Create: `apps/api/src/social/followee-cache.ts`
- Test: `apps/api/test/followee-cache.test.ts`

**Interfaces:**
- Consumes: the `FOLLOWEES` KV binding (added in this task); ambient `Env`.
- Produces (later tasks rely on these EXACT signatures):
  - `followeeKey(userId: string): string` → `` `followees:${userId}` ``
  - `readFolloweeCache(env: Env, userId: string): Promise<string[] | null>` (null = miss OR fail-open)
  - `writeFolloweeCache(env: Env, userId: string, ids: string[]): Promise<void>`
  - `bustFolloweeCache(env: Env, userId: string): Promise<void>`

- [ ] **Step 1: Add the `FOLLOWEES` KV binding**

In `apps/api/wrangler.jsonc`, extend the `kv_namespaces` array (currently just `SESSIONS`) to add `FOLLOWEES`, mirroring the `SESSIONS` placeholder pattern:

```jsonc
  // Opaque session tokens keyed by `sess:<sha256hex(token)>` (see src/auth/session.ts).
  // The `id` is a FAKE PLACEHOLDER until the real KV namespace is created at
  // first deploy (`wrangler kv namespace create SESSIONS`).
  //
  // FOLLOWEES (M2 followee-cache) — each viewer's followee-id list keyed by
  // `followees:<userId>`, a cache-aside layer over the follow graph (see
  // src/social/followee-cache.ts). Same deploy dance: the id is a placeholder
  // until `wrangler kv namespace create FOLLOWEES` at first deploy.
  "kv_namespaces": [
    {
      "binding": "SESSIONS",
      "id": "PLACEHOLDER_SESSIONS_KV_ID_SET_AT_DEPLOY"
    },
    {
      "binding": "FOLLOWEES",
      "id": "PLACEHOLDER_FOLLOWEES_KV_ID_SET_AT_DEPLOY"
    }
  ],
```

In `apps/api/src/worker-configuration.d.ts`, add the type to `__BaseEnv_Env` directly beneath `SESSIONS`:

```ts
interface __BaseEnv_Env {
	SESSIONS: KVNamespace;
	FOLLOWEES: KVNamespace;
	MEDIA: R2Bucket;
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/followee-cache.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  bustFolloweeCache,
  followeeKey,
  readFolloweeCache,
  writeFolloweeCache,
} from "../src/social/followee-cache";

describe("followee-cache (KV)", () => {
  it("round-trips a list: write then read returns the same ids", async () => {
    const userId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await writeFolloweeCache(env, userId, ids);
    expect(await readFolloweeCache(env, userId)).toEqual(ids);
  });

  it("returns null (a MISS) for an unwritten key", async () => {
    expect(await readFolloweeCache(env, crypto.randomUUID())).toBeNull();
  });

  it("caches an empty list as a HIT ([]), distinct from a miss (null)", async () => {
    const userId = crypto.randomUUID();
    await writeFolloweeCache(env, userId, []);
    expect(await readFolloweeCache(env, userId)).toEqual([]); // NOT null
  });

  it("bust deletes the key: a written entry reads null afterward", async () => {
    const userId = crypto.randomUUID();
    await writeFolloweeCache(env, userId, [crypto.randomUUID()]);
    await bustFolloweeCache(env, userId);
    expect(await readFolloweeCache(env, userId)).toBeNull();
  });

  it("stores JSON under the followees:<userId> key", async () => {
    const userId = crypto.randomUUID();
    await writeFolloweeCache(env, userId, ["x"]);
    expect(await env.FOLLOWEES.get(followeeKey(userId))).toBe(JSON.stringify(["x"]));
  });

  it("fails open: a KV whose get throws is a miss (null), not an error", async () => {
    const throwingEnv = {
      ...env,
      FOLLOWEES: { get: () => { throw new Error("KV down"); } },
    } as unknown as Env;
    expect(await readFolloweeCache(throwingEnv, crypto.randomUUID())).toBeNull();
  });

  it("fails open on malformed JSON (treats a corrupt value as a miss)", async () => {
    const userId = crypto.randomUUID();
    await env.FOLLOWEES.put(followeeKey(userId), "not json{");
    expect(await readFolloweeCache(env, userId)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && pnpm test followee-cache`
Expected: FAIL — cannot resolve `../src/social/followee-cache` (module does not exist yet).

- [ ] **Step 4: Implement the module**

Create `apps/api/src/social/followee-cache.ts`:

```ts
/**
 * KV cache for a viewer's followee-id list — the read side of the follow graph
 * behind getFolloweeIds (social/followees.ts). Cache-aside: read here, fall back
 * to Postgres on a miss, populate, and bust on every follow/unfollow.
 *
 * FAIL-OPEN throughout: a KV fault (or a corrupt value) makes readFolloweeCache
 * return null, i.e. "treat as a miss", so the caller degrades to a plain
 * Postgres read — never a failed feed. A failed write/bust is swallowed; the
 * 300s TTL self-heals a lost bust. Values are stored as text and JSON.parse'd by
 * hand, matching auth/session.ts (no "json"-typed KV get anywhere in src).
 */

/** TTL backstop for a cached list (see the design's freshness decision). */
const FOLLOWEE_TTL_SECONDS = 300;

/** The one place the `followees:<userId>` key format lives. */
export function followeeKey(userId: string): string {
  return `followees:${userId}`;
}

/**
 * The cached followee-id list, or null on a miss OR any KV error / corrupt
 * value (fail-open to Postgres). An empty follow set is cached as `[]` and
 * returned as `[]` — a genuine HIT, distinct from null, so zero-follow viewers
 * stop re-hitting Postgres.
 */
export async function readFolloweeCache(env: Env, userId: string): Promise<string[] | null> {
  try {
    const raw = await env.FOLLOWEES.get(followeeKey(userId));
    return raw === null ? null : (JSON.parse(raw) as string[]);
  } catch {
    return null;
  }
}

/** Cache a viewer's followee-id list with the 300s TTL. Swallowed on error. */
export async function writeFolloweeCache(env: Env, userId: string, ids: string[]): Promise<void> {
  try {
    await env.FOLLOWEES.put(followeeKey(userId), JSON.stringify(ids), {
      expirationTtl: FOLLOWEE_TTL_SECONDS,
    });
  } catch {
    // best-effort: a lost write just means the next read misses.
  }
}

/** Invalidate a viewer's cached followee-id list. Swallowed on error. */
export async function bustFolloweeCache(env: Env, userId: string): Promise<void> {
  try {
    await env.FOLLOWEES.delete(followeeKey(userId));
  } catch {
    // best-effort: the 300s TTL backstops a lost bust.
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && pnpm test followee-cache`
Expected: PASS (7/7).

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors (the `FOLLOWEES` binding type resolves; the module compiles).

- [ ] **Step 7: Commit**

```bash
git add apps/api/wrangler.jsonc apps/api/src/worker-configuration.d.ts \
        apps/api/src/social/followee-cache.ts apps/api/test/followee-cache.test.ts
git commit  # message: "feat(m2-kv-followee-cache): FOLLOWEES binding + KV cache module" + the two required trailers
```

---

### Task 2: `getFolloweeIds` cache-aside + feed short-circuit

**Files:**
- Modify: `apps/api/src/social/followees.ts` (rewrite `getFolloweeIds`)
- Modify: `apps/api/src/routes/feed.ts` (resolve followees before the posts client; short-circuit empty)
- Create: `apps/api/test/followees.test.ts`
- Test: `apps/api/test/feed.test.ts` (add one wiring assertion)

**Interfaces:**
- Consumes: `readFolloweeCache`, `writeFolloweeCache` from Task 1; `withClient` from `../db/client`; ambient `Env`, `ExecutionContext`.
- Produces: **`getFolloweeIds(env: Env, ctx: ExecutionContext, userId: string): Promise<string[]>`** (signature CHANGED from `(client, userId)`). No feed call site inlines the follows query.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/followees.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { followeeKey } from "../src/social/followee-cache";
import { getFolloweeIds } from "../src/social/followees";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterAll(async () => { await deleteCreatedUsers(); });

async function call(userId: string): Promise<string[]> {
  const ctx = createExecutionContext();
  const ids = await getFolloweeIds(env, ctx, userId);
  await waitOnExecutionContext(ctx);
  return ids;
}

describe("getFolloweeIds (cache-aside)", () => {
  it("MISS: reads the follow graph from Postgres and populates the cache", async () => {
    const viewer = await createVerifiedActor();
    const followed = await createVerifiedActor();
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [
        viewer.userId, followed.userId,
      ]),
    );
    await waitOnExecutionContext(ctx);

    expect(await env.FOLLOWEES.get(followeeKey(viewer.userId))).toBeNull(); // cold
    expect(await call(viewer.userId)).toEqual([followed.userId]);           // served from PG
    expect(await env.FOLLOWEES.get(followeeKey(viewer.userId)))             // now populated
      .toBe(JSON.stringify([followed.userId]));
  });

  it("HIT: returns the cached list WITHOUT touching Postgres (cache wins over DB truth)", async () => {
    const viewer = await createVerifiedActor();
    // A phantom id that is NOT in the follows table. If the read hit Postgres it
    // would return [] (no edges); returning the phantom proves KV alone served it.
    const phantom = crypto.randomUUID();
    await env.FOLLOWEES.put(followeeKey(viewer.userId), JSON.stringify([phantom]));
    expect(await call(viewer.userId)).toEqual([phantom]);
  });

  it("zero-follow viewer: MISS returns [] and caches [] as a hit", async () => {
    const lonely = await createVerifiedActor();
    expect(await call(lonely.userId)).toEqual([]);
    expect(await env.FOLLOWEES.get(followeeKey(lonely.userId))).toBe(JSON.stringify([]));
  });
});
```

Add this test to `apps/api/test/feed.test.ts` inside the `describe("GET /feed", …)` block (it proves the feed handler routes through the cache; `env` is already imported there, and `getFeed`/`seedFollow`/`createVerifiedActor` already exist):

```ts
  it("populates the viewer's KV followee cache on a feed read (wired through getFolloweeIds)", async () => {
    const reader = await createVerifiedActor();
    const author = await createVerifiedActor();
    await seedFollow(reader.userId, author.userId);
    expect(await env.FOLLOWEES.get(`followees:${reader.userId}`)).toBeNull(); // cold
    await getFeed(reader);
    expect(await env.FOLLOWEES.get(`followees:${reader.userId}`))
      .toBe(JSON.stringify([author.userId]));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && pnpm test followees.test feed.test`
Expected: FAIL — `getFolloweeIds` still has the old `(client, userId)` signature, so `getFolloweeIds(env, ctx, userId)` is a type error / wrong behavior, and the feed wiring assertion fails (cache never populated).

- [ ] **Step 3: Rewrite `getFolloweeIds` as cache-aside**

Replace the entire body of `apps/api/src/social/followees.ts` with:

```ts
/**
 * THE FOLLOWEE-GRAPH SEAM. Every feed read routes its "whose posts?" question
 * through this one function — now cache-aside over KV (followee-cache.ts) with a
 * Postgres fallback, invalidated on follow/unfollow. A hit costs ZERO Postgres;
 * a zero-follow viewer is a cached `[]` that lets the feed skip the posts query
 * entirely. Do not inline this query elsewhere.
 */
import { withClient } from "../db/client";

import { readFolloweeCache, writeFolloweeCache } from "./followee-cache";

export async function getFolloweeIds(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<string[]> {
  const cached = await readFolloweeCache(env, userId);
  if (cached !== null) return cached;

  const ids = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ followee_id: string }>(
      "SELECT followee_id FROM follows WHERE follower_id = $1",
      [userId],
    );
    return rows.map((r) => r.followee_id);
  });
  await writeFolloweeCache(env, userId, ids);
  return ids;
}
```

- [ ] **Step 4: Restructure `handleFeed`**

In `apps/api/src/routes/feed.ts`, the followee read no longer shares the posts client. Replace the `try { … } catch { … }` block (currently the single `withClient` that calls `getFolloweeIds(c, …)`) with:

```ts
  try {
    const followeeIds = await getFolloweeIds(env, ctx, session.userId);
    if (followeeIds.length === 0) {
      // No client opened at all — the whole feed is empty.
      return feedJson({ posts: [], nextCursor: null });
    }

    const feed = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<FeedPost>(
        `SELECT p.id, p.title, p.slug,
                left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt",
                pr.username, pr.display_name AS "displayName", ${TAGS_AGG}
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
```

The imports already present (`getFolloweeIds`, `withClient`, `TAGS_AGG`, `isInvalidTextRepresentation`, `errorResponse`, `MAX_CURSOR`, types) are unchanged and all still used.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test followees.test feed.test`
Expected: PASS — `followees.test.ts` (3/3) and all of `feed.test.ts` (the existing cases plus the new wiring assertion) green.

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors (the only caller of `getFolloweeIds`, `feed.ts`, matches the new signature).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/social/followees.ts apps/api/src/routes/feed.ts \
        apps/api/test/followees.test.ts apps/api/test/feed.test.ts
git commit  # "feat(m2-kv-followee-cache): cache-aside getFolloweeIds + feed short-circuit" + trailers
```

---

### Task 3: Bust the cache on follow / unfollow

**Files:**
- Modify: `apps/api/src/routes/follows.ts` (`handleFollow`, `handleUnfollow`)
- Test: `apps/api/test/follows.test.ts` (add a bust describe-block)

**Interfaces:**
- Consumes: `bustFolloweeCache(env, userId)` from Task 1; the `ctx: ExecutionContext` already in both handler signatures.
- Produces: nothing new (behavioral change only).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/follows.test.ts` (its `env`, `follow`, `unfollow`, `onboardedActor`, and `bob` are already in scope). `waitOnExecutionContext` inside `follow`/`unfollow` drains the handler's `ctx.waitUntil`, so the bust has run by the time the helper resolves:

```ts
describe("follow/unfollow busts the follower's KV followee cache (M2 KV cache)", () => {
  it("POST /follows deletes the follower's cache key", async () => {
    const follower = await onboardedActor();
    // Prime a stale entry, then follow — the write must invalidate it.
    await env.FOLLOWEES.put(`followees:${follower.userId}`, JSON.stringify([]));
    const r = await follow(follower, bob.userId);
    expect(r.status).toBe(201);
    expect(await env.FOLLOWEES.get(`followees:${follower.userId}`)).toBeNull();
  });

  it("DELETE /follows/:id deletes the follower's cache key", async () => {
    const follower = await onboardedActor();
    await follow(follower, bob.userId);
    await env.FOLLOWEES.put(`followees:${follower.userId}`, JSON.stringify([bob.userId]));
    const r = await unfollow(follower, bob.userId);
    expect(r.status).toBe(200);
    expect(await env.FOLLOWEES.get(`followees:${follower.userId}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && pnpm test follows.test`
Expected: FAIL — the primed key survives the write (no bust yet), so `get` returns the primed JSON instead of `null`.

- [ ] **Step 3: Implement the bust in both handlers**

In `apps/api/src/routes/follows.ts`:

Add the import beside the others:

```ts
import { bustFolloweeCache } from "../social/followee-cache";
```

In `handleFollow`, after the `try { await withClient(…) } catch { … }` block completes (i.e. on the success path only), immediately before `return new Response(null, { status: 201 });`:

```ts
  // The follower's followee list changed — invalidate their cached copy.
  // Best-effort (the 300s TTL backstops a lost delete); never blocks the write.
  ctx.waitUntil(bustFolloweeCache(env, userId));
  return new Response(null, { status: 201 });
```

In `handleUnfollow`, after the `await withClient(…)` DELETE, before `return new Response(null, { status: 200 });`:

```ts
  ctx.waitUntil(bustFolloweeCache(env, userId));
  return new Response(null, { status: 200 });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test follows.test`
Expected: PASS — both new cases plus every existing follows case (the bust is additive; self-follow/FK/check rejections return before it and remain unaffected).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/follows.ts apps/api/test/follows.test.ts
git commit  # "feat(m2-kv-followee-cache): bust follower cache on follow/unfollow" + trailers
```

---

## Deploy note (post-merge, founder)

One infra step, no code: `wrangler kv namespace create FOLLOWEES`, then paste the returned id into `apps/api/wrangler.jsonc` (replacing `PLACEHOLDER_FOLLOWEES_KV_ID_SET_AT_DEPLOY`). API-only. No migration, secret, or cron. Independent of the pending 0006–0010 Postgres migrations.

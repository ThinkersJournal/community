# M2 KV Followee-Cache — Design

**Status:** Approved (2026-08-08)
**Milestone:** M2 (scaling item deferred from M2.1)
**Branch:** `m2-kv-followee-cache` off `main`

## Goal

Offload the follow-graph read from Postgres onto Cloudflare KV. Today every
`/feed` load runs `SELECT followee_id FROM follows WHERE follower_id = $1`
(`apps/api/src/social/followees.ts`) before it can query posts. After this change
a feed load costs **zero Postgres for the graph** on a cache hit, and **zero
Postgres at all** for a viewer who follows nobody.

This is a pure caching layer behind an existing seam. It changes no feed output,
no schema, and no API surface.

## Scope

### In scope
- A new KV namespace `FOLLOWEES` caching each viewer's followee-id list.
- Cache-aside read behind the existing `getFolloweeIds` seam.
- Bust-on-write invalidation from the follow / unfollow handlers.
- The feed handler short-circuits an empty follow set without opening a Postgres
  client.

### Non-goals (explicit — do not add)
- **Not** caching feed *post* results. Only the followee-id list is cached; the
  posts query still hits Postgres (`HYPERDRIVE_FRESH`) as today.
- **Not** touching `GET /follows/status`. It is a membership test on specific
  ids (`WHERE follower_id = $1 AND followee_id = ANY($2)`), a different access
  pattern; it stays a direct Postgres read.
- **No** cache hit-rate metrics / observability instrumentation.
- **No** database migration, secret, or cron. The only deploy step is creating
  the KV namespace.

## Freshness decision (settled)

**Bust-on-write + 300s TTL backstop.** Follow and unfollow both delete the
viewer's cache key; reads repopulate from Postgres; a 300-second `expirationTtl`
self-heals any lost delete. We accept KV's cross-edge propagation window: a
just-unfollowed author's posts may linger in the viewer's feed for up to ~60s on
an edge that has not yet seen the delete. This is acceptable because unfollow is
not block (blocking, when it lands, will need its own immediacy) and a feed is
understood to be eventually consistent. This matches the platform's existing
300s instinct (the notification-seen TTL).

Rejected alternatives: a 60s TTL (≈5× more Postgres graph reads for no real
freshness gain, since ~60s cross-edge is the floor either way); write-through
read-modify-write of the KV list (adds RMW races, cross-edge freshness still
~60s — no meaningful gain over busting).

## Architecture & data flow

### KV namespace and entry
- **Binding:** `FOLLOWEES` (KV). Bound in `apps/api/wrangler.jsonc` with a
  placeholder id set at first deploy — identical to the `SESSIONS` pattern.
- **Key:** `followees:<userId>` where `<userId>` is the viewer's user UUID.
- **Value:** `JSON.stringify(followeeIds)` — a JSON array of followee UUID
  strings.
- **TTL:** `expirationTtl: 300` on every `put`.

### Read path (cache-aside), behind `getFolloweeIds`
1. `FOLLOWEES.get(key, "json")` → `string[] | null`.
2. **Hit** (`string[]`, including `[]`): return it. No Postgres.
3. **Miss** (`null`): run the current PG SELECT over `HYPERDRIVE_FRESH`,
   `put(key, JSON.stringify(ids), { expirationTtl: 300 })`, return `ids`.

An empty follow set is stored as the string `"[]"`, which `get(...,"json")`
returns as `[]` — a genuine **hit**, distinct from `null` (miss). Zero-follow
viewers therefore stop re-hitting Postgres after their first miss.

### Write path (bust-on-write)
Both `handleFollow` (after the `INSERT`) and `handleUnfollow` (after the
`DELETE`) invalidate the acting viewer's entry:
`ctx.waitUntil(bustFolloweeCache(env, userId))`, i.e. `FOLLOWEES.delete(key)`,
best-effort and swallowed. The bust keys on `follower_id = userId` (the acting
viewer, whose graph changed) — never on the followee. `waitUntil` keeps the
write path's latency and failure surface unchanged; the 300s TTL backstops a
delete that fails or is lost. The existing `FOLLOW_LIMITER` rate limit on the
follow write means writes to a single key never approach KV's ~1-write/sec/key
ceiling.

### Feed short-circuit
`handleFeed` calls `getFolloweeIds(env, ctx, session.userId)` **before** opening
any posts client. If the list is empty it returns `{ posts: [], nextCursor: null }`
with **no Postgres client opened at all**. Only a non-empty list proceeds to open
`withClient(HYPERDRIVE_FRESH)` for the posts query.

## Components / files

### New
- **`apps/api/src/social/followee-cache.ts`** — owns the KV interaction:
  - `readFolloweeCache(env, userId): Promise<string[] | null>` — `get`, fail-open
    to `null` on any KV error.
  - `writeFolloweeCache(env, userId, ids): Promise<void>` — `put` with the 300s
    TTL, swallowed on error.
  - `bustFolloweeCache(env, userId): Promise<void>` — `delete`, swallowed on
    error.
  - A single `followeeKey(userId)` helper so the key format lives in one place.

### Modified
- **`apps/api/src/social/followees.ts`** — `getFolloweeIds` signature changes
  from `(client: Client, userId)` to **`(env: Env, ctx: ExecutionContext, userId)`**.
  It becomes the cache-aside entry: read cache → on hit return → on miss run the
  PG SELECT inside its own `withClient(env.HYPERDRIVE_FRESH, ctx, …)`, populate
  the cache, return. The seam stays the single choke-point; no feed call site
  inlines the query.
- **`apps/api/src/routes/feed.ts`** — restructure per "Feed short-circuit" above:
  resolve followees first (cache-aside, no shared client), short-circuit empty,
  open the posts client only when there are followees. The `catch` for an
  invalid cursor stays.
- **`apps/api/src/routes/follows.ts`** — `ctx.waitUntil(bustFolloweeCache(env, userId))`
  in both `handleFollow` (after the successful transaction) and `handleUnfollow`
  (after the `DELETE`).
- **`apps/api/wrangler.jsonc`** — add the `FOLLOWEES` namespace to
  `kv_namespaces` with a placeholder id and an explanatory comment (mirrors
  `SESSIONS`).
- **`apps/api/src/worker-configuration.d.ts`** — add `FOLLOWEES: KVNamespace;`
  to the `__BaseEnv_Env` interface, beside `SESSIONS`. This file is
  `wrangler types`-generated, but `wrangler` is not on PATH in this environment,
  so the line is added by hand (it will be reconciled the next time the founder
  regenerates types at deploy).

## Correctness & failure handling

- **Fail-open to Postgres.** Any error from `FOLLOWEES.get` is caught and treated
  as a miss, so a KV fault degrades to today's behavior (a PG read), never a
  failed feed.
- **Swallow write failures.** A failed `put` (miss again next time) or `delete`
  (TTL self-heals within 300s) never fails the originating request.
- **Miss cost.** On a miss the followee fallback opens its own client and the
  posts query opens another — two Hyperdrive acquisitions where today there is
  one shared client running two queries. A miss is ≤ once per 5 min per active
  viewer and Hyperdrive is pooled; every hit is strictly cheaper. Net win.
- **`HYPERDRIVE_FRESH`** for the fallback SELECT: the graph read is per-viewer,
  feeds a `no-store` response, and must observe a just-committed unfollow. This
  does not touch the "exactly one `HYPERDRIVE_CACHED` reference" invariant
  (`handlePublicRecent` remains the sole cached route).
- **Bust targets the follower.** Only the acting viewer's key is invalidated; a
  followee's cache is unaffected by being followed/unfollowed (their own feed
  graph did not change).

## Testing

- **`apps/api/test/followee-cache.test.ts`** (new):
  - miss → the PG SELECT runs and the result is written to KV;
  - hit → served from KV **without** Postgres (seed KV with a list that differs
    from the DB truth and assert the KV list is returned — proves no PG read);
  - empty list is a **hit** (`[]`), not a re-miss;
  - `bustFolloweeCache` deletes the key (seed, bust, assert `get` is `null`);
  - a throwing KV `get` falls back to the PG SELECT (inject a stub namespace
    whose `get` rejects).
- **`apps/api/test/feed.test.ts`** (extend): hit, miss, and zero-follow all
  produce correct feeds; the existing feed assertions stay green; a zero-follow
  viewer returns an empty feed.
- **Follows write tests** (extend the existing follow/unfollow coverage): after
  `handleFollow` and after `handleUnfollow`, the viewer's `followees:<id>` key is
  absent (`get` returns `null`).

All API tests run under `cloudflare:test` (miniflare), which provides a real KV
namespace binding, as the existing `SESSIONS` KV tests already rely on.

## Deploy

One infra step, performed by the founder at deploy time:

1. `wrangler kv namespace create FOLLOWEES`
2. Paste the returned id into `apps/api/wrangler.jsonc` (replacing the
   placeholder).

API-only (the web Worker does not read this namespace). **No migration, no
secret, no cron.** Independent of the still-pending 0006–0010 Postgres
migrations.

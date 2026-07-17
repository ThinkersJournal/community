# M0 — Foundations & Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the auth/identity/deploy spine of the Thinker's Journal Community platform — a two-Worker Cloudflare monorepo with hand-rolled auth (signup/login/sessions, Argon2id, soft email verification, CSRF, Turnstile, rate limiting, strongly-consistent revocation) on Postgres-via-Hyperdrive — with a local-first TDD loop.

**Architecture:** A pnpm monorepo with two Cloudflare Workers joined by a Service Binding: `api` (TypeScript backend — auth, Postgres via Hyperdrive, KV sessions, a per-user `UserSecurityDO`, Turnstile, rate limiting) and `web` (Astro `output:'server'` via `@astrojs/cloudflare`). The whole inner loop runs locally on workerd/miniflare + a Docker Postgres; real cloud services are wired in only at deploy.

**Tech Stack:** pnpm workspaces, TypeScript (strict, **pinned to exactly `6.0.3`** — see Global Constraints), Cloudflare Workers (`wrangler`), `@astrojs/cloudflare`, `pg` (node-postgres over `nodejs_compat`) + Hyperdrive, Workers KV, Durable Objects (SQLite), **`argon2id`** (the openpgpjs package — *not* `hash-wasm`, which cannot run on Workers; see *As-built deviations (M0)* → A), `zod`, Postmark, Turnstile; testing = Vitest 4 + `@cloudflare/vitest-pool-workers` (`cloudflareTest()` plugin) + Playwright + `node-pg-migrate`.

## Global Constraints

*(Every task implicitly includes these. Exact values are load-bearing.)*

> **Corrected against the as-built code** (2026-07-14). Where a rule below changed during M0, *As-built deviations (M0)* carries the evidence. **This section is current; the per-task step text below it is a historical record of what was planned.**

- **Node ≥ 20; pnpm** (via `corepack enable`). TypeScript `strict`, `moduleResolution: "bundler"`, target `ES2022`. `compatibility_date: "2026-07-13"`, `compatibility_flags: ["nodejs_compat"]` on both Workers.
- **TypeScript is pinned to EXACTLY `6.0.3` — do NOT "upgrade" to 7.x.** TypeScript **7.0** (GA 2026-07-08) is the Go-native rewrite and ships **without the programmatic Compiler API** until 7.1. Astro (`astro check`), vitest's TS integration, and typescript-eslint all require that API, so 7.x breaks the toolchain. `6.0.3` is the last JS-based line with the full API. Pinned exactly (no `^`) in the root `package.json`.
- **Two Hyperdrive bindings, and the routing rule is a security invariant:** `HYPERDRIVE_FRESH` (cache-disabled) for **all** auth/session/permission reads, dup-email checks, email-verify reads, and any read-immediately-after-write; `HYPERDRIVE_CACHED` (60s) only for public feeds/listings. Hyperdrive never invalidates cache on write — a cached auth/dup/verify read is a real security bug.
- **Postgres access:** `pg.Client` (NOT `Pool` — Hyperdrive *is* the pool), one per request, `end()` via `ctx.waitUntil`. Transaction-mode pooler: no cross-query session state / `LISTEN`/`NOTIFY` / session advisory locks; keep multi-statement atomicity inside a single `BEGIN/COMMIT`, don't wrap unrelated ops to fake session state.
- **Durable Objects:** new DO namespaces MUST use `new_sqlite_classes` in the migration (KV-backed `new_classes` is blocked for new namespaces as of July 2026); the migrations `tag` is mandatory or the first `wrangler dev`/`deploy` fails.
- **Argon2id params (OWASP):** `{ parallelism:1, iterations:2, memorySize:19456, hashLength:32 }`, encoded as a PHC string (`$argon2id$v=19$…`). **The library is the openpgpjs `argon2id` package via a statically-imported `.wasm` module — NOT `hash-wasm`, which cannot run on Workers at all** (deviation A). Params, format and OWASP values are unchanged by that swap. Any Argon2id requires the Workers **Paid** plan.
- **Session cookie:** name `tj_session`; value is a bare opaque random token. **Production attributes** (exact): `Path=/; Domain=.thinkersjournal.com; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`. **Dev/CI exception:** when `env.TEST_ROUTES === "1"` (an explicit `=== "1"` allowlist, never a truthiness check) the cookie **omits `Domain` and `Secure` and nothing else** — with them, no browser stores the cookie at `http://127.0.0.1:8787` and a real-browser E2E is impossible. Applies to both the set and the cleared cookie; both modes are pinned by tests (deviation F). Roles/`securityEpoch`/`csrfSecret` live in the KV value, **never** in the cookie. Do **not** use Astro's Sessions API — and note it must be **actively disabled**, not merely left unset (deviation G).
- **Revocation:** per-user `UserSecurityDO` holds a monotonic `epoch`; the session snapshots it at login; a mismatch on a **mutating** request → 401 + clear cookie (checked on non-GET only).
- **CSRF:** enforce BOTH an Origin/Referer allowlist check AND a per-session double-submit token (`X-CSRF-Token` header vs `sha256(session.csrfSecret)`, timing-safe) on every non-GET before touching the DB. Token delivered only via authenticated HTML/same-origin JSON, never a readable cookie.
- **Soft email-verification gate:** unverified users may read/browse; posting/commenting/following require `email_verified_at`. Gate applies to content-mutation routes only.
- **Tooling-shape pins (tutorials are stale):** `@cloudflare/vitest-pool-workers` uses the `cloudflareTest()` Vite plugin (Vitest 4; `isolatedStorage`/`singleWorker` removed); the rate-limit binding is the **top-level, PLURAL `ratelimits`** key — **not** `ratelimit` (singular is *hard-rejected* by wrangler 4.110.0's config validator: `Unexpected fields found in top-level field: 'ratelimit'`) and **not** under `unsafe`; `simple.period` must be `10` or `60`, no other value. The Hyperdrive local override env var is `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`. Pin `wrangler` + `@cloudflare/vitest-pool-workers` versions and verify each config shape against the installed version before relying on it.
- **`__test` routes** (which expose the last verification token to avoid real email in tests) are gated on `env.TEST_ROUTES`, set only in `.dev.vars`/CI. Their presence in prod is a full account-takeover vector — a deploy check must assert absence.

## Prerequisites (user-provisioned; local-first ordering)

| When needed | Prerequisite |
|---|---|
| Task 1 (now) | Node ≥20 + pnpm (`corepack enable`). Nothing cloud-side to start. |
| Task 5 | Docker Desktop → local Postgres 16 (`postgres://postgres:postgres@localhost:5432`, dbs `thinkersjournal` + `thinkersjournal_test`). |
| Task 6b / CI | **Neon** project + a **DIRECT (non-pooled), `sslmode=require`** connection string (uncheck "Connection pooling" — feeding Hyperdrive Neon's PgBouncer double-pools). Only to create the two real Hyperdrive configs + for prod/CI. |
| Task 8 / deploy | Cloudflare account + `wrangler login` (local KV/DO/ratelimit all simulate without it). |
| Deploy (Task 19) | **Turnstile** site (real key+secret) — locally use dummy keys: always-pass secret `1x0000000000000000000000000000000AA`, always-block `2x0000000000000000000000000000000AA`. **Postmark** server token + a **CONFIRMED** sender signature/domain for `noreply@thinkersjournal.com`. The private GitHub repo already exists (`ThinkersJournal/community`) for Workers Builds. |

## File Structure

*(As planned. The built tree matches closely, but the annotations here inherit the stale literals corrected in *As-built deviations (M0)* — notably `platformProxy` and the single-process `wrangler dev -c web -c api`.)*

```
thinkersjournal-community/            (repo root)
├── package.json                      # private; workspaces [apps/*, packages/*]; script: typecheck
├── pnpm-workspace.yaml               # packages: [apps/*, packages/*]
├── tsconfig.base.json                # strict, moduleResolution bundler, ES2022
├── docker-compose.yml                # postgres:16 → thinkersjournal + thinkersjournal_test
├── playwright.config.ts              # webServer: wrangler dev -c web -c api; baseURL :8787
├── e2e/signup.spec.ts
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts              # export default { fetch }; router + mutating pipeline; exports UserSecurityDO
│   │   │   ├── env.d.ts              # interface Env
│   │   │   ├── auth/{password,session,csrf,turnstile,email-verify,ratelimit,pipeline}.ts
│   │   │   ├── db/client.ts          # withClient(hd, fn)
│   │   │   ├── routes/{signup,login,logout,verify-email,posts,__test}.ts
│   │   │   └── durable-objects/UserSecurityDO.ts
│   │   ├── migrations/0001_users_and_profiles.sql
│   │   ├── test/{tsconfig.json,env.d.ts,setup.ts,*.test.ts}
│   │   ├── vitest.config.ts
│   │   ├── wrangler.jsonc
│   │   ├── .dev.vars                 # TURNSTILE dummy, POSTMARK token, TEST_ROUTES=1 (gitignored)
│   │   ├── package.json              # @thinkersjournal/api
│   │   └── tsconfig.json
│   └── web/
│       ├── src/pages/{index,signup,login,verify-email,new-post}.astro
│       ├── src/lib/api.ts
│       ├── astro.config.mjs          # output:'server', adapter cloudflare({platformProxy:{enabled:true}})
│       ├── wrangler.jsonc            # services:[{binding:API, service:'thinkersjournal-api'}]
│       ├── package.json              # @thinkersjournal/web
│       └── tsconfig.json
└── packages/shared/
    ├── src/{index,cookie,schemas}.ts
    ├── test/schemas.test.ts
    ├── package.json                  # @thinkersjournal/shared
    └── tsconfig.json
```

## Testing approach

- **api (bulk):** Vitest 4 + `@cloudflare/vitest-pool-workers` `cloudflareTest()` plugin — tests run in real workerd with real KV/DO and a Hyperdrive binding overridden via `miniflare.hyperdrives` to hit the local test Postgres. `import { env } from 'cloudflare:test'`; `createExecutionContext()`/`waitOnExecutionContext()`; `evictAllDurableObjects()` to prove DO persistence. Storage isolated per file.
- **DB under test:** local Docker Postgres for the fast loop; a Neon ephemeral branch per CI run. Schema applied by `node-pg-migrate` in a Vitest `setupFiles`.
- **E2E (thin):** Playwright driving both Workers; dummy Turnstile keys + the `__test/last-verify-token` route replace real Turnstile/Postmark. *(As built: **two** processes — web primary on :8787, api its own primary on :8788 — not the single `wrangler dev -c web -c api` planned here, which cannot reach the `__test` route. See *As-built deviations (M0)* → **G6**.)*
- **shared:** plain Vitest (node env).

---

### Task 1: Monorepo scaffold

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`; `apps/api/`, `apps/web/`, `packages/shared/` each with `package.json` + `tsconfig.json`. `.gitignore` already present.

**Interfaces — Produces:** workspace names `@thinkersjournal/api`, `@thinkersjournal/web`, `@thinkersjournal/shared`; root script `pnpm typecheck` (recursive `tsc --noEmit`).

- [ ] **Step 1: Create root workspace files.**
  - `package.json`: `{"name":"thinkersjournal-community","private":true,"workspaces":["apps/*","packages/*"],"scripts":{"typecheck":"pnpm -r run typecheck"},"packageManager":"pnpm@9"}`
  - `pnpm-workspace.yaml`: `packages:\n  - "apps/*"\n  - "packages/*"`
  - `tsconfig.base.json`: `{"compilerOptions":{"strict":true,"moduleResolution":"bundler","module":"ESNext","target":"ES2022","types":[],"skipLibCheck":true,"noEmit":true,"verbatimModuleSyntax":true}}`
- [ ] **Step 2: Create the three package stubs.** Each `package.json` sets its `@thinkersjournal/*` name, `"type":"module"`, `"scripts":{"typecheck":"tsc --noEmit"}`; each `tsconfig.json`: `{"extends":"../../tsconfig.base.json","include":["src","test"]}`.
- [ ] **Step 3: Install + verify.** Run: `pnpm install && pnpm typecheck` → exits 0. `pnpm -r exec node -e "1"` runs in all three packages.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "chore(m0): pnpm monorepo scaffold"`

### Task 2: `shared` — cookie constants + zod schemas

**Files:** Create `packages/shared/src/{cookie,schemas,index}.ts`, `packages/shared/test/schemas.test.ts`. Add `vitest` devDep + `test` script to `packages/shared/package.json`.

**Interfaces — Produces:** `SESSION_COOKIE_NAME='tj_session'`, `COOKIE_DOMAIN='.thinkersjournal.com'`; zod `SignupInput`, `LoginInput`; type `SessionData = { userId:string; roles:string[]; securityEpoch:number; csrfSecret:string; createdAt:number }`.

- [ ] **Step 1: Write the failing test** (`schemas.test.ts`): `SignupInput.safeParse` rejects short password + bad email, accepts a valid payload; asserts `SESSION_COOKIE_NAME==='tj_session'` and `COOKIE_DOMAIN==='.thinkersjournal.com'`.
- [ ] **Step 2: Run → FAIL** (`pnpm --filter @thinkersjournal/shared test`) — module/exports missing.
- [ ] **Step 3: Implement.** `cookie.ts` exports the two consts. `schemas.ts`: `SignupInput = z.object({ email: z.string().email(), password: z.string().min(12), turnstileToken: z.string().min(1) })`; `LoginInput = z.object({ email: z.string().email(), password: z.string().min(1) })`; export the `SessionData` type. `index.ts` re-exports.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): shared cookie consts + zod auth schemas`

### Task 3: `api` Worker skeleton + vitest-pool-workers

**Files:** Create `apps/api/src/index.ts`, `apps/api/src/env.d.ts`, `apps/api/wrangler.jsonc`, `apps/api/vitest.config.ts`, `apps/api/test/{tsconfig.json,env.d.ts,health.test.ts}`. Add `@cloudflare/vitest-pool-workers`, `vitest`, `wrangler` devDeps.

**Interfaces — Produces:** `export default { fetch }` with `GET /health → 200`; `interface Env` (extended each task).

- [ ] **Step 1: Write the failing test** (`health.test.ts`): `import worker from '../src'; import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'` → `worker.fetch(new Request('https://api.test/health'), env, ctx)` expect `status 200`.
- [ ] **Step 2: Run → FAIL** (`pnpm --filter @thinkersjournal/api test`).
- [ ] **Step 3: Implement.**
  - `wrangler.jsonc`: `{ "name":"thinkersjournal-api", "main":"src/index.ts", "compatibility_date":"2026-07-13", "compatibility_flags":["nodejs_compat"], "observability":{"enabled":true} }`
  - `vitest.config.ts`: `import { defineConfig } from 'vitest/config'; import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; export default defineConfig({ plugins:[cloudflareTest({ wrangler:{ configPath:'./wrangler.jsonc' } })] })`
  - `test/env.d.ts`: `declare module 'cloudflare:workers' { interface ProvidedEnv extends Env {} }`; `test/tsconfig.json` adds `"types":["@cloudflare/vitest-pool-workers/types"]`.
  - `src/index.ts`: minimal router returning 200 for `/health`, 404 otherwise.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): api Worker skeleton + vitest-pool-workers harness`

### Task 4: Argon2id password module (`hash-wasm`)

> ⚠️ **AS BUILT, THIS TASK USED THE `argon2id` PACKAGE, NOT `hash-wasm`** — every `hash-wasm` mention in the steps below is a planning artifact and is now known wrong. See *As-built deviations (M0)* → **A**.

**Files:** Create `apps/api/src/auth/password.ts`, `apps/api/test/password.test.ts`. Add `hash-wasm` dep.

**Interfaces — Produces:** `hashPassword(pw:string):Promise<string>` (PHC encoded), `verifyPassword(pw:string, hash:string):Promise<boolean>`, `CURRENT_ARGON2_PARAMS`, `needsRehash(hash:string):boolean`.

- [ ] **Step 1: Write failing test:** round-trip `verifyPassword(pw, await hashPassword(pw))===true`; wrong pw `false`; hash starts with `$argon2id$v=19$`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (`password.ts`): `import { argon2id, argon2Verify } from 'hash-wasm'`; `CURRENT_ARGON2_PARAMS = { parallelism:1, iterations:2, memorySize:19456, hashLength:32 }`; `hashPassword`: `salt = crypto.getRandomValues(new Uint8Array(16))`, `return argon2id({ password:pw, salt, ...CURRENT_ARGON2_PARAMS, outputType:'encoded' })`; `verifyPassword`: `argon2Verify({ password:pw, hash })`; `needsRehash` parses the encoded params and compares.
- [ ] **Step 4: Run → PASS** (first-call WASM warm-up latency is expected).
- [ ] **Step 5: Commit.** `feat(m0): Argon2id password hashing via hash-wasm`

### Task 5: Local Postgres + migrations (`users`, `profiles`)

**Files:** Create `docker-compose.yml`, `apps/api/migrations/0001_users_and_profiles.sql`, `apps/api/test/setup.ts`; add `node-pg-migrate` + `migrate`/`migrate:test` scripts to `apps/api/package.json`.

**Interfaces — Produces:** schema `users(id uuid pk, email citext unique, password_hash text, email_verified_at timestamptz null, created_at)` + `profiles(user_id uuid pk → users, username citext unique, display_name, bio, created_at)`; `extension citext`. Vitest `setupFiles` runs migrations against `thinkersjournal_test`.

- [ ] **Step 1:** `docker-compose.yml` runs `postgres:16` on `:5432` creating both dbs; `docker compose up -d`.
- [ ] **Step 2: Write failing migration test:** after `up`, `information_schema.columns` shows `users.password_hash` + `users.email_verified_at` and `profiles.user_id` FK; `down` drops both. (Points at `postgres://postgres:postgres@localhost:5432/thinkersjournal_test`.)
- [ ] **Step 3: Run → FAIL** (no migration yet).
- [ ] **Step 4: Implement** migration `0001` with the schema above (`CREATE EXTENSION IF NOT EXISTS citext;` first). `setup.ts` runs `node-pg-migrate up` programmatically against `$TEST_DATABASE_URL` before DB tests.
- [ ] **Step 5: Run → PASS** (`npx node-pg-migrate up -d $TEST_DATABASE_URL` then the test).
- [ ] **Step 6: Commit.** `feat(m0): docker postgres + users/profiles migration`

### Task 6: `pg`-over-Hyperdrive client + Hyperdrive bindings

**Files:** Create `apps/api/src/db/client.ts`, `apps/api/test/db.test.ts`; edit `apps/api/wrangler.jsonc` (hyperdrive block) + `apps/api/vitest.config.ts` (`miniflare.hyperdrives`). Add `pg` dep. Update `Env`.

**Interfaces — Produces:** `withClient<T>(hd:Hyperdrive, fn:(c:pg.Client)=>Promise<T>):Promise<T>`; bindings `HYPERDRIVE_CACHED`, `HYPERDRIVE_FRESH`.

- [ ] **Step 1: Write failing test** (`db.test.ts`): insert a user via `env.HYPERDRIVE_FRESH` then `SELECT` it back through `withClient` → row matches.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  - `wrangler.jsonc` add: `"hyperdrive":[{"binding":"HYPERDRIVE_CACHED","id":"<cached-id>"},{"binding":"HYPERDRIVE_FRESH","id":"<fresh-id>"}]` (fresh created later with `--caching-disabled`; ids are placeholders until Task 6b).
  - `vitest.config.ts` add `miniflare:{ hyperdrives:{ HYPERDRIVE_CACHED: process.env.TEST_DATABASE_URL, HYPERDRIVE_FRESH: process.env.TEST_DATABASE_URL } }` to the `cloudflareTest()` options.
  - `client.ts`: `withClient` builds `new pg.Client({ connectionString: hd.connectionString })`, `connect()`, runs `fn`, and `end()`s via `ctx.waitUntil` in `finally`. **Client, not Pool.**
- [ ] **Step 4: Run → PASS** (proves `pg` over `nodejs_compat` + the miniflare hyperdrive override).
- [ ] **Step 5: Commit.** `feat(m0): pg-over-Hyperdrive client + dual bindings`
- [ ] **Step 6 (6b, deferred to first real deploy/CI):** create the two Hyperdrive configs against the **direct** Neon string: `wrangler hyperdrive create tj-cached --connection-string=...` and `... tj-fresh ... --caching-disabled`; paste the returned ids into `wrangler.jsonc`. *(No code change; a provisioning step.)*

### Task 7: Opaque KV session primitive

**Files:** Create `apps/api/src/auth/session.ts`, `apps/api/test/session.test.ts`; edit `wrangler.jsonc` (`kv_namespaces`). Update `Env`.

**Interfaces — Produces:** `createSession(env, data:SessionData):Promise<{cookie:string}>`, `readSession(env, request):Promise<SessionData|null>`, `destroySession(env, request):Promise<{cookie:string}>`; binding `SESSIONS`.

- [ ] **Step 1: Write failing test:** `createSession` → `readSession(request with that cookie)` returns the same `userId`/`securityEpoch`; `destroySession` deletes the KV key + returns a `Max-Age=0` cookie; cookie string contains `HttpOnly; Secure; SameSite=Lax`. `beforeEach` clears `env.SESSIONS`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `wrangler.jsonc` add `"kv_namespaces":[{"binding":"SESSIONS","id":"<id>"}]`. `session.ts`: `token = base64url(crypto.getRandomValues(new Uint8Array(32)))`; `key = 'sess:'+sha256Hex(token)`; `SESSIONS.put(key, JSON.stringify(data), { expirationTtl: 2592000 })`; cookie string per Global Constraints. `readSession` reads the `tj_session` cookie, hashes it, `SESSIONS.get`. `destroySession` deletes + returns cleared cookie.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): opaque KV session primitive`

### Task 8: `UserSecurityDO` (SQLite monotonic epoch)

**Files:** Create `apps/api/src/durable-objects/UserSecurityDO.ts`; edit `src/index.ts` (export the class), `wrangler.jsonc` (`durable_objects` + `migrations`), `apps/api/test/user-security-do.test.ts`. Update `Env`.

**Interfaces — Produces:** DO class `UserSecurityDO` with RPC `getEpoch():Promise<number>` + `bumpEpoch():Promise<number>`; binding `USER_SECURITY`; addressed `env.USER_SECURITY.getByName(userId)`.

- [ ] **Step 1: Write failing test:** default `getEpoch()===0`; `bumpEpoch()` returns `1` then `2`; after `evictAllDurableObjects()`, `getEpoch()` still returns the bumped value.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `wrangler.jsonc` add `"durable_objects":{"bindings":[{"name":"USER_SECURITY","class_name":"UserSecurityDO"}]}` and `"migrations":[{"tag":"v1","new_sqlite_classes":["UserSecurityDO"]}]`. DO: constructor `blockConcurrencyWhile` creates `security(id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0)` seeded `id=1,epoch=0`; `getEpoch` = `SELECT epoch`; `bumpEpoch` = `UPDATE … epoch=epoch+1 RETURNING epoch`. Export the class from `src/index.ts`.
- [ ] **Step 4: Run → PASS** (persistence across eviction proves durable SQLite).
- [ ] **Step 5: Commit.** `feat(m0): UserSecurityDO revocation epoch`

### Task 9: Turnstile siteverify helper

**Files:** Create `apps/api/src/auth/turnstile.ts`, `apps/api/test/turnstile.test.ts`; add `TURNSTILE_SECRET_KEY` to `.dev.vars` (dummy always-pass). Update `Env`.

**Interfaces — Produces:** `verifyTurnstile(env, token:string, remoteip?:string):Promise<boolean>`.

- [ ] **Step 1: Write failing test:** with the dummy always-pass secret → `true`; swap to always-block → `false`. (Either hit the real endpoint with dummy keys, or mock `fetch` and assert the POST shape.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** POST `https://challenges.cloudflare.com/turnstile/v0/siteverify` with JSON `{ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip }`; return `(await res.json()).success === true`. Never cache the result (tokens are single-use, 300s).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): Turnstile server-side verification`

### Task 10: Rate-limit binding + enforce helper

> ⚠️ **THE KEY IS THE PLURAL `ratelimits`** — the singular `ratelimit` written in the steps below is hard-rejected by wrangler. Still top-level. See *As-built deviations (M0)* → **B**.

**Files:** Create `apps/api/src/auth/ratelimit.ts`, `apps/api/test/ratelimit.test.ts`; edit `wrangler.jsonc` (top-level `ratelimit`). Update `Env`.

**Interfaces — Produces:** `enforceRateLimit(limiter, key:string):Promise<Response|null>` (429 or null); bindings `SIGNUP_LIMITER`, `LOGIN_LIMITER`.

- [ ] **Step 1: Write failing test:** loop `env.LOGIN_LIMITER.limit({key:'x'})` past the limit → helper returns a 429 once `success` flips false.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `wrangler.jsonc` **top-level** (not `unsafe`): `"ratelimit":[{"name":"SIGNUP_LIMITER","namespace_id":"1001","simple":{"limit":5,"period":60}},{"name":"LOGIN_LIMITER","namespace_id":"1002","simple":{"limit":10,"period":60}}]` (`period` must be `10` or `60`). Helper: `const { success } = await limiter.limit({ key }); return success ? null : new Response('Too many requests',{status:429})`.
- [ ] **Step 4: Run → PASS** (locally simulated — testing branch logic, not prod thresholds).
- [ ] **Step 5: Commit.** `feat(m0): rate-limit bindings + enforce helper`

### Task 11: CSRF — Origin check + double-submit token

**Files:** Create `apps/api/src/auth/csrf.ts`, `apps/api/test/csrf.test.ts`.

**Interfaces — Produces:** `checkOrigin(request):boolean`, `csrfTokenFor(session):Promise<string>`, `checkCsrf(request, session):Promise<boolean>`.

- [ ] **Step 1: Write failing test:** POST with allowed Origin + correct `X-CSRF-Token` → both pass; wrong Origin → `checkOrigin` false; missing/incorrect token → `checkCsrf` false; GET/HEAD always pass both.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `ALLOWED_ORIGINS = new Set(['https://thinkersjournal.com','https://www.thinkersjournal.com'])` (+ localhost for dev). `checkOrigin`: GET/HEAD pass; else `Origin` (fallback `Referer` origin) must be in the set. `csrfTokenFor` = `sha256Hex(session.csrfSecret)`. `checkCsrf`: GET/HEAD pass; else timing-safe compare `X-CSRF-Token` to `csrfTokenFor(session)`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): CSRF origin + double-submit token`

### Task 12: Email verification — token + Postmark + verify route

> ⚠️ **THE UNAUTHENTICATED `GET /verify-email` BELOW IS AN ACCOUNT-TAKEOVER VECTOR AND WAS NOT BUILT AS SPECIFIED.** As built the route **requires an authenticated, epoch-current session**, and `consumeVerificationToken` was split into `peek` + `delete`. See *As-built deviations (M0)* → **D**.

**Files:** Create `apps/api/src/auth/email-verify.ts`, `apps/api/src/routes/verify-email.ts`, `apps/api/src/routes/__test.ts`, `apps/api/test/email-verify.test.ts`; add `POSTMARK_SERVER_TOKEN` + `TEST_ROUTES=1` to `.dev.vars`. Update `Env`.

**Interfaces — Produces:** `createVerificationToken(env, userId):Promise<string>` (raw token), `consumeVerificationToken(env, token):Promise<string|null>` (one-time), `sendVerificationEmail(env, email, url):Promise<void>`; route `GET /verify-email?token=…`; gated `GET /__test/last-verify-token`.

- [ ] **Step 1: Write failing test:** `createVerificationToken` then `consume` returns the userId; a second `consume` returns `null` (one-time). `GET /verify-email?token=…` sets `email_verified_at` (assert via a `HYPERDRIVE_FRESH` SELECT). Postmark send mocked — assert headers/body shape.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `createVerificationToken`: `token=random(32)`; `SESSIONS.put('verify-email:'+sha256Hex(token), userId, { expirationTtl: 86400 })`; return raw token. `consume`: read then delete (one-time), return userId or null. `sendVerificationEmail`: POST `https://api.postmarkapp.com/email`, header `X-Postmark-Server-Token`, `From` a confirmed sender, `MessageStream:'outbound'`. `verify-email` route: consume → `UPDATE users SET email_verified_at=now()` via `HYPERDRIVE_FRESH`. `__test.ts`: only mounted when `env.TEST_ROUTES` — returns the last token.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): email verification tokens + Postmark + verify route`

### Task 13: Soft email-verification gate

**Files:** Create the gate in `apps/api/src/auth/pipeline.ts` + `apps/api/src/routes/posts.ts` (stub content route) + `apps/api/test/soft-gate.test.ts`.

**Interfaces — Produces:** `requireVerifiedEmail(env, session):Promise<Response|null>` (403 `{code:'EMAIL_NOT_VERIFIED'}` or null), applied to content-mutation routes only.

- [ ] **Step 1: Write failing test:** unverified user + valid session → `POST /posts` → 403 `EMAIL_NOT_VERIFIED`; set `email_verified_at` → passes; a `GET` feed route with the same unverified session → 200.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** `requireVerifiedEmail` SELECTs `email_verified_at` via `HYPERDRIVE_FRESH`; null → 403 JSON. Wire into the mutating pipeline for content routes only (not auth routes, not GETs).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): soft email-verification gate`

### Task 14: Signup handler

> ⚠️ **TWO GAPS IN THE STEPS BELOW HAD TO BE FILLED:** the handler must **generate** a `username` (the schema requires one; `SignupInput` has no such field), and an **unverified** duplicate email is a **re-signup** (not a fall-through to INSERT, which would 500 on the `users.email` unique index) whose `bumpEpoch()` is **security-load-bearing**. See *As-built deviations (M0)* → **E** and **D**.

**Files:** Create `apps/api/src/routes/signup.ts`, `apps/api/test/signup.test.ts`; wire route in `src/index.ts`.

**Interfaces — Consumes:** every auth helper above. **Produces:** `POST /auth/signup`.

- [ ] **Step 1: Write failing test:** valid payload + dummy-pass Turnstile → 201, `Set-Cookie` present, `users`+`profiles` rows exist, verification token stored; duplicate **verified** email → 409; weak password → 400 (zod); Turnstile always-block → 403; over rate-limit → 429.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — ordered: parse `SignupInput`; `enforceRateLimit(SIGNUP_LIMITER, ip+':'+email)`; `verifyTurnstile`; `checkOrigin`; dup check `SELECT … WHERE email=$1 AND email_verified_at IS NOT NULL` via `HYPERDRIVE_FRESH` → 409 if exists; `hashPassword`; `BEGIN; INSERT users; INSERT profiles; COMMIT` (single tx); `createVerificationToken` + `sendVerificationEmail`; `epoch = USER_SECURITY.getByName(userId).getEpoch()`; `createSession({ userId, roles:[], securityEpoch:epoch, csrfSecret:random, createdAt:Date.now() })`; return 201 + `Set-Cookie`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): signup handler`

### Task 15: Login handler

**Files:** Create `apps/api/src/routes/login.ts`, `apps/api/test/login.test.ts`; wire route.

**Interfaces — Produces:** `POST /auth/login`.

- [ ] **Step 1: Write failing test:** correct creds → 200 + session whose `securityEpoch` matches the DO; wrong password → 401 (generic body); nonexistent email → 401 (identical body, no enumeration); user hashed with weaker params → login rehashes (`password_hash` changes).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** `enforceRateLimit(LOGIN_LIMITER, ip+':'+email)`; `SELECT id,password_hash FROM users WHERE email=$1` via `HYPERDRIVE_FRESH`; if no row or `!verifyPassword` → 401 generic; if `needsRehash` → `UPDATE password_hash`; `securityEpoch = await USER_SECURITY.getByName(id).getEpoch()`; `createSession(...)`; 200 + `Set-Cookie`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): login handler with rehash-on-upgrade`

### Task 16: Mutating-request pipeline + epoch revocation

**Files:** Extend `apps/api/src/auth/pipeline.ts`; edit `src/index.ts` (router applies the pipeline to non-GET routes); `apps/api/test/epoch-revoke.test.ts`.

**Interfaces — Produces:** `runMutatingPipeline(request, env, ctx, opts)` composing: `checkOrigin` → `readSession` (401 if none) → `checkCsrf` → `checkSecurityEpoch` → (content routes) `requireVerifiedEmail` → (sensitive) rate-limit → handler.

- [ ] **Step 1: Write failing test:** login → cookie; `USER_SECURITY.getByName(userId).bumpEpoch()`; next `POST /posts` with that cookie → 401 + cleared cookie; a `GET` with the same stale cookie → still 200.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** `checkSecurityEpoch`: if `await getByName(session.userId).getEpoch() !== session.securityEpoch` → `destroySession` + 401. Apply the ordered chain to all non-GET routes; GET/HEAD skip session/epoch/CSRF.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): mutating pipeline + epoch revocation`

### Task 17: Logout + logout-all

**Files:** Create `apps/api/src/routes/logout.ts`, `apps/api/test/logout.test.ts`; wire routes.

**Interfaces — Produces:** `POST /auth/logout`, `POST /auth/logout-all`.

- [ ] **Step 1: Write failing test:** logout → session key gone from KV, later `readSession` null; logout-all → epoch incremented, a second pre-existing session for the same user gets 401 on its next mutating request.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** `logout` = `destroySession` + 200 + cleared cookie; `logout-all` = `USER_SECURITY.getByName(userId).bumpEpoch()` + destroy current session.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(m0): logout + logout-all`

### Task 18: `web` Astro app + Cloudflare adapter + Service Binding

> ⚠️ **THE ASTRO LITERALS BELOW ARE STALE** — `platformProxy`, `Astro.locals.runtime.env` and `dist/_worker.js` do **not** exist in the installed Astro 7 / adapter 14, and "do not enable the Sessions API" is not achieved by leaving it unset. See *As-built deviations (M0)* → **G**.

**Files:** Create `apps/web/astro.config.mjs`, `apps/web/wrangler.jsonc`, `apps/web/src/pages/{index,signup,login,verify-email,new-post}.astro`, `apps/web/src/lib/api.ts`, `apps/web/tsconfig.json`. Run `npx astro add cloudflare` in `apps/web`.

**Interfaces — Consumes:** the `api` Worker via `env.API` Service Binding.

- [ ] **Step 1: Write failing test** (E2E-lite): a page that calls `env.API.fetch('/health')` should render the api's 200 payload. (Assert after Step 3 via `wrangler dev`.)
- [ ] **Step 2: Implement.** `astro.config.mjs`: `adapter: cloudflare({ platformProxy:{ enabled:true } }), output:'server'`. `wrangler.jsonc`: `name:'thinkersjournal-web'`, `compatibility_flags:['nodejs_compat']`, assets binding `ASSETS`, `"services":[{"binding":"API","service":"thinkersjournal-api"}]` (service = the api Worker **name**). `api.ts` wraps `Astro.locals.runtime.env.API.fetch(...)`. Pages post to `/auth/*` through it. **Do not** enable Astro's Sessions API.
- [ ] **Step 3: Verify.** `pnpm --filter @thinkersjournal/web astro build` emits `dist/_worker.js`; `wrangler dev -c apps/web/wrangler.jsonc -c apps/api/wrangler.jsonc` — a page calling `env.API.fetch('/health')` renders the api's 200.
- [ ] **Step 4: Commit.** `feat(m0): web Astro app + Service Binding to api`

### Task 19: Playwright E2E across both Workers + Workers Builds deploy

> ⚠️ **THE SINGLE-PROCESS `wrangler dev -c web -c api` BELOW CANNOT WORK** — an auxiliary Worker has no address, so the api's `__test` route is unreachable from the test. As built the api runs as its own primary on `:8788` with a cross-process Service Binding (DEV ONLY). See *As-built deviations (M0)* → **G6**.

**Files:** Create `playwright.config.ts`, `e2e/signup.spec.ts`; document Workers Builds config in the repo README.

**Interfaces — Consumes:** both Workers running under one `wrangler dev`.

- [ ] **Step 1: Write failing E2E** (`signup.spec.ts`): fill the signup form (dummy Turnstile), assert "check your email"; fetch the token via `GET /__test/last-verify-token`; `GET /verify-email?token=…`; assert verified; `POST` a new post succeeds (unverified would 403).
- [ ] **Step 2: Configure Playwright.** `webServer.command: 'wrangler dev -c apps/web/wrangler.jsonc -c apps/api/wrangler.jsonc --port 8787'`, `url:'http://127.0.0.1:8787'` (web primary), `TEST_ROUTES=1` + dummy Turnstile in the dev env.
- [ ] **Step 3: Run → GREEN** (`pnpm exec playwright test`).
- [ ] **Step 4: Commit.** `test(m0): end-to-end signup→verify→post across both Workers`
- [ ] **Step 5 (provisioning, at first deploy):** Two Workers Builds projects on the one repo: **api** — root `apps/api`, deploy `npx wrangler deploy`, watch paths `apps/api/**` + `packages/shared/**`, secrets `TURNSTILE_SECRET_KEY`, `POSTMARK_SERVER_TOKEN`, real Hyperdrive/KV ids, **`TEST_ROUTES` unset**; **web** — root `apps/web`, build `pnpm install && pnpm --filter @thinkersjournal/web astro build`, deploy `npx wrangler deploy`, watch `apps/web/**` + `packages/shared/**`. First deploy targets `*.workers.dev`. Smoke-hit `/health` + a rendered page.

---

## As-built deviations (M0)

*Written 2026-07-14, after M0 was built and reviewed. The task steps above are a record of what was **planned**; this section records where reality differed and is **authoritative where the two disagree**. Everything here was verified against the installed toolchain during the build. The Global Constraints + Tech Stack above have been corrected to match; the per-task steps have not been rewritten, only annotated.*

### A. Argon2id library — `hash-wasm` is non-viable on Workers (Task 4)

`hash-wasm` **cannot run in Cloudflare Workers at all.** It compiles its embedded base64 WASM at runtime via `WebAssembly.compile()`, and workerd forbids runtime Wasm code generation: `CompileError: Wasm code generation disallowed by embedder`. **This fails in production too, not just under test** — it is not a harness artifact.

**As built:** the openpgpjs **`argon2id`** package (v1.0.1), driven by a **statically-imported `.wasm` module**. `WebAssembly.instantiate(module, …)` on an already-compiled `Module` *is* allowed, and a static `import mod from "*.wasm"` yields exactly that — wrangler auto-applies its default `**/*.wasm` → `CompiledWasm` rule, so **no explicit `rules` entry was needed**. See the header of `apps/api/src/auth/password.ts`.

**Unchanged:** Argon2id itself, the PHC string format, and the OWASP params `{ parallelism:1, iterations:2, memorySize:19456, hashLength:32 }`.

**Note:** any Argon2id on Workers requires the **Paid** plan (already implied by DO-SQLite + Hyperdrive).

### B. The wrangler rate-limit key is the plural `ratelimits` (Task 10)

Verified against **wrangler 4.110.0**: the correct config key is the top-level **`ratelimits`**. The singular `ratelimit` — as the original Global Constraint and Task 10 both said — is **hard-rejected** by wrangler's config validator (`Unexpected fields found in top-level field: 'ratelimit'`), so it is not a cosmetic difference: it fails the build. Still **top-level**, still **not** under `unsafe`. `simple.period` must be `10` or `60`. The verified note lives in `apps/api/wrangler.jsonc`.

### C. TypeScript is pinned to exactly `6.0.3` (do not upgrade to 7.x)

TypeScript **7.0** (GA 2026-07-08) is the Go-native rewrite and ships **without the programmatic Compiler API** until 7.1. Astro (`astro check`), vitest's TS integration, and typescript-eslint all need that API, so the whole toolchain breaks on 7.x. The repo pins **exactly `6.0.3`** (no caret) — the last JS-based line with the full API. Revisit no earlier than TS 7.1, and only by verifying each consumer.

### D. Email verification now REQUIRES authentication — a security fix (Task 12)

**The plan's unauthenticated `GET /verify-email?token=…` was an account-takeover vector** once signup allowed re-signup on an unverified duplicate (deviation E):

> victim signs up (token **T1** mailed) → attacker re-signs-up the same address (the password becomes **the attacker's**) → victim clicks **T1** → the account is verified **with the attacker's password**.

**As built:** `GET /verify-email` requires an authenticated session whose `userId` matches the token's **and** whose `securityEpoch` matches the DO's current epoch; otherwise **401 `{"code":"LOGIN_REQUIRED"}`**. The token is **not burned on an auth failure**, so a legitimate user who clicks the link before logging in can log in and re-click the same link. `consumeVerificationToken` was therefore split into **`peekVerificationToken`** + **`deleteVerificationToken`**, with the delete only on the successful verify path.

**Companion change, mandatory:** re-signup calls **`bumpEpoch()`**. Without it the victim's surviving session satisfies the auth check by itself and the takeover stands. **These two changes are one fix — do not carry either forward alone.**

**Residual, owner-accepted:** an attacker can still overwrite an **unverified** account's password, so the victim's password stops working (an annoyance). The victim recovers by re-signing-up to reclaim the row, then verifying. **The email owner always wins, because only they receive tokens.**

### E. Signup — two gaps in the plan that had to be filled (Task 14)

1. **Username generation.** `profiles.username` is `NOT NULL UNIQUE`, but `SignupInput` has **no username field** — so the handler **generates** one (sanitized email local-part + random suffix), retrying on a PG `23505` unique violation inside a **SAVEPOINT** (in Postgres any failed statement poisons the whole transaction, so the savepoint is what makes a retry possible). **User-chosen usernames are M1 profile editing — do not add a username field to signup.**
2. **Unverified duplicates.** The plan 409s only on a **verified** duplicate, but `users.email` is `UNIQUE`, so an **unverified** duplicate would fall through to the INSERT and **500**. As built: verified dup → **409**; unverified dup → **re-signup** (in-transaction `UPDATE password_hash` on the same row + **`bumpEpoch()`**, see D) → **201**. It does not 409 on the unverified path deliberately — that would confirm the address to an enumerator.

**Known follow-up:** the dup-check→INSERT sequence is **not atomic**. Concurrent same-email signups roll back cleanly but surface a **500**; the fix is an atomic guarded upsert. — **RESOLVED in M1 Task 11** — the atomic guarded upsert landed; signup is now one `withClient` and one statement, and concurrent same-email signups can no longer 500.

> **M1 Task 11 note on D's "one fix, do not carry either forward alone".** The upsert changes *how* the password is written, so the `bumpEpoch()` companion had to move with it — it is now issued **inside the transaction, before the `COMMIT`**, rather than before a separately-issued `UPDATE`. Revoke-then-mutate is preserved, and the reason is **visibility, not line order**: the bump is a Durable Object call and is *not* part of the transaction, so committing first and bumping after would leave the attacker's password live with the victim's session **unrevoked and its epoch still matching** — precisely D's takeover state, reachable whenever the bump fails. The `COMMIT` is the gate: no observer can see the new password unless the bump already succeeded. Pinned by *"leaves the OLD password live if a re-signup's epoch bump fails"* (fault-injects the DO; the window only exists when the bump throws, so no non-injecting test can reach it).

### F. The session cookie is environment-aware (Task 7)

The original constraint pinned the cookie exactly: `Path=/; Domain=.thinkersjournal.com; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`. That is correct **production** intent — but with `Domain` + `Secure`, **no browser will store the cookie at `http://127.0.0.1:8787`**, which makes a real-browser E2E (and hand-testing a login on localhost) impossible.

**As built:** the attributes key on the **existing, already-deploy-gated `TEST_ROUTES`** var: when it is exactly `"1"` (dev/CI only) the cookie **omits `Domain` and `Secure` and nothing else**; otherwise it is the exact production string above. Applies to **both** the set and the cleared cookie. Both modes are pinned by `apps/api/test/session.test.ts`, including the literal production string — the suite itself runs with `TEST_ROUTES="1"`, so the production shape would otherwise never be exercised.

**Why reuse that flag rather than add one:** `TEST_ROUTES` is already the most deploy-gated var in the system (it also gates the `__test` token route, an account-takeover vector), so the relaxed cookie is unreachable in production for the *same* reason the test route is, checked by the *same* gate. **One flag, one gate, cannot drift.** A second flag would be a second thing to get wrong, and its failure mode — a production cookie quietly losing `Secure` — is a plaintext-interception bug no test would catch. The check is an explicit `=== "1"` allowlist, never truthiness: wrangler vars are strings, so `"0"` and `"false"` are both truthy.

### G. Web/Astro realities (Tasks 18–19)

Verified against the **installed astro@7.0.9 + @astrojs/cloudflare@14.1.3**. Most adapter tutorials are written for v9–v12 and are wrong here.

1. **`platformProxy` does not exist** in adapter v14 and passing it is a config error. It was the v9-era way to fake bindings inside a Node dev server; v14 runs `astro dev` inside **real workerd**, so bindings (including the `API` Service Binding) are genuine and there is no proxy to enable.
2. **`Astro.locals.runtime.env` was REMOVED in Astro v6** and **throws** on access under the installed v7. Use **`import { env } from "cloudflare:workers"`** (done once, in `apps/web/src/lib/api.ts`).
3. **The build emits `dist/server/`, not `dist/_worker.js`.**
4. **`wrangler dev -c apps/web/wrangler.jsonc` cannot work** — the source config has no `main` and no `assets.directory` because the adapter injects both at build time. Point wrangler at the **generated** `apps/web/dist/server/wrangler.json`, which means **build first**.
5. **Astro's Sessions API must be ACTIVELY disabled** — the Global Constraint says don't use it, and *leaving it unset does not achieve that*. Astro 7 has no `session: false`, and the adapter does `if (!session?.driver) { session = cloudflareKVBinding(...) }` — i.e. unset **silently opts into a KV session store and injects a `SESSION` KV binding** for Cloudflare to auto-provision. Setting any **non-KV** driver is what turns it off (the adapter gates the binding on the driver entrypoint). As built: a literal `{ entrypoint: "unstorage/drivers/memory" }`, which is inert and declares no binding. The full reasoning is in `apps/web/astro.config.mjs` — **do not remove that block.**
6. **The E2E cannot use a single `wrangler dev -c web -c api` process.** An **auxiliary Worker has no address**, so the api's `GET /__test/last-verify-token` — which stands in for the email inbox — would be unreachable. As built the api runs as its **own primary on `:8788`** with a **cross-process Service Binding** from `web` on `:8787`. **This is DEV-ONLY**; the browser only ever touches `:8787`, and production keeps the api binding-only. Same category of affordance as `TEST_ROUTES` itself.

Two further build-order traps are documented at length in `playwright.config.ts` and `scripts/build-web.mjs`: never run `astro build` while a `wrangler dev` is alive (the Service Binding then reports `[connected]` while every dispatch fails with `Network connection lost`), and always build via `pnpm --filter @thinkersjournal/web build`, never `astro build` directly.

### H. Signature + step-order drifts the first reconciliation missed

*Added 2026-07-15 from M0's final whole-branch review. Four places where the built code differs from the task steps above and the earlier pass did not record it. None was a defect; each is a deviation someone reading the plan would otherwise trip over.*

1. **`withClient` takes `ctx` (Task 6).** Planned as `withClient(hd, fn)`; **as built `withClient(hd, ctx, fn)`**. The `ExecutionContext` is threaded through so the client can be closed via `ctx.waitUntil(client.end())` — the connection is released after the response is returned rather than blocking it, and without `ctx` there is nowhere to hang that work. This is the root deviation the next one inherits.

2. **`requireVerifiedEmail` takes `ctx` (Task 13).** Planned as `requireVerifiedEmail(env, session)`; **as built `requireVerifiedEmail(env, ctx, session)`**, purely to satisfy (1) — it reads `users.email_verified_at` and therefore needs `withClient`'s 3-arg form. `ctx` is the SECOND parameter (`env, ctx, session`), matching the argument order every other DB-touching helper in the Worker uses. Noted in the function's own header; recorded here because the plan's signature is what a reader would otherwise write.

3. **The ROUTER does not apply the pipeline — each HANDLER does (Task 16, Step 3).** The step says "the router applies the pipeline to all non-GET routes". **As built `src/index.ts` only dispatches**, and each handler calls `runMutatingPipeline` itself. That is deliberate: it is what lets a route own its own opt-ins (`requireVerifiedEmail` for `POST /posts`, deliberately NOT for logout), which a blanket router-level wrap could not express. Its cost is that "every mutating route is protected" became a **convention** rather than a structural guarantee — a future route that forgets the call ships an unauthenticated mutation with every test still green.

   **Compensating control: `apps/api/test/route-protection.test.ts`.** It reads the router's own source, enumerates the non-GET (method, path) pairs it matches, and asserts default-deny on each (no `Origin` → 403; no session → 401/403). A new mutating route is covered the moment it is added to the router, with no one having to remember this file. Signup and login are the only exemptions (`PIPELINE_EXEMPT`), and they still get asserted — that they enforce `checkOrigin` **inline**, which is their entire CSRF defense given they have no session. Adding to that set is a reviewable security decision, not a way to quiet a red test.

4. **Signup/login check the origin BEFORE the rate limiter.** Both routes' step lists put rate limiting first. **As built `checkOrigin` runs first**, matching the rule `src/auth/pipeline.ts` states for every other mutating route: *"rate limit last: quota is spent only by a request that is otherwise fully entitled to proceed, so unauthenticated noise cannot burn a real user's budget."* The old order inverted that and was exploitable: a page on evil.com makes a victim's browser POST `/auth/login` with the victim's address (a `text/plain` body dodges the CORS preflight, so the request is really sent), each one burns a slot in the **victim's own** bucket before 403ing, and ~10 of them deny the victim login for up to 60s. `checkOrigin` is a pure header comparison with **zero I/O**, so nothing is lost by moving it up, and **both orders satisfy the binding Global Constraint** ("`checkOrigin` before touching the DB") — which is why this is a deviation and not a correction to the constraint. Pinned by a "spends NO quota on an origin-rejected request" test in both `test/login.test.ts` and `test/signup.test.ts`.

### I. The limiter keys, and what a limiter key can actually buy

*Added 2026-07-15 from the same review.*

Both auth routes were built with a **single** `${ip}:${email}` limiter key, commented as giving two properties: that one address cannot be attacked from many IPs, and that one IP cannot spray many addresses. **The first was never true.** Putting the IP *in* the key gives every IP its own bucket, so N IPs against one address get N × the limit per window — and on `/auth/login`, which has **no Turnstile**, the limiter is the entire brute-force defense.

**As built (final):** each route consumes **two** buckets — the original `${ip}:${email}` **plus** an email-only `email:${email}` — so an address has a ceiling regardless of source IP. Both are keyed on the schema-lowercased email (see `NormalizedEmail`; that coupling is itself a security control), and either bucket's 429 short-circuits.

**And the honest bound:** Cloudflare's rate-limiting binding is documented as a unique limit per key **per Cloudflare location**, and as *"permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system."* So the email-only bucket is a real ceiling **per location**, not a global one. It is worth having anyway — it collapses an *unbounded* per-IP multiplier into a *bounded* per-location one — but no key design can make this binding an exact counter. Anything needing that wants a Durable Object. Recorded in `src/auth/ratelimit.ts`'s header, whose earlier "the binding owns all counting/window logic" read stronger than reality.

---

## Deploy-gate checklist (from the risk analysis)

- [ ] `HYPERDRIVE_FRESH` (cache-disabled) is created and every auth/dup/verify/epoch read uses it — audit the routes.
- [ ] Neon connection string is the **direct** (non-pooled) host (`sslmode=require`), not the PgBouncer endpoint.
- [ ] Postmark `From` is a **confirmed** sender signature / verified domain (silent failure otherwise).
- [ ] Real Turnstile keys set as api secrets; dummy keys never deployed.
- [ ] **`TEST_ROUTES` is unset in prod** and the `__test` route is unreachable (token-exposure = account-takeover) — the deploy check this line asked for now EXISTS: `pnpm smoke:deploy <deployed-api-url>` (`scripts/deploy-smoke.mjs`).
- [ ] Pin `wrangler` + `@cloudflare/vitest-pool-workers` versions; re-verify the `ratelimits`/hyperdrive/DO config shapes against the installed version.
- [ ] Run at least one pre-launch pass on **real** infra — local dev has no real Hyperdrive caching or true rate-limit thresholds. `pnpm smoke:deploy`'s signup step is that pass (Postgres + argon2 + KV + DO in one request).

> **The live, maintained deploy gate is `README.md`'s** — it carries this list plus everything learned during M0 (the `TEST_ROUTES`-gates-two-things check, the api's public `workers.dev` URL, Postmark alerting, the argon2id `.wasm` bundling). Use that one.

## Self-Review

**Spec coverage:** Every M0 deliverable in the design spec maps to tasks — accounts/auth (T4,7,9-17), email verification soft gate (T12-13), sessions (T7), Argon2-via-hash-wasm (T4), `UserSecurityDO` revocation (T8,16-17), CSRF (T11), Turnstile + ratelimit (T9-10), two-Worker topology + Service Binding + Workers Builds (T3,18-19), Hyperdrive dual-binding + pg (T6), `users`/`profiles` migrations (T5). ✅

**Placeholder scan:** No TBD/TODO. The Hyperdrive/KV/DO **ids** and real Turnstile/Postmark secrets are genuinely provisioning-time values (Task 6b, 19-Step-5, deploy-gate), not plan gaps — flagged as explicit provisioning steps.

**Type/interface consistency:** `SessionData` (T2) is produced by `createSession`/`readSession` (T7) and consumed by the pipeline (T16); `HYPERDRIVE_FRESH`/`HYPERDRIVE_CACHED` (T6) are used with the documented fresh-for-auth rule everywhere; `USER_SECURITY.getByName().getEpoch()/bumpEpoch()` (T8) are used consistently in T14-17; `CURRENT_ARGON2_PARAMS`/`needsRehash` (T4) drive the T15 rehash. ✅

**Scope:** M0 only (foundations). Posts/feed/comments/reactions (M1-M2) appear only as the minimal `posts.ts` stub needed to test the soft gate + pipeline. ✅

## Next: Execution

Plan complete. Execution options (same as the website build): **subagent-driven** (recommended — fresh subagent per task + review gates) or **inline**. Provisioning steps (Docker Postgres, Neon, Cloudflare/Turnstile/Postmark) surface just-in-time per the prerequisites table.

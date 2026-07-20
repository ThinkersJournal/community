# Thinker's Journal — Community Platform

![CI](https://github.com/ThinkersJournal/community/actions/workflows/ci.yml/badge.svg)

The flagship of [Thinker's Journal](https://thinkersjournal.com): a public **social publishing platform for thinkers** with **live, precise @-references** into their work (the exact file + lines, CI check, PR, or issue on GitHub/GitLab, plus web/YouTube/X).

> **▶ New session / new agent?** Start with **[`HANDOFF.md`](HANDOFF.md)** — the self-contained entry point (this repo's Claude memory is separate from the marketing-site project).

> **Status:** **M0 (foundations) + M1 (publishing) are built** and not yet deployed; **M2** (social graph) is next. This repository is **private** and stays quiet until the launch scope (M0–M4) is complete.

## Two pillars

- **A — Social publishing:** accounts, Markdown posts + image uploads, public SEO profiles/posts, follow + home feed, comments + reactions, tags + search, notifications, moderation.
- **B — Live @-references (the moat):** snapshot-at-post-time + access-driven live refresh, hover-preview, click-to-open; a connector per source.

## Stack

- **Backend:** a single **TypeScript** Cloudflare Worker (`api`) — Postgres on **Neon** via **Hyperdrive**, **R2** (media), **Workers KV** (cache), **Durable Objects** (sessions/notifications/rate-budgets), Queues, Cron.
- **Frontend:** **Astro** SSR + islands, deployed as the `web` Worker.
- **Monorepo:** `web` (Astro) + `api` (TS backend), joined by a Service Binding.

## Design docs

- [`docs/superpowers/specs/2026-07-13-community-platform-design.md`](docs/superpowers/specs/2026-07-13-community-platform-design.md) — the authoritative design (product, decisions, architecture, cost model, build sequence).
- [`docs/superpowers/specs/2026-07-13-community-platform-architecture-research.md`](docs/superpowers/specs/2026-07-13-community-platform-architecture-research.md) — the deep research + adversarial review behind it.

## Build sequence

`M0` Foundations (auth/identity/deploy spine) → `M1` Publishing → `M2` Social graph → `M3` Reference engine → `M4` Safety/legal + launch. Each milestone gets its own implementation plan under `docs/superpowers/plans/`.

---

## Local development

### Prerequisites

```bash
docker compose up -d                 # Postgres 18, three databases (below)
pnpm install
```

One Postgres 18 server hosts three databases:

| Database | Purpose |
| --- | --- |
| `thinkersjournal` | **Dev.** What `wrangler dev` and the E2E write to. |
| `thinkersjournal_test` | **Shared test fixture.** Every test that needs a schema to query: the `pool` Worker tests (via Hyperdrive) and the non-destructive `node` schema tests. Migrated by vitest's `globalSetup` before every run. |
| `thinkersjournal_migrations_test` | **Owned solely by `test/migrations.db.test.ts`.** |

Why the third database? `migrations.db.test.ts` proves the migration SQL by
*running* it — its `down` drops **every** table in the stack. Vitest runs test
projects **in parallel** (absent `sequence.groupOrder`), so on the shared DB that
drop races the `pool` tests querying `users` through Hyperdrive, giving
intermittent `relation "users" does not exist`. It needs *a* database, not the
*shared* one, so it has its own and the race is structurally impossible. It
manages its own schema (`globalSetup` migrates only the shared DB). Both test DB
URLs default to localhost and are overridable via `TEST_DATABASE_URL` /
`MIGRATIONS_TEST_DATABASE_URL`.

> Upgrading from an M0 checkout? `docker compose down -v` first — **the `-v` is
> required**. PG18 cannot read PG16's data directory and there is no in-place
> major upgrade (the same property that makes the Neon major choice permanent).
> The `-v` wipes ALL THREE databases — both test DBs recreate themselves
> automatically (`globalSetup` migrates `thinkersjournal_test`, and
> `migrations.db.test.ts` migrates its own), but the **dev** DB does not: run
> `pnpm --filter @thinkersjournal/api migrate` once afterward, or `wrangler
> dev`/`pnpm test:e2e` will hit a real Postgres with no `users`/`profiles`
> tables.
>
> **Not** wiping the volume? `db/init/*.sql` runs **only** on the first boot of
> an empty data directory, so a volume older than
> `thinkersjournal_migrations_test` will not have it. You still do not need to
> wipe — `globalSetup` creates that database if it is missing.

### `apps/api/.dev.vars` (gitignored — create it yourself)

`.dev.vars` is where the api's local vars/secrets live. It is **gitignored** (it is
where real secrets go), so a fresh clone will not have it. Create it with:

```ini
# Cloudflare's PUBLISHED always-passes dummy secret. Never deploy this.
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
# Any placeholder. Postmark will reject the send; that is fine — sendVerificationEmail
# logs and returns rather than throwing, so a mail failure never 500s a signup.
POSTMARK_SERVER_TOKEN=dummy-postmark-token
# ⚠️ DEV/CI ONLY — MUST be unset in production. See the deploy gate below: this one
# flag gates BOTH the __test token route AND the session cookie's Domain/Secure.
TEST_ROUTES=1
# The shared secret guarding the api->web purge hop (POST /internal/purge on `web`).
# ⚠️ MUST be byte-identical to apps/web/.dev.vars' PURGE_SECRET, or every purge 403s
# silently (content stale up to 25h). See the web .dev.vars note and the deploy gate.
PURGE_SECRET=dev-purge-secret-not-for-production
```

Neither the test suite nor the E2E depends on this file: `apps/api/vitest.config.ts`
supplies the same values via `miniflare.bindings` (including `PURGE_SECRET`), and
`playwright.config.ts` passes them as `--var` flags, so both are CI-safe on a fresh
checkout. `.dev.vars` is only for running `wrangler dev` by hand.

### `apps/web/.dev.vars` (gitignored — create it yourself)

The `web` Worker needs **one** local secret, and the value **must be byte-identical to
`apps/api/.dev.vars`'s `PURGE_SECRET`**:

```ini
# The shared secret guarding POST /internal/purge (apps/web/src/lib/purge.ts).
# ⚠️ MUST match apps/api/.dev.vars' PURGE_SECRET exactly.
PURGE_SECRET=dev-purge-secret-not-for-production
```

**Why it matters, and why its absence is invisible.** On every publish/edit the `api`
Worker asks `web` to invalidate its cached HTML, over the `WEB` Service Binding (the
purge hop — `api` cannot reach into `web`'s cache). `web` compares this secret in
constant time and **fails closed**. Without the file, `web` has no `PURGE_SECRET`, every
purge **403s**, and the only symptom is an api log line — `cache purge rejected` — while
content stays stale for its full 25h `maxAge+swr` window. A **mismatch between the two
files behaves identically.** Nothing crashes; nothing turns red.

> ⚠️ **This file is read at BUILD time, not at `wrangler dev` time.** The Cloudflare Vite
> plugin (`@cloudflare/vite-plugin`, `src/dev-vars.ts`) copies it to
> **`apps/web/dist/server/.dev.vars`** during the build — a quoted/normalized copy —
> because `wrangler dev -c dist/server/wrangler.json` (the command below) resolves
> `.dev.vars` next to the config it is given, which is the *generated* one. Two
> consequences: create this file **before** building, and **rebuild after changing it**
> or `wrangler dev` keeps serving the old value.

The E2E does not depend on this file — `playwright.config.ts` passes `PURGE_SECRET` to
**both** Workers as `--var`, so a fresh checkout is CI-safe.

### Running both Workers

The `web` Worker is server-rendered Astro; the `api` Worker is reached **only** over the
`API` Service Binding. Two things bite here, both documented at length in
`playwright.config.ts`:

- **Point wrangler at the GENERATED config**, `apps/web/dist/server/wrangler.json` — not
  the source `apps/web/wrangler.jsonc`, which has no `main` and no `assets.directory`
  because `@astrojs/cloudflare` injects both at build time. So **build first**.
- **Never run `astro build` while a `wrangler dev` is alive.** The build's own workerd
  children disturb wrangler's dev registry, and the Service Binding then reports
  `[connected]` while every dispatch through it fails with `Error: Network connection
  lost` (a 500 that looks like an app bug, not a build-order bug).

```bash
# 1. Build FIRST, with no dev server running.
pnpm --filter @thinkersjournal/web build

# 2. Hyperdrive has no real config locally; both bindings resolve to Docker Postgres
#    through these env vars (the var name encodes the binding).
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH="postgres://postgres:postgres@localhost:5432/thinkersjournal"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED="postgres://postgres:postgres@localhost:5432/thinkersjournal"

# 3. Both Workers in ONE process — web primary on :8787, api auxiliary (binding-only,
#    exactly like production). This is the faithful topology; use it for hand-testing.
cd apps/web
pnpm exec wrangler dev -c dist/server/wrangler.json -c ../api/wrangler.jsonc --port 8787
```

> **Always use `pnpm --filter @thinkersjournal/web build`, never `astro build` directly.**
> The build script (`scripts/build-web.mjs`) cleans `dist/` and reaps the workerd
> processes `astro build` leaks — they keep handles on `dist/` and make every subsequent
> build fail on Windows with the misleading `The property 'options.recursive' is no longer
> supported`. See that script's header for the full mechanism.

### Tests

```bash
pnpm --filter @thinkersjournal/api test      # vitest, real workerd + KV + Postgres
pnpm --filter @thinkersjournal/web test      # vitest, plain Node
pnpm --filter @thinkersjournal/shared test
pnpm --filter @thinkersjournal/markdown test # vitest, plain Node
pnpm --filter @thinkersjournal/markdown run check:workerd   # exit 0 (no node:/WASM)
pnpm typecheck                               # all packages
pnpm test:e2e                                # Playwright: real browser, both Workers
```

**Green baseline (M1)** — match these before and after any change (`HANDOFF.md` carries
the authoritative table):

| Suite | Command | Expected |
| --- | --- | --- |
| api | `pnpm --filter @thinkersjournal/api test` | **396** / 31 files |
| web | `pnpm --filter @thinkersjournal/web test` | **276** (+2 skipped) |
| shared | `pnpm --filter @thinkersjournal/shared test` | **17** |
| markdown | `pnpm --filter @thinkersjournal/markdown test` | **93** |
| E2E | `pnpm exec playwright test` | **8** |
| types | `pnpm typecheck` | exit 0 |

`pnpm test:e2e` starts everything it needs (build → api on :8788 → web on :8787) and
requires only Docker Postgres to be up. It writes real users to the **dev** database via
the real signup path and does not clean up, so every run uses a fresh random email.

**The E2E runs the api on its own port (:8788) — a deliberate deviation from production.**
Its verification token must be read from `GET /__test/last-verify-token`, which lives on
the api; an auxiliary (binding-only) Worker has no address, so that route would be
unreachable. The browser still only ever talks to :8787; :8788 stands in for the email
inbox and is a dev-only affordance, in the same category as `TEST_ROUTES` itself.

---

## Deploying (Workers Builds)

**Not yet deployed.** This is the provisioning runbook for the first deploy.

Two **Workers Builds** projects on this one repository, each with its own root directory
and watch paths so a change to one Worker does not redeploy the other. Both need
`packages/shared/**` in their watch paths — it is a workspace dependency of both.

### Project 1 — `thinkersjournal-api`

| Setting | Value |
| --- | --- |
| Root directory | `apps/api` |
| Deploy command | `npx wrangler deploy` |
| Watch paths | `apps/api/**`, `packages/shared/**` |
| Secrets | `TURNSTILE_SECRET_KEY`, `POSTMARK_SERVER_TOKEN`, **`PURGE_SECRET`** (new in M1) |
| Vars | **`TEST_ROUTES` MUST BE UNSET** (see the gate below) |
| Bindings (M1) | `IMAGES` (Cloudflare Images, no subscription/zone) · `MEDIA` (R2 bucket `tj-media`) · `WEB` (Service Binding → `thinkersjournal-web`, the purge hop) — all declared in `apps/api/wrangler.jsonc` |

Before the first deploy, replace the placeholder ids in `apps/api/wrangler.jsonc`:

```bash
wrangler kv namespace create SESSIONS
wrangler hyperdrive create tj-cached --connection-string="postgres://…"
wrangler hyperdrive create tj-fresh  --connection-string="postgres://…" --caching-disabled
wrangler r2 bucket create tj-media                        # the MEDIA binding (M1)
```

`HYPERDRIVE_FRESH` **must** be the `--caching-disabled` config: Hyperdrive never
invalidates on write, so a cached auth/dup-email/verify read is a real security bug.
`IMAGES` needs nothing provisioned (a per-Worker binding, no zone/subscription/base fee);
`PURGE_SECRET` is set via `wrangler secret put` on BOTH Workers — see the M1 provisioning
runbook below.

### Project 2 — `thinkersjournal-web`

| Setting | Value |
| --- | --- |
| Root directory | `apps/web` |
| Build command | `pnpm install && pnpm --filter @thinkersjournal/web astro build` |
| Deploy command | `npx wrangler deploy` |
| Watch paths | `apps/web/**`, `packages/shared/**` |
| Secrets | **`PURGE_SECRET`** (new in M1 — byte-identical to the api's), via `wrangler secret put` |
| Bindings (M1) | `API` (Service Binding → `thinkersjournal-api`) · Workers Cache (`cache: { enabled: true }` + the Astro cache provider in `astro.config.mjs`) — see the gate on the cache off-switch |

The `API` Service Binding resolves by Worker **name** (`thinkersjournal-api`), so the api
must be deployed first. First deploy targets `*.workers.dev` — including the api's own
`thinkersjournal-api.<subdomain>.workers.dev`, which is public by default (see the deploy
gate). ⚠️ **The `web → api` and `api → web` (purge) Service Bindings are CIRCULAR** — the
first deploy is order-dependent; follow the M1 provisioning runbook below.

> ⚠️ **Two DIFFERENT `PURGE_SECRET` sources — do not confuse them.** In **production**,
> `web`'s secret comes from `wrangler secret put PURGE_SECRET` (injected at runtime,
> rotatable without a rebuild). In **local `wrangler dev`**, it instead comes from
> `apps/web/.dev.vars`, which the Cloudflare Vite plugin copies into `dist/server/` **at
> BUILD time** — so a local change to that file needs a rebuild to take effect (create it
> before building; see the `apps/web/.dev.vars` note above). Either way the value must be
> **byte-identical to the api's**, or every purge 403s silently.

### M1 provisioning (do these before the first M1 deploy)

```bash
wrangler r2 bucket create tj-media
# PURGE_SECRET: ONE high-entropy value, set on BOTH Workers. They must match, or
# every purge 403s silently and content is stale for up to 25 hours.
openssl rand -base64 32                         # generate once
cd apps/api && wrangler secret put PURGE_SECRET
cd ../web  && wrangler secret put PURGE_SECRET
```

| Setting | Value |
| --- | --- |
| Neon Postgres major | **18** — Neon's default for new projects since 2026-06-05 |
| Neon connection string | the **DIRECT** (non-pooled) host with `sslmode=require`, NOT the PgBouncer/pooler endpoint (feeding Hyperdrive Neon's pooler double-pools) |
| R2 bucket | `tj-media`, bound as `MEDIA` on `api` |
| R2 custom domain | `cdn.thinkersjournal.com` (requires a zone) |
| Images binding | `IMAGES` on `api` — **no subscription, no zone, no base fee** |
| Secrets (both Workers) | `PURGE_SECRET` — identical value; ⚠️ on `web` it is baked in at BUILD time (rebuild + redeploy to change it) |

⚠️ **First-deploy order, because the Service Bindings are now CIRCULAR**
(`web → api` for everything, `api → web` for purge). `wrangler deploy` resolves
the target service **by name**, and on a first deploy neither exists:

1. Comment out `"services"` in `apps/api/wrangler.jsonc` → deploy `api`.
2. Deploy `web` (its `API` binding now resolves).
3. Restore `"services"` in `apps/api/wrangler.jsonc` → redeploy `api`.

Every later deploy is order-independent. (The `api`'s `services` block is pinned by
`apps/api/test/purge-binding.node.test.ts` — deleting it leaves every api test green
while production gets `env.WEB === undefined` and purges die silently.)

The **CDN zone** (for `cdn.thinkersjournal.com`) also needs three zone-level settings
before media is safe to serve — all in the deploy gate: a **Cache Rule** (Cache
Everything + long Edge TTL), a **Transform Rule** adding `X-Content-Type-Options:
nosniff`, and the **CSAM Scanning Tool** activated.

### Post-deploy smoke check (`pnpm smoke:deploy`)

**Run this against the deployed api before pointing DNS at it.** It is the concrete,
runnable form of two gate items that used to be prose (`TEST_ROUTES` unset; "one pass on
real infra"), and it exits non-zero with a named failure:

```bash
pnpm smoke:deploy https://thinkersjournal-api.<subdomain>.workers.dev \
  --turnstile-token '<a freshly-solved Turnstile token>'
```

| # | Assertion | What a failure means |
| --- | --- | --- |
| 1 | `GET /__test/last-verify-token` → **404** | `TEST_ROUTES` leaked into prod — the route hands out a live verification token (account takeover). |
| 2 | `GET /health` → **200** | The api is not serving. |
| 3 | A real signup → **201** | Hyperdrive/Neon, the argon2id `.wasm` bundling, the KV write, or the DO round-trip is broken on real infra. |
| 4 | That signup's `Set-Cookie` carries **`Secure`** *and* **`Domain=.thinkersjournal.com`** | `TEST_ROUTES` leaked — session tokens are riding plaintext http. |

**Why a `curl`-shaped check and not a browser.** The first deploy is on `*.workers.dev`,
which is **not** in `ALLOWED_ORIGINS`, and the session cookie is scoped to
`Domain=.thinkersjournal.com` — so from a *browser* on the workers.dev URL every POST
403s and the cookie is rejected. The browser path simply **cannot** be validated before
cutover. But `checkOrigin` reads a *client-supplied* header and the api has a public URL,
so a non-browser client closes the gap completely:

```bash
curl -X POST https://thinkersjournal-api.<sub>.workers.dev/auth/signup \
  -H 'Origin: https://thinkersjournal.com' -H 'content-type: application/json' \
  -d '{"email":"smoke-<uuid>@example.com","password":"<12+ chars>","turnstileToken":"<real>"}'
```

A **201** proves Hyperdrive connectivity **+** the argon2id `.wasm` bundling **+** the KV
write **+** the DO round-trip, on **real** infra. That is not a bypass: the Origin
allowlist defends *browsers* (a page on evil.com cannot forge the header), never scripts —
the api's real guards against those are `TEST_ROUTES` unset, CSRF, and the session/epoch
checks. `scripts/deploy-smoke.mjs` is exactly this request, plus the cookie assertion.

> ⚠️ It writes a **real, unverified user** to the production DB (a per-run
> `smoke-<uuid>@example.com`). That is the point — a dry run proves nothing about
> Hyperdrive. Clean these up periodically.
>
> ⚠️ It needs a **real Turnstile token** (prod runs real keys, so the dummy secret is not
> deployed): solve the widget on the real signup page and copy the
> `cf-turnstile-response` value. Tokens are single-use and expire in ~300s.
>
> **To validate the BROWSER path too**, add a `staging.thinkersjournal.com` custom domain
> to `ALLOWED_ORIGINS` (`apps/api/src/auth/csrf.ts`) — a real origin the cookie's
> `Domain=.thinkersjournal.com` also covers, which makes a genuine browser signup
> testable before cutover. Not required for M0.

The `web` Worker has no equivalent script: smoke-hit a rendered page by hand.

### Deploy gate

Check every box before the first production deploy.

**From the risk analysis:**

- [ ] `HYPERDRIVE_FRESH` (cache-disabled) is created and every auth/dup/verify/epoch read uses it — audit the routes.
- [ ] Neon connection string is the **direct** (non-pooled) host with `sslmode=require`, not the PgBouncer endpoint.
- [ ] Postmark `From` is a **confirmed** sender signature / verified domain (silent failure otherwise).
- [ ] Real Turnstile keys set as api secrets; dummy keys never deployed.
- [ ] **`TEST_ROUTES` is unset in prod** and the `__test` route is unreachable (token exposure = account takeover) — **asserted by `pnpm smoke:deploy` steps 1 + 4**, which is the deploy check this line used to only ask for. Run it; do not eyeball it.
- [ ] Pin `wrangler` + `@cloudflare/vitest-pool-workers` versions; re-verify the `ratelimits`/hyperdrive/DO config shapes against the installed version.
- [ ] Run at least one pre-launch pass on **real** infra — local dev has no real Hyperdrive caching or true rate-limit thresholds. **`pnpm smoke:deploy` step 3 IS this pass**: its signup is the smallest request that touches Postgres *and* argon2 *and* KV *and* the DO on live infrastructure. (`/health` + a rendered page touch **none** of them and prove nothing here.)

**Learned during M0 — each of these cost real debugging time:**

- [ ] **`TEST_ROUTES` unset gates TWO things, not one.** Besides the `__test` token route, it
      controls the session cookie's attributes (`apps/api/src/auth/session.ts`): set, the
      cookie drops `Domain` and `Secure` so a browser can store it on `http://127.0.0.1`.
      **Verify against the deployed api that `Set-Cookie` really carries `Secure` and
      `Domain=.thinkersjournal.com`** — if it does not, `TEST_ROUTES` leaked into prod and
      session tokens are riding plaintext http. `apps/api/test/session.test.ts` pins both
      modes, including the exact production string, and **`pnpm smoke:deploy` step 4
      asserts it on the real deploy** (two properties on one silent flag is exactly why
      this is mechanical rather than a checkbox).
- [ ] **Hyperdrive ids are real** (not the `PLACEHOLDER_*` values) and `HYPERDRIVE_FRESH` was
      created with `--caching-disabled`. Confirm on the created config, not from memory.
- [ ] **Postmark alerting.** Sends fail **silently by design** — `sendVerificationEmail`
      never throws, so signup cannot 500 on a mail outage. That means a broken sender is
      invisible unless prod alerts on the log lines `postmark send failed` /
      `postmark rejected send` / `postmark request threw`. Wire those alerts before launch,
      or the first symptom is users who never receive a verification link.
- [ ] **argon2id `.wasm` bundles on a real `wrangler deploy`.** Only the vitest pool and a
      dry run have exercised it; a real deploy is the first true test of the wasm import.
      **`pnpm smoke:deploy` step 3 exercises it** — its signup hashes a password, so a
      `.wasm` that did not survive bundling surfaces there as a 500 rather than on a user.
- [ ] **Confirm the Astro-403 → 503 quirk does not reproduce deployed.** Under `wrangler dev`
      an Astro origin-check 403 poisons the NEXT POST with a spurious 503 (deterministic,
      3/3; GETs unaffected). It looks dev-only — Astro's `createOriginCheckMiddleware`
      returns its 403 without consuming the request body — but verify on a deployed Worker
      before trusting any 4xx-heavy flow.
- [ ] **The api HAS a public URL — know what actually guards it.** `apps/api/wrangler.jsonc`
      sets neither `workers_dev: false` nor `routes`, so Cloudflare defaults `workers_dev`
      to true and the first `wrangler deploy` publishes
      `thinkersjournal-api.<subdomain>.workers.dev`, publicly addressable. That is expected
      at first deploy — and it is what makes `pnpm smoke:deploy` possible at all — so **do
      not assume the api is unreachable from the internet**; the real guards are
      `TEST_ROUTES` unset, the Origin allowlist, CSRF, and the session/epoch checks.
      **Concrete check: `GET /__test/last-verify-token` on the api's public URL must 404 —
      that is `pnpm smoke:deploy` step 1.** Once a custom domain exists, hardening step:
      set `workers_dev: false` + custom `routes` so the only entry is the Service Binding
      from `web`. ⚠️ That hardening **also removes the smoke check's access** — run it (and
      any real-infra validation) *before* closing the public URL, or against a staging
      Worker that keeps one.
- [ ] **The E2E's api-on-:8788 topology is DEV-ONLY.** It exists so the test can read the
      verification token off the api directly; a deployed environment has no reason to run
      the two-process split. Do not carry it forward.

**Learned during M1 — the cross-Worker purge hop (`api` → `web`):**

> Why any of this exists: Workers Cache purge is scoped to the Worker+entrypoint that
> **owns** the cache — *a Worker cannot reach into another Worker's cache.* Edits land in
> `api`; the rendered HTML lives in `web`'s cache. So `api` asks `web` over the `WEB`
> Service Binding (`POST /internal/purge`), and `web` calls `context.cache.invalidate()`
> inside its own entrypoint. **Every failure mode below is silent by design**, because a
> purge failure must never turn a saved edit into a 500 — the post is already committed.
> The blast radius of each is the same: content stale for its full `maxAge+swr` window
> (**25 hours**), with nothing red anywhere.

- [ ] **`PURGE_SECRET` is set on BOTH Workers, byte-identical, with real entropy.**
      `wrangler secret put PURGE_SECRET` on `thinkersjournal-api` **and** on
      `thinkersjournal-web`. `web` compares it in constant time and **fails closed** — on a
      mismatch, on an unset value, and on an empty one (an empty secret must never
      authorize the internet: `timingSafeEqual("", "") === true`, which is why
      `apps/web/src/lib/purge.ts` guards `=== ""` explicitly). Set on one Worker but not
      the other = **every purge 403s forever**, and the only signal is an api log line.
      Do not reuse the dev placeholder.
- [ ] **First deploy is ORDER-DEPENDENT — the Service Bindings are CIRCULAR.** `web → api`
      for everything, `api → web` for purge. `wrangler deploy` resolves the target service
      **by name**, and on a clean account neither exists yet. Order: **deploy `api` with the
      `services` block commented out → deploy `web` → restore the block → redeploy `api`.**
      Every later deploy is order-independent. (The block is
      `"services": [{ "binding": "WEB", "service": "thinkersjournal-web" }]` in
      `apps/api/wrangler.jsonc`; it is pinned by `apps/api/test/purge-binding.node.test.ts`,
      because with it deleted **every api test still passes** while production gets
      `env.WEB === undefined` and purges die silently.)
- [ ] **Alert on the purge log lines.** `purgeTags` **never throws** by contract (the write
      is already committed), so a broken hop is invisible to users and to every test. The
      only signal is `cache purge rejected` / `cache purge threw` in the api's logs. Wire
      those alerts before launch — same reasoning, and the same failure shape, as the
      Postmark alerting item above. ⚠️ Purge is **rate-limited to 5 requests/MINUTE on a
      Free zone** (burst 25, 100 ops/request). We batch every tag into one call per edit,
      but a burst of edits can still exhaust it. Pro raises it to 5/sec.
- [ ] **Verify a real purge on real infra — nothing local can.** Workers Cache is **not**
      simulated by miniflare: locally `cache.purge` is not even a function
      (`TypeError: cache.purge is not a function`), so `POST /internal/purge` 500s under
      `wrangler dev` **by design** and the api absorbs it. That means the *entire* purge
      mechanism is unproven until it runs deployed. Publish a post, edit it, confirm the
      change is live before `maxAge` would have expired.
- [ ] **Hardening (free): block `/internal/*` from the public internet at the edge.**
      `web` is the public Worker, so `https://thinkersjournal.com/internal/purge` is a real,
      routable URL and the shared secret is its **only** guard — there is no way to prove a
      request arrived over a Service Binding. A WAF custom rule blocking `/internal/*` costs
      nothing and **will not break the hop**: Service-Binding dispatch is isolate-to-isolate
      and never traverses the edge. The secret remains the guard; this removes the public
      attack surface entirely. Worst case if the secret leaks is a forced-re-render cost/DoS
      lever, not a data leak (the route reads nothing and writes nothing) — rotate it.

**Learned during M1 — each of these is a hazard no test can reach:**

- [ ] **Neon is on Postgres 18.** `SELECT version();` on the deployed api's database.
      ⚠️ **Neon has NO in-place major upgrade** — a wrong major here means creating a
      NEW project and migrating data, forever after. PG18 is Neon's default for new
      projects; take the default. `migrations/0002_posts_and_media.sql` uses the **native**
      `uuidv7()`, which does not exist before 18, so a PG16 project fails at migrate time
      (loud) — but a PG17 project would fail the same way after data existed (expensive).
- [ ] **Neon's connection string is the DIRECT (non-pooled) host with `sslmode=require`.**
      NOT the PgBouncer/pooler endpoint — feeding Hyperdrive Neon's own pooler double-pools.
      (Carried from M0; still binding.)
- [ ] **The Cache Rule on `cdn.thinkersjournal.com` is NOT optional and is NOT
      performance.** Cache Everything + a long Edge TTL. ⚠️ **"Cached" is EXACTLY the
      set the CSAM Scanning Tool covers — media that bypasses cache is media that
      ISN'T SCANNED.** Verify with `curl -I https://cdn.thinkersjournal.com/media/post/<hash>.webp`
      → `cf-cache-status: HIT` on the second request. A MISS here is a legal exposure,
      not a slow image. (The R2 key scheme is `media/post/<hash>.webp` — `apps/api/src/routes/media.ts`.)
- [ ] **A Transform Rule adds `X-Content-Type-Options: nosniff` on the
      `cdn.thinkersjournal.com` R2 custom domain itself.** Media is served DIRECTLY from R2
      through that custom domain, deliberately NOT through a Worker (Task 8) — so neither
      `setPublicPageCsp`'s `nosniff` (which only runs on `web`'s own SSR page responses,
      `apps/web/src/lib/csp.ts`) nor anything set on `api`'s `POST /media` 201 JSON response
      ever touches these bytes. Without a Transform Rule on the zone, a served image has no
      nosniff protection at all. Verify:
      `curl -I https://cdn.thinkersjournal.com/media/post/<hash>.webp | rg -i 'x-content-type-options'`
      → `nosniff`.
- [ ] **CSAM Scanning Tool activated** on the CDN zone (Caching → Configuration → CSAM
      Scanning Tool). **Free, all plans. NCMEC credentials are NO LONGER REQUIRED** —
      activate, verify the notification email, accept the Service-Specific Terms. ⚠️ The
      tool **detects; it does not report** — we still file our own reports. The zone
      already exists because the R2 custom domain requires one, so this adds no burden.
- [ ] **`workers_dev = false` on BOTH Workers** + custom `routes`. ⚠️ `*.workers.dev`
      **SHARES CACHE ENTRIES** with the custom domain at the same Worker version, so
      leaving it on means a `workers.dev` request can fill an entry served under the
      real domain. This also closes M0's "the api has a public workers.dev URL" finding
      — the api's only entry becomes the Service Binding from `web`. (Neither
      `apps/api/wrangler.jsonc` nor `apps/web/wrangler.jsonc` sets `workers_dev` today, so
      Cloudflare defaults it to `true` — this is an active change, not a confirmation.)
      ⚠️ **It also removes `pnpm smoke:deploy`'s access.** Run every real-infra
      validation BEFORE closing the public URL, or against a staging Worker that keeps one.
- [ ] **www → apex redirect is live.** ⚠️ **HOST IS NOT IN THE CACHE KEY** — apex and
      `www` share entries, so without the redirect a `www` render is served at the apex
      and vice versa. (Canonical/OG URLs are already built from a constant origin for
      this exact reason — `CANONICAL_ORIGIN` in `apps/web/src/lib/canonical.ts`.)
- [ ] **Assert a real cache `MISS` then `HIT` via `Cf-Cache-Status`, on a public
      page, BEFORE trusting anything else about caching.** This is the ONLY
      client-visible proof Workers Cache is active at all — the header the Astro
      provider actually writes (`Cloudflare-CDN-Cache-Control`) and the `Cache-Tag` purge
      handle are both invisible client-side on a real deploy (Cloudflare strips `Cache-Tag`
      before the client ever sees it, and plain `Cache-Control` — the name every local/unit
      check in this plan used to read — is never set at all).
      `curl -is https://thinkersjournal.com/@<user>/<slug>` twice in a row → first request
      `cf-cache-status: MISS`, second `cf-cache-status: HIT`. If this never flips to `HIT`,
      nothing downstream (purge, TTLs, tags) can be trusted either, no matter how green the
      local suites are. (This is distinct from the purge-hop's "verify a real purge": that
      one confirms invalidation; this one confirms the cache exists in the first place.)
- [ ] **A gradual deployment leaves the OLD Worker version serving ITS OWN cached HTML to
      its traffic share until rollout completes.** The Worker version is part of the Workers
      Cache key (Task 12) by design, so during a gradual rollout the previous version's cache
      entries are not invalidated by the new version's deploy — each version's traffic share
      sees only that version's cache, and a purge issued against the new version does not reach
      the old version's entries. Expect a window where some readers still see pre-edit content
      even after a successful purge, until the old version's traffic share reaches zero. This
      is expected, not a purge-hop failure — do not "fix" it mid-rollout.
- [ ] **The Astro cache provider is the ONLY off switch — `cache.enabled:false` does NOT
      disable it.** The `@astrojs/cloudflare` adapter's config customizer injects
      `{ enabled: true }` regardless, and inverts a `false` back to `true` (verified against
      `@astrojs/cloudflare/dist/wrangler.js`; the reasoning is in `apps/web/wrangler.jsonc`).
      So Cloudflare's documented `env.production` staging-uncached pattern SILENTLY DOES NOT
      WORK here — the only way to turn the cache off is removing
      `cache: { provider: cacheCloudflare() }` from `astro.config.mjs`. Re-run Task 12 Step
      1's four checks on any bump of `astro`, `@astrojs/cloudflare`, or `wrangler` (Workers
      Cache shipped 2026-07-06 and the Astro CDN cache-provider API is flagged experimental);
      the verified shape is recorded in `apps/web/astro.config.mjs`'s notes block.
- [ ] **`HYPERDRIVE_CACHED` is used by EXACTLY ONE route — `GET /public/recent`.** `rg -n
      'HYPERDRIVE_CACHED' apps/api/src` → exactly one call site, in `src/routes/public.ts`
      (`handlePublicRecent`); pinned by `apps/api/test/hyperdrive-binding-inventory.node.test.ts`.
      ⚠️ Every other public read uses **FRESH**, because their edge entries are
      purge-invalidated: the first render after a purge is a read-after-write, and Hyperdrive
      **never invalidates on write**, so a CACHED read there could serve a pre-edit row that
      the edge then re-caches for **25 hours**. Behind a 3600s edge TTL a 60s query cache hits
      ~never anyway.
- [ ] **Upload a REAL SVG against the REAL Images binding on a deployed Worker.** Miniflare
      backs `IMAGES` with `sharp`, which RASTERIZES SVG input — so a local `IMAGES` call
      against an SVG either fails cleanly or comes back as a raster format, either of which
      can read as "the binding neutralizes SVG safely." Production Cloudflare Images does the
      opposite: it PASSES SVG THROUGH (sanitized via svg-hush), still shaped as SVG. Local
      green here proves nothing about production. Task 7's magic-byte sniff
      (`apps/api/src/media/sniff.ts`) is the ACTUAL SVG defense — it rejects SVG with a 415
      before the Images binding ever sees it — and this check exists to catch a regression in
      that sniff, which local tests alone cannot.
- [ ] **"What local green does NOT prove" — a standing warning, not a one-time check.**
      ⚠️ **LOCAL HYPERDRIVE IS NOT A POOLER**: local dev connects STRAIGHT to Postgres, with
      none of a real pooler's connection reuse or transaction-mode semantics in front of it.
      Anything whose correctness depends on real pooling behaviour is UNPROVEN by a local
      green run — this nearly shipped a no-op safety setting in Task 11. Pair it with the
      `sharp`/SVG item above: miniflare's Images/R2/Hyperdrive simulation is close enough for
      LOGIC, never close enough for a SECURITY or POOLING guarantee — anything in that
      category earns its own real-infra deploy-gate line, not a "tests are green" sign-off.
- [ ] **`/public/*` and `/@*` public reads have NO rate limiting — add a WAF rate-limit
      rule before launch.** The `ratelimits` bindings in `apps/api/wrangler.jsonc` cover only
      `signup`/`login`/`media`/`resend-verification`; NOTHING guards `/public/posts`,
      `/public/profile`, `/public/recent`, or the `web` `/@user[/slug]` pages. `?cursor=` on
      `/public/profile` accepts any valid-format UUID, so an attacker can mint unbounded
      distinct cacheable edge entries, each a real DB MISS behind the cache. And
      `/public/recent` returns up to **1000 rows** unpaginated (`RECENT_MAX`,
      `apps/api/src/routes/public.ts`). Add a Cloudflare **WAF rate-limit rule** on the public
      read paths as the deploy-time mitigation. (App-level rate limiting on `/public/*` is
      **deferred to M2** — see the plan's Deferred record; the WAF rule is what protects
      launch.)
- [ ] **The Images bill is a TRANSFORM bill, not a traffic bill.** 5,000 free unique
      transforms/month, then $0.50/1k, billed once per unique (source+params) per calendar
      month. We transform on **write** and serve from R2 (egress $0), so this scales with
      uploads, not views. Check it after the first month of real uploads.
- [ ] **The R2 dedupe/deletion hazard is understood before ANY delete ships.** Two users
      uploading the same image share **ONE R2 object with TWO `media` rows** — the key is the
      content hash (`media/post/<hash>.webp`). Deleting one row must **NOT** delete the object.
      M1 never deletes an object inline; reclamation is an offline GC (M4, with moderation
      deletion). Do not add an inline delete without refcounting first.

**✅ CI IS WIRED — but the deploy-time guards STILL can't run in CI (owner step remains):**

- [x] **CI now exists at `.github/workflows/ci.yml`** and runs on every push to `main` and on
      every PR: the full green sweep — `pnpm run typecheck`, the whole `pnpm -r test` suite
      against a real **Postgres 18** (brought up with `docker compose up -d --wait db`, which
      creates all three databases), **with `apps/web` built FIRST** so the build-gated
      manifest/route guards actually **FIRE** instead of silently skipping — most importantly
      the `/internal/purge` survival proof (`apps/web/test/purge.test.ts`), the only real check
      that a silent 404 there won't make every cache purge fail forever. A dedicated step then
      asserts `apps/web/dist/server/entry.mjs` exists so a silent build failure can't leave the
      gate unsatisfied. CI also runs `pnpm --filter @thinkersjournal/markdown run check:workerd`
      (the WASM/`node:`-import gate) and the Playwright **E2E** across BOTH Workers.
- [ ] **The remaining owner step is a staging `smoke:deploy`.** CI does **NOT** and **CANNOT**
      cover `pnpm smoke:deploy` (`scripts/deploy-smoke.mjs`): it needs a **REAL** deployed/staging
      Worker plus real Cloudflare secrets, neither of which exists in CI. So it stays a human/owner
      step before promoting a deploy (or a future deploy-pipeline step once a staging Worker + CI
      secrets exist). The deploy gate's real-infra assertions are **deploy-time, not CI-time**:
      argon2 `.wasm` bundling on a real `wrangler deploy`, `TEST_ROUTES` unset in prod, the session
      cookie's `Domain`/`Secure`, and the circular-binding first-deploy order. M0's own final review
      called an automated deploy assertion "the single highest-leverage item"; that item is now
      **partly** paid down (the full green sweep is automated), but the deploy-time proof still
      requires the owner's Cloudflare account. Do not leave it implicit — an unlisted human step is
      how a broken deploy ships green.

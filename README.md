# Thinker's Journal — Community Platform

The flagship of [Thinker's Journal](https://thinkersjournal.com): a public **social publishing platform for thinkers** with **live, precise @-references** into their work (the exact file + lines, CI check, PR, or issue on GitHub/GitLab, plus web/YouTube/X).

> **▶ New session / new agent?** Start with **[`HANDOFF.md`](HANDOFF.md)** — the self-contained entry point (this repo's Claude memory is separate from the marketing-site project).

> **Status:** **M0 (foundations) is built** and not yet deployed; **M1** is next. This repository is **private** and stays quiet until the launch scope (M0–M4) is complete.

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
docker compose up -d                 # Postgres 18: `thinkersjournal` (dev) + `thinkersjournal_test`
pnpm install
```

> Upgrading from an M0 checkout? `docker compose down -v` first — **the `-v` is
> required**. PG18 cannot read PG16's data directory and there is no in-place
> major upgrade (the same property that makes the Neon major choice permanent).
> The `-v` wipes BOTH databases — the test one recreates its schema
> automatically (vitest's `globalSetup` migrates `thinkersjournal_test` before
> every run), but the **dev** DB does not: run
> `pnpm --filter @thinkersjournal/api migrate` once afterward, or `wrangler
> dev`/`pnpm test:e2e` will hit a real Postgres with no `users`/`profiles`
> tables.

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
```

Neither the test suite nor the E2E depends on this file: `apps/api/vitest.config.ts`
supplies the same values via `miniflare.bindings`, and `playwright.config.ts` passes
them as `--var` flags, so both are CI-safe on a fresh checkout. `.dev.vars` is only for
running `wrangler dev` by hand.

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
pnpm typecheck                               # all packages
pnpm test:e2e                                # Playwright: real browser, both Workers
```

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
| Secrets | `TURNSTILE_SECRET_KEY`, `POSTMARK_SERVER_TOKEN` |
| Vars | **`TEST_ROUTES` MUST BE UNSET** (see the gate below) |

Before the first deploy, replace the placeholder ids in `apps/api/wrangler.jsonc`:

```bash
wrangler kv namespace create SESSIONS
wrangler hyperdrive create tj-cached --connection-string="postgres://…"
wrangler hyperdrive create tj-fresh  --connection-string="postgres://…" --caching-disabled
```

`HYPERDRIVE_FRESH` **must** be the `--caching-disabled` config: Hyperdrive never
invalidates on write, so a cached auth/dup-email/verify read is a real security bug.

### Project 2 — `thinkersjournal-web`

| Setting | Value |
| --- | --- |
| Root directory | `apps/web` |
| Build command | `pnpm install && pnpm --filter @thinkersjournal/web astro build` |
| Deploy command | `npx wrangler deploy` |
| Watch paths | `apps/web/**`, `packages/shared/**` |

The `API` Service Binding resolves by Worker **name** (`thinkersjournal-api`), so the api
must be deployed first. First deploy targets `*.workers.dev` — including the api's own
`thinkersjournal-api.<subdomain>.workers.dev`, which is public by default (see the deploy
gate).

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

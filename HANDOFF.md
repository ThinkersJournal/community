# HANDOFF — start here (new session / new agent)

This repo is **self-contained**: everything needed to continue is committed here. (Claude Code memory is scoped per project directory, so a session opened in this repo starts with its **own empty memory** and will NOT auto-load context from the sibling `ThinkersJournal.com` marketing-site project. This file + the committed docs are the source of truth. Build up this project's memory as you go.)

## What this is

**Thinker's Journal — Community platform** (project ② of 2). A public social publishing platform for thinkers **+ live @-references** into their work. The **marketing website** (project ①) is a *separate*, already-live repo: `ThinkersJournal/ThinkersJournal.com` — don't confuse them.

**Status:** design complete + approved; **M0 + M1 are BUILT** (M1 on branch `m1-publishing`, not yet deployed) — see *M1 status* below. Next milestone: **M2** (social graph). Private repo; kept quiet until launch scope (M0–M4) is done.

## Documentation map — everything lives in THIS repo

All Thinker's Journal **Community** documentation lives here (not in the sibling marketing-site project). The design is written **once for the whole platform**; implementation plans are added **one per milestone** as we build.

- `docs/superpowers/specs/2026-07-13-community-platform-design.md` — **the whole-platform design (M0 → M4 + post-launch):** product, all decisions, architecture, cost model, cost-recovery/legal, and the full build sequence. The reference for planning *every* milestone.
- `docs/superpowers/specs/2026-07-13-community-platform-architecture-research.md` — the deep research + adversarial review behind the design.
- `docs/superpowers/plans/` — **one implementation plan per milestone.** `2026-07-13-m0-foundations.md` and `2026-07-15-m1-publishing-and-public-web.md` exist now (both BUILT); **M2–M4 plans get written here** (via `superpowers:writing-plans` against the design spec) as each milestone is reached, then built. The M1 plan carries the **Deferred / out-of-scope** record — what M1 consciously punted to M2/M3/M4 (chosen usernames, `/public/*` app-level rate limiting, `email_verified_at`-into-the-DO, `style-src 'unsafe-inline'` removal, the R2 dedupe/GC deletion story, the atomic-upsert residual).
- `HANDOFF.md` (this file) — session entry point + carry-over context.

**Pattern for every milestone after M0:** open a session in this repo → read the design spec → run `superpowers:writing-plans` for that milestone → the new plan lands in `docs/superpowers/plans/` → build it (subagent-driven). Nothing depends on the other project; this repo also grows its own Claude memory as you work.

## M1 status — BUILT (branch `m1-publishing`, not deployed)

All 20 tasks of `docs/superpowers/plans/2026-07-15-m1-publishing-and-public-web.md` are
built and review-clean (M0's 19 tasks preceded them on `m0-foundations`). **Green baseline**
— match this before and after any change (verified by a full run on 2026-07-16):

| Suite | Command | Expected |
| --- | --- | --- |
| api | `pnpm --filter @thinkersjournal/api test` | **396 tests / 31 files** |
| web | `pnpm --filter @thinkersjournal/web test` | **276** (+2 skipped) |
| shared | `pnpm --filter @thinkersjournal/shared test` | **17** |
| markdown | `pnpm --filter @thinkersjournal/markdown test` | **93** |
| markdown | `pnpm --filter @thinkersjournal/markdown run check:workerd` | exit 0 (no `node:`/WASM) |
| E2E | `pnpm exec playwright test` | **8 passed** (real browser, publish→render→edit→purge + soft gate) |
| types | `pnpm typecheck` | exit 0 |

> The 2 web skips are the build-gated manifest/route assertions (`it.skipIf(!existsSync(dist/server/entry.mjs))`)
> — they only run after a `pnpm --filter @thinkersjournal/web build`. **This is the NO-CI
> hazard called out in the README deploy gate**: on a fresh clone with no build, the only
> real proof that `/internal/purge` survived the build silently skips.

**The local loop needs three things** (all documented in `README.md` — read it for the dev loop *and* the deploy gate):

1. **Docker** — `docker compose up -d` (Postgres 18: `thinkersjournal` + `thinkersjournal_test`). Upgrading from an M0 checkout? `docker compose down -v` first — PG18 cannot read a PG16 data directory and there is no in-place major upgrade.
2. **`apps/api/.dev.vars`** — **gitignored, so a fresh clone will not have it**; create it with `TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"` (Cloudflare's published always-pass dummy), `POSTMARK_SERVER_TOKEN=<any dummy>`, `TEST_ROUTES="1"`, and **`PURGE_SECRET=dev-purge-secret-not-for-production`** (M1). Also create **`apps/web/.dev.vars`** with the **byte-identical** `PURGE_SECRET`. Only `wrangler dev` by hand needs these — the test suites and the E2E supply the same values themselves. See `README.md` for the full `.dev.vars` notes (the web copy is read at BUILD time).
3. **Hyperdrive local overrides** — `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH` and `…_HYPERDRIVE_CACHED`, both pointed at the Docker Postgres.

**The as-built code deviates from the plan in several places** — each plan's **"As-built deviations"** section (M0 and M1) is the reconciliation; read it before trusting any per-task step text.

**Still outstanding (do not lose these):**

- **Signup dup-check→INSERT race** — **RESOLVED in M1 Task 11** (atomic guarded upsert; signup is now one `withClient`/one statement, concurrent same-email signups no longer 500). A bounded residual remains (an unverified session can survive an epoch bump that crashed after commit) — recorded in the plan's Deferred record.
- **Resend-verification path** — **SHIPPED in M1** (`POST /auth/resend-verification`, session-scoped, `RESEND_LIMITER` at 3/min).
- **Prod alerting on silent mail failure** — `sendVerificationEmail` never throws (so a mail outage can't 500 signup), which means a broken sender is invisible. Alert on the log lines `postmark send failed` / `postmark rejected send` / `postmark request threw` before launch. **Now a README deploy-gate item.**
- **Real-infra deploy validation** — Hyperdrive runtime connectivity and the argon2id `.wasm` bundling have only ever run locally; a real `wrangler deploy` is their first true test. **`pnpm smoke:deploy` is the runnable form; now a README deploy-gate item.**
- **M1's full deploy gate is NOT satisfied** — the first M1 deploy needs R2/CDN/CSAM/PG18/purge provisioning and the ~20-item M1 gate in `README.md`. **NO CI exists** (no `.github/`), so `smoke:deploy` + `check:workerd` + the build-gated tests are human-run — an explicit owner decision recorded in the gate.

## ▶ The next action (M2)

1. Read the design spec: `docs/superpowers/specs/2026-07-13-community-platform-design.md` — authoritative design (decisions, architecture, cost model, build sequence). Deep rationale in `…-architecture-research.md`.
2. Write the M2 plan with **`superpowers:writing-plans`** against that spec; it lands in `docs/superpowers/plans/`. Then build it with **`superpowers:subagent-driven-development`** (fresh subagent per task + review gates), on a feature branch. **Start with the plan's Deferred record** (M1 plan) — M2's first item is user-chosen usernames (a rename must purge `author:<id>` + every `post:<id>`, which is why it waited for the purge hop to ship).
3. **Load-bearing rules M2 inherits** live in the M0 plan's *Global Constraints* + the M1 plan's amended *Global Constraint* (kept current — corrected to as-built): the **HYPERDRIVE_FRESH-vs-CACHED** binding rule (all auth/dup/verify/permission reads use FRESH; `HYPERDRIVE_CACHED` is used by exactly one route today), Durable Objects need **`new_sqlite_classes`**, the tooling-shape pins (vitest-pool-workers `cloudflareTest()`, top-level **`ratelimits`** — plural), TypeScript pinned to **6.0.3** (do not "upgrade" to 7.x), the `__test` route MUST be off in prod, and the cross-Worker purge hop's silent failure modes.

## Carry-over context (this lived only in the other project's memory)

- **Founder:** ciresnave (ciresnave@gmail.com); 44-year programmer; non-profit "in formation," solo, unfunded, will take zero personal comp. GitHub org: `ThinkersJournal`.
- **Tooling preferences:** no WordPress, no Figma. Prefer **Playwright CLI + the playwright-cli skill** (token-efficient) over the MCP for scripted work; MCP fine for live exploration. MCP servers configured at user scope: playwright, chrome-devtools, github (via a **PAT header** — OAuth fails), cloudflare-bindings, cloudflare-docs, serena (dashboard disabled). Context7 for live docs.
- **Stack (decided):** TypeScript on Cloudflare Workers (NOT Rust — workers-rs was non-viable) + Postgres/Neon via Hyperdrive + R2 + KV + Durable Objects; Astro `web` + TS `api`, two Workers joined by a Service Binding; Argon2id via the openpgpjs **`argon2id`** package (**NOT `hash-wasm`** — it is non-viable on Workers; see the M0 plan's *As-built deviations*); `auth-framework` (the founder's Rust crate) is a *design reference only*, not a dependency.
- **Grounded cost model:** optimized ~$90–135/mo at 100k users, **~$850–960/mo at 1M** (~$10–12k/yr, no runaway line) vs a naive $5.4k–16.3k — the caching/offload design (spec §3, decisions #22–23) closes the Postgres cost gap.
- **Cost recovery / legal (spec §6):** fund via a broad supporter/donation/sponsor/grant portfolio (public-charity status depends on broad public support). Any commerce (marketplace, publishing, print-on-demand, funding-referral) must live in a **wholly-owned taxable subsidiary**, never inside the 501(c)(3) — the risk is the *private-benefit doctrine*, and a low fee gives no protection. **⏰ Standing real-world to-do (independent of code): a nonprofit attorney + CPA to lock in public-charity status and the parent/subsidiary structure before filing Form 1023.**

## Where the deep research lives

Five research passes (architecture, cost, marketplace legality, nonprofit structure, M0 specifics) are summarized in the spec (§3, §6) + the architecture-research doc; the raw synthesis is captured there. You do not need to re-run them.

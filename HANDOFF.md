# HANDOFF — start here (new session / new agent)

This repo is **self-contained**: everything needed to continue is committed here. (Claude Code memory is scoped per project directory, so a session opened in this repo starts with its **own empty memory** and will NOT auto-load context from the sibling `ThinkersJournal.com` marketing-site project. This file + the committed docs are the source of truth. Build up this project's memory as you go.)

> **Freshness note (2026-08-15):** this file is the onboarding entry point, so keep it current — a stale HANDOFF misleads the next reader. Update the *Current status*, *Deploy state*, and *Next action* sections whenever a milestone ships or the deploy moves.

## What this is

**Thinker's Journal — Community platform** (project ② of 2). A public social publishing platform for thinkers **+ live @-references** into their work. The **marketing website** (project ①) is a *separate*, already-live repo: `ThinkersJournal/ThinkersJournal.com` — don't confuse them. The two are **two repos / one program** (the non-profit's public face); their cross-links flip on when `community.thinkersjournal.com` resolves live (see *Deploy state*).

## Current status (2026-08-15) — feature-complete for launch; only operational go-live remains

**M0, M1, and all of M2 are BUILT, reviewed, and MERGED to `main`** — plus every named pre-launch fix. `main` is the trunk and carries everything below; there is no long-lived feature branch waiting to land.

Shipped and merged (PR numbers are this repo's):
- **M0 foundations** + **M1 publishing & public web** — the platform base, auth, publishing, the public web, the cross-Worker purge hop.
- **M2 social platform** (PRs #1–#15): social graph + feed, engagement (comments/reactions), notification core, realtime bell + per-post live, email notifications (per-category prefs + daily digest), search, discover feed, tags, and the KV followee-cache. Web-theming (design-system adoption) shipped alongside (PR #4).
- **Pre-launch fixes** surfaced during live workers.dev testing: **handle-at-signup** (PR #19 — permanent `@handle` chosen at signup + 7-day unverified-account reaper), **notification bell** CSS/a11y fix (PR #18), and **content-deletion + media-reclamation** (PR #20 — owner `DELETE /posts/:id` + a daily orphan-media reclaimer cron).

**What remains before public launch is all operational go-live, none of it code** — see *Deploy state* below.

## Documentation map — everything lives in THIS repo

All Thinker's Journal **Community** documentation lives here (not in the sibling marketing-site project). The whole-platform design was written **once**; implementation plans were then added **one per milestone** as each was built.

- `docs/superpowers/specs/2026-07-13-community-platform-design.md` — **the whole-platform design (M0 → M4 + post-launch):** product, all decisions, architecture, cost model, cost-recovery/legal, and the full build sequence. Still the reference for planning any *remaining* milestone (M3+).
- `docs/superpowers/specs/2026-07-13-community-platform-architecture-research.md` — the deep research + adversarial review behind the design.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — **one spec + one plan per shipped milestone.** M0, M1, all M2 sub-milestones (2.1 social graph → KV followee-cache), web-theming, plus the two pre-launch milestones (`2026-08-13-handle-at-signup-*`, `2026-08-13-content-deletion-media-reclamation-*`). All BUILT. Future milestones (M3+) get their spec+plan written here the same way (`superpowers:brainstorming` → `superpowers:writing-plans`), then built subagent-driven.
- `docs/pre-launch-fixes.md` — the punch list found during live workers.dev testing (2026-08-13) and its resolution; `docs/backlog/media-garbage-collector.md` + `docs/backlog/unverified-account-reaper.md` seeded the two pre-launch milestones; `docs/superpowers/backlog/2026-07-21-live-chat-concept.md` is a parked post-M4 idea.
- `docs/superpowers/spikes/2026-07-25-ws-topology-spike.md` — the WebSocket topology spike behind the realtime bell.
- `HANDOFF.md` (this file) — session entry point + carry-over context.

## Green baseline + CI

**CI EXISTS and gates every push to `main` and every PR** — `.github/workflows/ci.yml`, two jobs:
- **`test`** — typecheck → **build web first** (so build-gated tests fire) → assert `apps/web/dist/server/entry.mjs` exists (fail loud, no false-green) → `pnpm -r run test` (all packages) → the markdown `check:workerd` WASM/`node:` gate.
- **`e2e`** — migrate the dev DB → install the Playwright chromium + OS deps → `pnpm run test:e2e` (real browser against **both** Workers on 8787/8788).

This retires two hazards the old handoff carried: there is no longer a "no-CI, human-run gate," and the build-gated web tests (most importantly `apps/web/test/purge.test.ts`'s built-manifest proof that `/internal/purge` survived the Astro build) **no longer silently skip in CI** — CI builds first and asserts the server entry.

**Match CI-green before and after any change.** As of the last milestone the suites were roughly **api ~787 / web ~667 (+~5 skipped) / shared / markdown ~93 + `check:workerd`**, e2e green, `pnpm typecheck` clean — but treat **CI as the authority**, not a hardcoded count (hardcoded counts are what rotted the old baseline). Locally, the ~5 web skips are the build-gated guards: they only fire after `pnpm --filter @thinkersjournal/web build`, exactly as CI does.

**The local dev loop needs three things** (all in `README.md` — read it for the dev loop *and* the deploy gate):

1. **Docker** — `docker compose up -d` (Postgres 18: `thinkersjournal` + `thinkersjournal_test`). Upgrading from an old PG16 checkout? `docker compose down -v` first — PG18 cannot read a PG16 data directory and there is no in-place major upgrade.
2. **`apps/api/.dev.vars`** — **gitignored, so a fresh clone will not have it**; create it with `TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"` (Cloudflare's published always-pass dummy), `POSTMARK_SERVER_TOKEN=<any dummy>`, `TEST_ROUTES="1"`, and **`PURGE_SECRET=dev-purge-secret-not-for-production`**. Also create **`apps/web/.dev.vars`** with the **byte-identical** `PURGE_SECRET`. Only `wrangler dev` by hand needs these — the test suites and the E2E supply the same values themselves. See `README.md` (the web copy is read at BUILD time).
3. **Hyperdrive local overrides** — `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH` and `…_HYPERDRIVE_CACHED`, both pointed at the Docker Postgres.

**Each plan's "As-built deviations" section** (M0/M1 especially) reconciles code vs plan text — read it before trusting any per-task step.

## Deploy state — first prod deploy DONE (2026-08-08); go-live remainder outstanding

**Both Workers are deployed** (first prod deploy 2026-08-08; a later redeploy ~2026-08-12 added the `PREVIEW_ORIGIN` affordance). Provisioned: Neon Postgres 18 with **migrations 0001–0010 applied**, **KV×2** (SESSIONS, FOLLOWEES), **Hyperdrive×2** (CACHED 60s / FRESH cache-disabled), **R2** (`tj-media`), Durable Objects, and the deploy secrets. Hyperdrive runtime connectivity and the argon2id `.wasm` bundling are **proven on real infra** (live signup/auth work on workers.dev) — the old "only ever ran locally" risk is retired. The api Worker is intentionally **binding-only** (`workers_dev:false`, not publicly reachable — verified 404 at its subdomain); the **web** Worker carries the public origin: `https://thinkersjournal-web.ciresnave.workers.dev`.

⚠️ **The deployed snapshot predates the three pre-launch fixes.** As of 2026-08-15 the running Workers serve code from ~PR #16/#17 — **handle-at-signup (#19), the bell fix (#18), and content-deletion (#20) are merged to `main` but NOT deployed** (confirmed: the live `/signup` page still shows the old onboarding form, no Handle field). So "merged" ≠ "live" here, and **migration 0011 is not yet applied** (schema is 0001–0010; 0011 drops `username_chosen`, which the *deployed* code still reads — so the redeploy must be **code first, THEN migration 0011**).

**Remaining before public launch — all operational, none code, all need CireSnave's accounts/DNS:**

1. **Redeploy `main`** so the merged fixes go live. ⚠️ **"Merged" ≠ "live"**: the running Workers still serve pre-milestone code until a redeploy. **Deploy order is load-bearing: code first, THEN migration 0011** — 0011 drops `username_chosen`, a column the *old* code still reads, so migrating before the code deploy would break the running Worker.
2. **Real Postmark** — swap the placeholder `POSTMARK_SERVER_TOKEN`, verify the sender domain (DKIM DNS), create the digest Broadcast stream. **`sendVerificationEmail` never throws** (a mail outage can't 500 signup) — so a broken sender is *invisible* without alerting on the log lines `postmark send failed` / `postmark rejected send` / `postmark request threw`. Alerting is a pre-launch requirement.
3. **Real Turnstile** — create the widget, wire the client script + CSP, set the real `TURNSTILE_SECRET_KEY`, redeploy web.
4. **DNS / custom-domain cutover** — `community.thinkersjournal.com` → the Workers and **`cdn.thinkersjournal.com` → R2**. ⚠️ **CDN trap:** post-image URLs hardcode `cdn.thinkersjournal.com`, so images stay broken until that R2 custom domain is attached. At cutover, drop the temporary `PREVIEW_ORIGIN --var` on the live api. This cutover is also the **sole trigger** for the ThinkersJournal.com cross-link flip (their side: `APP.live` false→true in `src/consts.ts` + a ~2-min redeploy — coordinate with that repo's peer/agent).
5. **~~Rotate the Neon prod DB password~~ — ✅ DONE 2026-08-15.** It had been pasted into a chat transcript in a prior session (exposed); rotated in Neon + both Hyperdrive configs updated, verified green from the outside (a cache-disabled FRESH signup 201 + a forced-cache-miss CACHED read 200 — both configs reconnected, partial rotation ruled out). The exposed credential is dead.

**Test seams are prod-safe:** the `__test/*` routes (incl. the unverified-account reaper and orphan-media reclaimer hooks) are `TEST_ROUTES`-gated + origin-checked and unreachable in prod.

## Load-bearing rules (all current work inherits these)

Live in the M0 plan's *Global Constraints* + the M1 plan's amended *Global Constraint* (kept current, corrected to as-built):
- **HYPERDRIVE_FRESH-vs-CACHED binding rule** — all auth / session / permission / dup-email / verify / read-after-write reads use **`HYPERDRIVE_FRESH`** (cache-disabled; Hyperdrive never invalidates on write, so a cached auth/verify read is a real security bug). **`HYPERDRIVE_CACHED`** (60s) is ONLY for public feeds/listings.
- Durable Objects need **`new_sqlite_classes`** (KV-backed `new_classes` is blocked for new namespaces).
- Tooling-shape pins: vitest-pool-workers `cloudflareTest()`; the top-level wrangler key is **`ratelimits`** (plural); TypeScript pinned to **6.0.3** (do NOT "upgrade" to 7.x).
- The `__test` route MUST be off in prod (`TEST_ROUTES` gate).
- The cross-Worker **purge hop** is circular (web→api for everything, api→web for cache purge) with silent-failure modes — a purge must never error a mutation response.

## ▶ The next action

The launch scope (M0–M4) is **not yet code-complete** — M3/M4 remain per the design spec — but the **immediate** path is *launch*, not new features. Before starting anything, read the current state: this file, `docs/pre-launch-fixes.md`, and the two most recent milestone specs/plans (`2026-08-13-*`).

- **To take the platform live:** work the *Deploy state* go-live checklist above. It is founder-gated (his accounts/DNS) and sequenced (code-deploy → migration 0011; DNS attaches the CDN). The transcript-exposed Neon password was already rotated + verified (2026-08-15). A portfolio PM peer (`C:\Projects`) is coordinating the launch as one program with ThinkersJournal.com.
- **To build the next milestone (M3+):** `superpowers:brainstorming` against the design spec → `superpowers:writing-plans` → build subagent-driven (fresh subagent per task + review gates) on a feature branch, shipped via a CI-gated PR that the founder merges.

## Carry-over context

- **Founder:** ciresnave (ciresnave@gmail.com); 44-year programmer; non-profit "in formation," solo, unfunded, will take zero personal comp. GitHub org: `ThinkersJournal`. Works on Windows/PowerShell.
- **Tooling preferences:** no WordPress, no Figma. Prefer **Playwright CLI + the playwright-cli skill** (token-efficient) over the MCP for scripted work; MCP fine for live exploration. MCP servers configured at user scope: playwright, chrome-devtools, github (via a **PAT header** — OAuth fails), cloudflare-bindings, cloudflare-docs, serena (dashboard disabled). Context7 for live docs.
- **Stack (decided):** TypeScript on Cloudflare Workers (NOT Rust — workers-rs was non-viable) + Postgres/Neon via Hyperdrive + R2 + KV + Durable Objects; Astro `web` + TS `api`, two Workers joined by a Service Binding; Argon2id via the openpgpjs **`argon2id`** package (**NOT `hash-wasm`** — non-viable on Workers; see the M0 plan's *As-built deviations*); `auth-framework` (the founder's Rust crate) is a *design reference only*, not a dependency.
- **Grounded cost model:** optimized ~$90–135/mo at 100k users, **~$850–960/mo at 1M** (~$10–12k/yr, no runaway line) vs a naive $5.4k–16.3k — the caching/offload design (spec §3, decisions #22–23) closes the Postgres cost gap.
- **Cost recovery / legal (spec §6):** fund via a broad supporter/donation/sponsor/grant portfolio (public-charity status depends on broad public support). Any commerce (marketplace, publishing, print-on-demand, funding-referral) must live in a **wholly-owned taxable subsidiary**, never inside the 501(c)(3) — the risk is the *private-benefit doctrine*, and a low fee gives no protection. **⏰ Standing real-world to-do (independent of code): a nonprofit attorney + CPA to lock in public-charity status and the parent/subsidiary structure before filing Form 1023.**

## Where the deep research lives

Five research passes (architecture, cost, marketplace legality, nonprofit structure, M0 specifics) are summarized in the spec (§3, §6) + the architecture-research doc; the raw synthesis is captured there. You do not need to re-run them.

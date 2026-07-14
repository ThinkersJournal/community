# HANDOFF — start here (new session / new agent)

This repo is **self-contained**: everything needed to continue is committed here. (Claude Code memory is scoped per project directory, so a session opened in this repo starts with its **own empty memory** and will NOT auto-load context from the sibling `ThinkersJournal.com` marketing-site project. This file + the committed docs are the source of truth. Build up this project's memory as you go.)

## What this is

**Thinker's Journal — Community platform** (project ② of 2). A public social publishing platform for thinkers **+ live @-references** into their work. The **marketing website** (project ①) is a *separate*, already-live repo: `ThinkersJournal/ThinkersJournal.com` — don't confuse them.

**Status:** design complete + approved; implementation begins at **M0**. Private repo; kept quiet until launch scope (M0–M4) is done.

## Documentation map — everything lives in THIS repo

All Thinker's Journal **Community** documentation lives here (not in the sibling marketing-site project). The design is written **once for the whole platform**; implementation plans are added **one per milestone** as we build.

- `docs/superpowers/specs/2026-07-13-community-platform-design.md` — **the whole-platform design (M0 → M4 + post-launch):** product, all decisions, architecture, cost model, cost-recovery/legal, and the full build sequence. The reference for planning *every* milestone.
- `docs/superpowers/specs/2026-07-13-community-platform-architecture-research.md` — the deep research + adversarial review behind the design.
- `docs/superpowers/plans/` — **one implementation plan per milestone.** `2026-07-13-m0-foundations.md` exists now; **M1–M4 plans get written here** (via `superpowers:writing-plans` against the design spec) as each milestone is reached, then built.
- `HANDOFF.md` (this file) — session entry point + carry-over context.

**Pattern for every milestone after M0:** open a session in this repo → read the design spec → run `superpowers:writing-plans` for that milestone → the new plan lands in `docs/superpowers/plans/` → build it (subagent-driven). Nothing depends on the other project; this repo also grows its own Claude memory as you work.

## ▶ To build M0 (the next action)

1. Read the design spec + the M0 plan:
   - `docs/superpowers/specs/2026-07-13-community-platform-design.md` — authoritative design (decisions, architecture, cost model, build sequence). Deep rationale in `…-architecture-research.md`.
   - `docs/superpowers/plans/2026-07-13-m0-foundations.md` — the **19-task, test-first M0 plan** (this is what you execute).
2. Execute it with **`superpowers:subagent-driven-development`** against that plan (fresh subagent per task + review gates), on a feature branch.
3. **Prereq cadence (local-first):** Tasks 1–4 need only **Node ≥20 + pnpm** (`corepack enable`) — no infra, no cost. **Task 5** needs **Docker** (local Postgres 16). Neon (a **direct/non-pooled** conn string) + Cloudflare account + Turnstile + Postmark come only near deploy (Tasks 6b/8/19). Full table in the plan's Prerequisites section.
4. **Load-bearing rules** are in the plan's *Global Constraints* — most important: the **HYPERDRIVE_FRESH-vs-CACHED** binding rule (all auth/dup/verify/permission reads use FRESH), Durable Objects need **`new_sqlite_classes`**, the tooling-shape pins (vitest-pool-workers `cloudflareTest()`, top-level `ratelimit`), and the `__test` route MUST be off in prod.

## Carry-over context (this lived only in the other project's memory)

- **Founder:** ciresnave (ciresnave@gmail.com); 44-year programmer; non-profit "in formation," solo, unfunded, will take zero personal comp. GitHub org: `ThinkersJournal`.
- **Tooling preferences:** no WordPress, no Figma. Prefer **Playwright CLI + the playwright-cli skill** (token-efficient) over the MCP for scripted work; MCP fine for live exploration. MCP servers configured at user scope: playwright, chrome-devtools, github (via a **PAT header** — OAuth fails), cloudflare-bindings, cloudflare-docs, serena (dashboard disabled). Context7 for live docs.
- **Stack (decided):** TypeScript on Cloudflare Workers (NOT Rust — workers-rs was non-viable) + Postgres/Neon via Hyperdrive + R2 + KV + Durable Objects; Astro `web` + TS `api`, two Workers joined by a Service Binding; `hash-wasm` Argon2id; `auth-framework` (the founder's Rust crate) is a *design reference only*, not a dependency.
- **Grounded cost model:** optimized ~$90–135/mo at 100k users, **~$850–960/mo at 1M** (~$10–12k/yr, no runaway line) vs a naive $5.4k–16.3k — the caching/offload design (spec §3, decisions #22–23) closes the Postgres cost gap.
- **Cost recovery / legal (spec §6):** fund via a broad supporter/donation/sponsor/grant portfolio (public-charity status depends on broad public support). Any commerce (marketplace, publishing, print-on-demand, funding-referral) must live in a **wholly-owned taxable subsidiary**, never inside the 501(c)(3) — the risk is the *private-benefit doctrine*, and a low fee gives no protection. **⏰ Standing real-world to-do (independent of code): a nonprofit attorney + CPA to lock in public-charity status and the parent/subsidiary structure before filing Form 1023.**

## Where the deep research lives

Five research passes (architecture, cost, marketplace legality, nonprofit structure, M0 specifics) are summarized in the spec (§3, §6) + the architecture-research doc; the raw synthesis is captured there. You do not need to re-run them.

# Thinker's Journal — Community Platform

The flagship of [Thinker's Journal](https://thinkersjournal.com): a public **social publishing platform for thinkers** with **live, precise @-references** into their work (the exact file + lines, CI check, PR, or issue on GitHub/GitLab, plus web/YouTube/X).

> **▶ New session / new agent?** Start with **[`HANDOFF.md`](HANDOFF.md)** — the self-contained entry point (this repo's Claude memory is separate from the marketing-site project).

> **Status:** pre-development. The full architecture is designed; implementation begins at milestone **M0**. This repository is **private** and stays quiet until the launch scope (M0–M4) is complete.

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

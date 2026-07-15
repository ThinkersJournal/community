# Thinker's Journal — Community Platform Design Spec

- **Date:** 2026-07-13
- **Status:** Design approved in brainstorming; pending founder review of this document → then per-milestone implementation plans (starting M0).
- **Scope of this doc:** the cross-cutting **platform architecture** and the resolved decisions. This is project ② (the "Community" platform), distinct from the already-live marketing website (project ①). It will move to the platform's own repo when created.
- **Companion:** deep rationale, trade-offs, and sources live in [`2026-07-13-community-platform-architecture-research.md`](2026-07-13-community-platform-architecture-research.md) (a 13-agent research pass + adversarial review). This spec is the authoritative *decisions*; that doc is the *why*.

---

## 1. Product & scope

A public **social publishing platform for thinkers** (starting with programmers), with **two first-class, equal pillars**:

- **Pillar A — Social publishing:** accounts + email verification, write/publish Markdown posts with image uploads, public SEO-friendly profiles + post pages + reading, follow + personalized home feed, comments + reactions, tags + explore/trending + search, notifications (in-app + email), report + moderation.
- **Pillar B — Live @-references / interop (the moat):** posts embed rich references to the exact file+lines / CI check / PR / issue on GitHub & GitLab, generic web links (OG unfurl), YouTube, and X. **Hybrid model:** a snapshot captured at post time (always renders) + a background live-refresh that diffs and shows *unchanged / changed / resolved / gone*. Authoring = paste-a-URL-to-enrich + an @/slash picker.

**Launch strategy:** the full v1 (all of A + B, milestones M0–M4) is built **privately, in proven stages**, and kept quiet until complete — then revealed as one public launch. M5+ (references into TJ-*hosted* code) is explicitly post-launch. *(The adversarial review flagged this as the biggest risk and recommended shipping Pillar A first with references as a flagged fast-follow; the founder chose the unified private-then-public launch with clear eyes.)*

**Constraints:** solo, unfunded, veteran founder → cost-sensitive and must be maintainable by one person.

---

## 2. Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| 1 | Backend language | **100% TypeScript** on Workers. Rust *not used* (workers-rs non-viable for our needs); Argon2id via the openpgpjs **`argon2id`** package (**corrected in M0** — `hash-wasm` is non-viable on Workers: it compiles embedded base64 wasm at runtime, which workerd forbids. See the M0 plan's *As-built deviations*). `auth-framework` = design reference + standalone crate, not a dependency. |
| 2 | Launch sequencing | **Both pillars private until M0–M4 done, launch together.** |
| 3 | Private-reference safety | Private refs **freeze to snapshot by default** (opt-in to keep live); private resources **never de-duped across authors**; kill-switch to snapshot-only on material change. |
| 4 | Compute + DB | Cloudflare **Workers** + **Postgres on Neon** via **two Hyperdrive bindings** (cached + cache-disabled) + a **cron keep-warm ping** to blunt Neon cold-start on SEO pages. |
| 5 | Email | **Postmark** at launch (Tier-1 + Tier-2 from separate `verify.` / `notify.` subdomains); plan Tier-2 → Amazon SES at >~20–30k/mo. |
| 6 | Source connect | **GitHub App** (fine-grained, webhook-ready). GitLab/YouTube/X connectors part of v1 per the unified-launch choice. |
| 7 | Feed | **Pull-on-read, reverse-chronological**, keyset pagination; fan-out-on-write is a later additive migration on measured evidence. |
| 8 | Search | **Postgres FTS** (`tsvector` + `pg_trgm`); external engine deferred behind a concrete trigger. |
| 9 | Realtime notifications | **Durable Object + WebSocket (Hibernation API)** push + REST/KV polling fallback. |
| 10 | Sessions | **Own the primitive** (opaque cookie + KV), *not* Astro's Sessions API — which must be **actively disabled** in `astro.config.mjs` (leaving `session` unset silently opts into a KV session driver + provisions a `SESSION` binding; see the M0 plan's *As-built deviations*). 30-day sliding, SameSite=Lax. **MFA deferred** post-launch. |
| 11 | Email-verification gate | **Soft gate** — browse unverified; verified email required to post/comment/follow. |
| 12 | Reactions | **Small "thinker-tone" set** — proposed: **Insightful / Curious / Agree** (final wording TBD by founder). |
| 13 | Tags | Free-form + a curated/promoted subset; tag *creation* gated to accounts >7 days. |
| 14 | Moderation | **Auto-hide (not delete)** at 3 distinct reporters/24h pending review; **warn → suspend → ban** ladder + appeals; no device fingerprinting at launch. |
| 15 | Signup age | **16+** (sidesteps COPPA; eases EU minor handling). |
| 16 | EU/UK | **Serve from day one**, accepting GDPR + EU DSA obligations. |
| 17 | Private-ref retention | Retain snapshot; **purge captured private content 30 days after token revoked**; surface "access lost." |
| 18 | Images | **Disallow SVG**; output **WebP**; ~10–15 MB/post, ~5 MB/avatar + per-user quota; discard pre-resize originals; enable the free CSAM Scanning Tool. |
| 19 | Notification cadence | Instant in-app for all; instant email for high-signal only (mentions/replies/moderation); batched digest for reactions/follows. |
| 20 | Public-page cache | `max-age` 30–60s + `stale-while-revalidate` 300–600s (viewer-agnostic content only). |
| 21 | Legal/continuity | Register founder as **DMCA Designated Agent** up front; attorney pass on ToS/Guidelines/Privacy/DMCA before launch; pre-decide a cost-recovery trigger; line up a backup admin. Monetization deferred. |
| 22 | Reference refresh policy | **Access-driven**: lazy refresh-on-view + `next_check_at` tapered by `last_viewed_at`; **dormant (unscheduled) when unviewed**, reactivated on next view. Cuts API-budget + compute for cold content to ~zero. |
| 23 | Postgres cost control | Treat Postgres load as reducible from the start: edge-cache public reads hard; move **view-counts/trending to Analytics Engine + Durable-Object write-coalescing**; cache feeds + social graph in KV/DO; keep sessions/rate-limits/unread-counts/reference-live-state off Postgres. Postgres then scales with **durable data + writes, not raw traffic**. Elevate a usage-scaling **cost-recovery mechanism** (donations/sponsors/grants) from deferred to **planned**. |

---

## 3. Architecture (decided)

*(Condensed; see the research doc §0–§12 for full rationale and sources.)*

**Runtime & language.** Single **TypeScript `api` Worker**: routing, hand-rolled auth, Hyperdrive/Postgres (`pg` over `nodejs_compat`), R2, KV, connector modules, Durable Objects, Queue consumers, Cron handlers. Argon2id via the openpgpjs **`argon2id`** package, driven by a **statically-imported `.wasm` module** (`hash-wasm` cannot run on Workers — decision #1). **Workers Paid ($5/mo) from day one** (Argon2 + image encode exceed the Free 10 ms CPU cap; any Argon2id on Workers requires Paid regardless).

**Topology.** Two Workers joined by a Service Binding: **`web`** (Astro `output:'server'`, `@astrojs/cloudflare`, Workers Static Assets, Workers Builds git deploy) at apex/`www`; **`api`** at `api.thinkersjournal.com` and bound into `web` as `env.API`. Durable Objects require the dedicated `api` Worker. Session cookie scoped to `.thinkersjournal.com`, httpOnly/Secure/**SameSite=Lax** — that is the **production** shape; local dev omits `Domain`+`Secure` (no browser stores them on `http://127.0.0.1`), gated on `TEST_ROUTES`, per the M0 plan's *Global Constraints*.

**Rendering.** Per-route: prerender marketing/legal/logged-out home; **SSR** the SEO/unfurl-critical pages (`/@user`, `/@user/slug`, explore, tags, search, sitemap, RSS) with OG/JSON-LD, wrapped in short `max-age` + long `stale-while-revalidate` + `Cache-Tag` (purge on edit); **islands** for authed interactivity (editor + reference picker, feed, reactions/follow, notifications bell). Never bake per-viewer state into cached HTML.

**Data access.** Two Hyperdrive bindings: **cached** (public reads) and **cache-disabled** (auth, search, unread counts, read-after-write). Transaction-mode pooler ⇒ all uniqueness/races via DB constraints + `INSERT … ON CONFLICT`; timestamps as bound params (keep read paths cacheable).

**Data model (Postgres).** UUIDv7 PKs; `citext`/`pg_trgm`/`tsvector`+GIN. `users` (sensitive) split from `profiles` (public). `posts` hold clean `markdown_source` with `{{ref:TOKEN}}` placeholders + generated `search_vector` + denormalized counters. **References first-class** (`references` + `post_references` + envelope-encrypted `source_connections`), with **private-resource rows keyed by owning connection** (never shared cross-author). Comments = materialized-path tree. Reactions = dual-nullable-FK with `CHECK`. Media bytes only as R2 keys; snapshots bounded.

**Auth & sessions.** Own opaque cookie + KV session (`{user_id, roles, security_epoch, csrf}`). **`UserSecurityDO` per user** holds a monotonic `security_epoch`, checked on security-sensitive mutations only → strongly-consistent ban/logout-everywhere while 95%+ of traffic rides cheap KV. Argon2id (OWASP params). CSRF = Origin check + double-submit token. Email verification = hashed token, 24 h TTL, `fetch()` to Postmark, Turnstile + `ratelimit` binding. OAuth "connect a source" = AES-256-GCM envelope-encrypted tokens (root key in a Workers Secret, `key_version` for rotation), decrypted in-memory only at fetch-live.

**Feed / search.** Pull-on-read chronological, keyset cursor, covering indexes; feed fetched client-side over an SSR skeleton; KV caches followee lists + fragments. Postgres FTS via the cache-disabled binding.

**Reference engine.** Resolve-once snapshot at post time (Postgres rows + R2 blobs, dedup by content hash **for public resources only**). Live-refresh is **access-driven, not blindly scheduled**: on view, if a reference's cached `live_state` is staler than its type's window, the render serves the last-known state instantly and enqueues a background refresh for *next* time; each reference's `next_check_at` **tapers with `last_viewed_at`** (recently-viewed + pending → seconds; stable → hours; unviewed for weeks → **dormant/unscheduled**, reactivated on the next view). The Cron+Queue sweep only works the small set of recently-attended references. Renders read Postgres + KV only, never a source API. Connector interface per source (`identify/resolve/fetchLive/deepLink`), `LiveState.access` separate from `LiveState.diff`. Prefer REST + ETag (free 304s) for polling; per-type cadences; GitHub App auth with a **per-author rate-budget DO**. **Private references freeze to snapshot by default** (see decision #3).

**Notifications.** Postgres row = source of record → Queue → per-user **`NotifyDO`** WebSocket push via the **Hibernation API** (idle-cheap); client also polls a KV-cached unread count for authoritative state. Dedupe (at-least-once queues); collapse chatty events before the queue. Email tiers on Postmark.

**Media.** Worker-proxied upload → magic-byte type sniff → Images-binding WebP variants (strip EXIF) → R2 (content-hashed key) → served from `cdn.thinkersjournal.com`. No SVG. CSAM tool enabled.

**Moderation & safety (day one).** Turnstile + Bot Fight Mode; layered rate limiting (WAF + `ratelimit` binding + sharded DOs); pre-publish OpenAI omni-moderation **scoring into a queue (not hard-block)**; report → ranked queue → **auto-hide** → action, admin UI behind **Cloudflare Access**, append-only `moderation_actions` audit log. Legal baseline: DMCA agent, §512 flow, CSAM/NCMEC playbook, repeat-infringer strikes, DSA notice-and-action.

**Security/privacy mitigations (from the adversarial review).** (1) Private-reference leak → freeze-to-snapshot default + no cross-author dedup + change kill-switch. (2) Sessions → own the primitive, not the experimental Astro API. (3) OAuth-token blast radius → fine-grained GitHub App tokens, isolated minimal-dependency sweep, decrypt only per-batch, egress alerting, pinned/vendored connector deps. (4) Neon cold-start → keep-warm cron + generous SWR + origin-p95 instrumentation. (5) Disclose third-party (OpenAI) content scanning in the privacy policy.

**Cost (monthly) — grounded model (2026-07-13 pricing research).** The cost-control design (decisions #22–23) removes the uncapped Postgres runaway. Optimized (the design) vs. the same stack run naively (reads/counters/sessions hitting Postgres directly):

| Users | **Optimized** | Naive (contrast) |
|---|---|---|
| 1k | ~$5–15 | — |
| 10k | ~$20–45 | — |
| 100k | **~$90–135** (Neon ~$40–55) | ~$1,050–3,750 (Postgres 90%+) |
| 1M | **~$850–960** (diversified: Neon ~$260–320, email ~$150, Workers ~$126, Images ~$100–135, DO ~$100–110, KV ~$45–50, AE ~$28) | ~$5,400–16,300+ (Postgres 90–97%; risks Neon's 56-CU ceiling) |

At 1M users the optimized bill is **~$10–12k/year with no single runaway line** — very fundable from a modest donation/sponsorship base (or the Pillar-C marketplace). **Zero egress** on Workers/R2/Hyperdrive is the structural moat. The ~$1–3.5k/mo Postgres worry was a caching-design gap, not a Neon-pricing problem, and the design closes it. Ranked levers: (1) **hard edge-cache** — a viral post = ~1 Postgres query per SWR window regardless of viewers (>99.7% cut on viral paths); (2) **counters → Analytics Engine + DO write-coalescing** — lets Neon *autosuspend* off-peak (the biggest single Neon saving; replacement tiers cost 1–3% of the Postgres they eliminate); (3) **sessions/feed/graph off Postgres** into DO/KV (fan-out-on-read, DO-coalesced writes); (4) **access-driven reference refresh** (decision #22). Net: **Postgres scales with durable data + write volume, not raw traffic.**

**Implementation notes (from the cost research):** batch DO counter increments in memory and flush on an alarm — don't persist every increment (SQLite row-writes are the DO cost driver at 1M); use **AWS SES for bulk Tier-2 email** (Postmark vs SES ≈ 10–15× at scale — keep Postmark only for low-volume trust-critical mail) + **weekly** digests; keep search on GIN/`tsvector` (never ILIKE/pgvector — 10–50× per-query) with a Typesense escape hatch ready; size Neon min ~0.25 CU / modest max, high ceiling as a safety net only. **These are planning ranges** — instrument (Cloudflare Cache Analytics + Hyperdrive observability) and re-measure ~4–6 weeks after each growth milestone. Watch: DO hibernation discipline, GitHub/GitLab rate limits, anonymous SEO traffic spikes.

---

## 4. Build sequence (internal milestones → one private→public launch)

- **M0 — Foundations & spine (BUILT, not yet deployed):** Neon + two Hyperdrive bindings; two-Worker topology + Service Binding + Workers Builds deploy; domain/cookie layout; hand-rolled auth (signup/login/opaque-KV sessions, Argon2id via the `argon2id` package, soft email verification, Turnstile + `ratelimits`, `UserSecurityDO`, CSRF); `users`/`profiles` migrations. *Retires the biggest risk (auth on Workers) first.* **What was actually built deviates from the plan in several places — see the M0 plan's *As-built deviations (M0)*.***
- **M1 — Publishing & public web:** `posts` + Markdown editor island; media pipeline; SSR public post/profile pages (OG/JSON-LD, edge cache + `Cache-Tag` purge, sitemap/RSS). *End state: a working SEO-friendly publishing site.*
- **M2 — Social graph & engagement:** follows; pull-on-read feed; comments (materialized-path); reactions; notifications (DO Hibernation WS + email + batching); Postgres search + explore/trending.
- **M3 — Reference engine (the moat):** GitHub App + GitLab OAuth; connector interface + all launch connectors; snapshot capture; paste-to-enrich + @/slash picker; Cron+Queue live-refresh sweep; per-author rate-budget DO; envelope-encrypted `source_connections`; reference-change notifications reuse the M2 pipeline.
- **M4 — Safety, legal, launch readiness:** full report→queue→auto-hide→action + audit log behind Access; moderation scoring + spam heuristics; DMCA registration + takedown/counter-notice; CSAM/NCMEC playbook; attorney review; load/EXPLAIN-ANALYZE validation; DO-hibernation cost audit; flip private → public.

Each milestone gets its **own** implementation plan (spec → plan → build). M0 is first.

---

## 5. Deferred / post-launch (explicitly out of scope for launch)

M5+ references into TJ-hosted code/services; MFA/TOTP; fan-out-on-write feed migration; external search engine; the **marketplace (Pillar C)** + cost-recovery portfolio (see §6); richer editor features.

---

## 6. Cost recovery & legal structure

Grounded by a focused research pass (2026-07-13). **Orientation only — a nonprofit attorney + CPA must bless the specifics before any commerce launches.**

**Funding is not the hard part; the marketplace is a bonus, not a necessity.** At the optimized run-rate (~$10–12k/yr even at 1M users), a **recurring supporter tier at ~$30/mo needs only ~115–150 supporters** to cover costs — alongside **sponsorships** (structured as IRC §513(i) qualified-sponsorship acknowledgments) and **grants** (tech/education foundations, Cloudflare-for-good). The marketing site's Support page already carries the day-one levers (Open Collective / GitHub Sponsors / Ko-fi). **Lead with this portfolio;** do not rely on the marketplace to fund launch.

**The marketplace (Pillar C) — feasible, but structured, and later.** Critical legal insight: the risk is the **private-benefit doctrine (an exemption-killer), not UBIT (a tax)** — and **a low ~1% take rate provides zero legal protection.** The IRS twice denied 501(c)(3) status to co-op galleries selling members' own work (Rev. Rul. 71-395; 76-152 — even at a 10% below-cost commission), because value flows to identifiable private individuals; a members-sell-their-work marketplace run *inside* the 501(c)(3) is that exact pattern. Therefore:
- **Run it in a wholly-owned taxable subsidiary** (C-corp, or an LLC electing C-corp treatment — a pass-through LLC does *not* block UBI), which pays its own tax and remits profit up as dividends; license TJ brand/IP to it at documented arm's-length rates (IRC §512(b)(13)); limit officer/director overlap.
- **Price it 5–10%, not 1%** (1% can't even cover Stripe's ~3% processing; recouping ~$3.5k/mo at 1% needs ~$4.2M/yr GMV).
- **Payments:** Stripe Connect **Standard** accounts + Stripe-handled pricing (pushes KYC/PCI/1099-K/disputes onto Stripe + seller). Enable **Stripe Tax** from day one.
- **Tax surface:** scope the eventual marketplace to **digital-goods, US-only** at first — EU/UK VAT can trigger on a *single* cross-border digital sale with no threshold; US marketplace-facilitator sales tax only bites past state economic-nexus (~$100k/state/yr) → monitor, don't pre-file.

**⏰ Time-sensitive (NOT deferrable):** decide the **entity structure** — a narrowly-scoped 501(c)(3) for the public/educational mission + a separate **taxable subsidiary** for any commerce — and the **Form 1023 narrative** *before filing Form 1023* (retrofitting a subsidiary after IRS recognition is costly). **File Form 1023 within 27 months of formation** so early donations/sponsorships are retroactively deductible. Engage a nonprofit attorney early, even though the marketplace itself is years out.

**Keep-compatible-now (cheap hooks, no build):** standardize on Stripe Connect Standard whenever payments first appear (even the supporter tier); M1 member profiles/projects can later carry optional "sellable artifact" metadata; keep marketplace tables out of the launch schema.

### Exploratory: future add-on services & the two-entity playbook

*(What-ifs the founder raised — NOT committed scope. Grounded 2026-07-13; orientation only, attorney/CPA required.)* All commercial member-transactional services live in the **taxable subsidiary**; the **501(c)(3)** keeps only open/educational programming, no-fee directories/intros, and an independently-run grants program.

| Service (if ever pursued) | Home | Key point |
|---|---|---|
| Marketplace | Subsidiary | Private-benefit doctrine (co-op-gallery denials). |
| Book publishing | Split | Teaching-how-to-publish → 501(c)(3); producing members' *commercial* books → subsidiary. Below-market ≠ charitable (B.S.W. Group). |
| Print-on-demand merch | Subsidiary | Ordinary retail; fragmentation rule tests each product line separately. |
| Funder/lender referral **taking a % of funding** | Subsidiary **+ financial licensing** | A contingent capital-raising fee likely = unregistered **broker-dealer** (SEC/FINRA §15(a)) or state loan-broker; the subsidiary is a *vehicle, not a license*. The **free** version (directory + funding education + no-fee warm intros + flat non-contingent event fees) can live in the 501(c)(3). |
| Grants-to-thinkers | 501(c)(3) — **no member vote** | Legit if a broad charitable class + objective published criteria + an **independent selection committee** (disinterested). A member *vote* recreates the fatal beneficiary-selector overlap (IRS denied LTR 202504021). Community input advisory only. |

**Doctrine correction (important):** taking zero personal compensation solves private **inurement** (insiders) — but does **not** cure private **benefit**, which runs to *any* private party incl. ordinary members and is judged by *what the activity is / whom it primarily serves*, not where the money ends up. ("All surplus → grants" is a destination-of-income argument courts reject — Easter House, Zagfly.) Housing member-commerce in the subsidiary is what actually cures it.

**Founder compensation:** you *may* be reasonably paid by the subsidiary (a normal employer) and/or by the 501(c)(3) itself — "no inurement" means no *unreasonable* comp / no profit distribution, not "no salary." The unpaid stance is a generous choice, not a legal requirement. Document reasonableness (§4958 rebuttable-presumption process) since the founder is a disqualified person.

**Extra subsidiary constraints (beyond normal for-profit rules):** genuine corporate separateness or activities attribute back to the parent; arm's-length intercompany dealings and **no parent subsidy of the sub** (free labor/IP/below-market loans); §512(b)(13) taxes rent/royalty/interest (not dividends) paid up; and — critically — **secure public-charity status**: a **private foundation** faces §4943 excess-business-holdings limits that can forbid wholly owning an active business, whereas a **public charity does not**. Resolve public-charity vs private-foundation classification early on Form 1023.

## 7. Next step

Founder reviews this spec → then invoke **writing-plans** for **M0 (Foundations & spine)** as the first buildable sub-project. The platform gets its own git repo at that point.

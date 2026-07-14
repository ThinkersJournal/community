# Community Platform — Architecture Research Synthesis (DRAFT)

- **Date:** 2026-07-13
- **Status:** Research synthesis, pending founder decisions → will be refined into the formal spec.
- **Provenance:** 13-agent research pass (11 dimensions researched against current Cloudflare/GitHub/GitLab docs, synthesized, then adversarially reviewed). ~907k tokens of analysis.
- **Note:** This is a working artifact for the Community platform (project ②). It will move to the platform's own repo when created.

---

## TL;DR

- **Backend is a single TypeScript Worker** talking to Postgres via Hyperdrive (the `pg` driver over `nodejs_compat`). **Rust is used only as small pure WASM modules** (Argon2id password hashing required; Markdown/diff/regex optional). **`auth-framework` becomes a design reference, not a compiled dependency** — its full dependency graph isn't WASM-portable, and Rust-on-Workers + Postgres is fragile today. *(This reverses the earlier "reuse auth-framework adapted to WASM" assumption — needs your call.)*
- **Two Workers** (`web` = Astro SSR; `api` = TS backend + Durable Objects + Queues + Cron) joined by a Service Binding. **Workers Paid ($5/mo) from day one** (Argon2 + image encode exceed the Free 10ms CPU cap).
- **Postgres on Neon** (managed, serverless) with **two Hyperdrive bindings** (cached for public reads, cache-disabled for auth/search/read-after-write).
- **Feed:** pull-on-read, reverse-chronological, keyset pagination (migration to fan-out-on-write is additive, later). **Search:** Postgres FTS (`tsvector` + `pg_trgm`). **Notifications:** Durable Object + WebSocket (Hibernation API) + email (Postmark).
- **Reference engine:** resolve-once snapshot at post time; background Cron+Queue sweep refreshes live-state into KV; renders never call source APIs. GitHub App auth; per-author rate-budget DO.
- **Two critical review findings** (below) reshape the plan: (1) launch scope, (2) private-content reference leak.

---

## Adversarial review — verdict

> The architecture is technically sound and unusually well-reasoned for the decided stack. Making the API a single TypeScript Worker (pg/node-postgres over Hyperdrive via nodejs_compat) and using Rust only as pure WASM modules correctly retires the biggest feasibility risk. The Hyperdrive dual-binding, DO-hibernation, pull-on-read feed, and no-egress cost posture are all defensible against current sources. **Two problems are severe enough to change plans:** (1) launch scope — building BOTH pillars privately before any public feedback is an existential bet for a solo unfunded founder; and (2) referencing private content is a live cross-tenant leak surface. Three important issues need reconciling (Neon cold starts vs SEO; sessions on Astro's experimental API; OAuth-token blast radius). No stack swap is warranted — every issue is a mitigation within the decided stack.

### Critical findings

1. **Launch scope is existential risk, not just schedule risk.** "All of Pillar A + B, private until done" asks one unfunded person to build two full products (M0–M4 is realistically **12–24 months solo**) before any public feedback — maximizing time-to-first-feedback and burnout, and betting the whole moat before validating Pillar A. **Recommendation:** decouple the pillars in the *go-live* plan (stack stays whole). Ship **Pillar A first** (M0–M2 + M4 safety/legal); treat the **reference engine (M3) as a fast-follow behind a flag**. The schema already makes references additive, so nothing is thrown away.

2. **Referencing private content is a live cross-tenant data-leak surface.** (a) The background live-refresh keeps fetching a private resource with the *author's* token and writes current state to KV that renders on a **public** post — a private file that later gains a secret would be republished publicly with no human in the loop. (b) De-duping reference rows by `(type, canonical_url)` and R2 blobs by content-hash can make one shared row back posts by *different* authors — sharing `live_state` fetched with author A's token onto author B's post leaks A-authorized private data. **Recommendation:** freeze private references to their post-time snapshot by default (explicit "keep live" opt-in + visible "private content republished" warning); scope de-dup so private resources are keyed by owning connection and **never** shared across trust boundaries; kill-switch to snapshot-only when private bytes change materially.

### Important findings

3. **Neon scale-to-zero cold starts (~1.8s median / 3.1s worst) fight the SEO pillar** and contradict the cost rationale (Neon was chosen to avoid a monthly floor; fixing SEO needs a small always-on compute, which reintroduces the floor). **Decide:** small always-on compute *or* scale-to-zero + a cron keep-warm ping + generous `stale-while-revalidate`. Instrument origin p95 TTFB on cache-miss from day one.

4. **Core sessions ride Astro's *experimental* Sessions API** (open bug #15802). **Recommendation:** own the session primitive directly — a ~50-line opaque-cookie + KV read/write — and keep Astro middleware only for wiring.

5. **OAuth-token blast radius:** the background sweep decrypts many users' tokens in one Worker; a single malicious transitive dependency could exfiltrate them. **Recommendation:** fine-grained GitHub App per-repo read-only tokens; run the token-decrypting sweep in an isolated, minimal-dependency code path; decrypt only the batch's tokens; alert on anomalous egress; pin/vendor connector deps aggressively.

### Minor findings (tunable)

- `UserSecurityDO` epoch check adds a DO round-trip per mutating write — confirm it runs only on security-sensitive mutations, not reactions/view-counts.
- Argon2id ~19 MiB/hash + the ~100ms figure is a floor (WASM marshalling overhead) — keep Turnstile + rate-limit in front; load-test concurrent logins.
- Synchronous image pipeline concentrates memory/CPU — reject over-cap before buffering, encode variants sequentially, load-test concurrent uploads; verify EXIF strip + CSAM tool coverage empirically.
- Client-side feed is the one un-cacheable path hitting the cache-disabled binding per active session — watch Hyperdrive origin connections; keep KV fragment TTL high.
- Routing user content through OpenAI omni-moderation sends content to a third party — disclose in privacy policy.

---

## Founder decisions needed

Each has a recommendation; the ones that reverse or challenge a prior choice are flagged ⚑.

| # | Decision | Recommendation |
|---|---|---|
| 1 ⚑ | **Backend language** | TS API Worker + Rust-as-WASM only (Argon2 required); `auth-framework` as design reference, not dependency |
| 2 ⚑ | **Launch sequencing** | Decouple: ship Pillar A first, reference engine as flagged fast-follow (reviewer's top rec) |
| 3 ⚑ | **Private-reference safety** | Freeze private refs to snapshot by default; opt-in to keep live; no cross-author de-dup |
| 4 | Postgres host | Neon (+ decide cold-start mitigation) vs Supabase vs self-host |
| 5 | Email vendor | Postmark at launch; plan Tier-2 → Amazon SES at >~20–30k/mo; separate `verify.`/`notify.` subdomains |
| 6 | GitHub connect | GitHub App (fine-grained, webhooks). Defer GitLab to fast-follow |
| 7 | Feed ranking | Pure reverse-chronological at launch |
| 8 | Fan-out horizon | Pull-on-read now; plan (don't build) hybrid migration on measured evidence |
| 9 | Search bar | Postgres FTS at launch; define a concrete migration trigger |
| 10 | Realtime notifications | DO + WebSocket (Hibernation) push + poll fallback; polling-only is an acceptable schedule-saver |
| 11 | Email-verification gate | Soft: browse unverified, verified to post/comment/follow |
| 12 | Session lifetime / MFA | 30-day sliding, Lax cookie; defer TOTP/MFA |
| 13 | Public-page cache staleness | `max-age` 30–60s + `stale-while-revalidate` 300–600s |
| 14 | Notification cadence | Instant in-app for all; instant email for high-signal only; batched digest for reactions/follows |
| 15 | Reactions & tags | Small "thinker-tone" reaction set; free-form tags + curated subset, tag creation gated >7-day accounts |
| 16 | Moderation thresholds | Auto-hide (not delete) at 3 distinct reporters/24h; warn→suspend→ban ladder + appeals; no fingerprinting at launch |
| 17 | EU/UK availability | Serve from day one; accept DSA/GDPR (report form already satisfies notice-and-action) |
| 18 | Minimum signup age | 16+ (sidesteps COPPA; eases EU minor handling) |
| 19 | Private-ref retention | Retain snapshot; purge captured private content 30 days after token revoked; surface "access lost" |
| 20 | Image policy | Disallow SVG; output WebP; ~10–15MB/post, ~5MB/avatar + per-user quota; discard originals; enable CSAM tool |
| 21 | DMCA agent / continuity | Register founder as DMCA agent now; pre-decide a cost-recovery trigger; line up a backup admin |

---

## The architecture

### 0. Cross-cutting resolution — what language the backend is

The API is a **single TypeScript Worker** (routing, HTTP, sessions, Hyperdrive/Postgres via the officially-supported `pg`/node-postgres driver over `nodejs_compat`). Rust is used **only as small, pure, `wasm32`-clean modules called from TS**, and only where it earns its keep:

- **Argon2id password hashing** — RustCrypto `argon2` compiles cleanly to `wasm32-unknown-unknown` (no tokio/sqlx/native TLS). Satisfies "hash in pure Rust" without a full Rust Worker. ~100ms CPU/hash ⇒ **Workers Paid** from day one (Free caps CPU at 10ms/invocation).
- **(Optional, deferrable)** Markdown render/sanitize, `@`-reference placeholder parsing, connector URL-identify regexes, snapshot-vs-live diff.

`auth-framework` is reused as a **design reference** (its OAuth/TOTP/RBAC flows), not a compiled dependency. This retires the "adapt auth-framework to Workers" risk. *(Why not full Rust: Hyperdrive+Postgres from Rust needs the unmerged `devsnek/rust-postgres` fork; `workers-rs` has no official Hyperdrive binding; `auth-framework`'s deps — tokio-full, sqlx, reqwest, ring, cryptoki/PKCS#11 — are not `wasm32-unknown-unknown`-portable.)*

### 1. Topology — two Workers joined by a Service Binding

- **`web` Worker** — the Astro app (`output: 'server'`, `@astrojs/cloudflare` adapter, Workers Static Assets), deployed via Workers Builds git integration (push-to-deploy + per-PR preview URLs).
- **`api` Worker** — TypeScript backend: hand-rolled auth, Hyperdrive/Postgres, R2, KV, connector modules, all Durable Objects, all Queue consumers, all Cron handlers. Exposed at `api.thinkersjournal.com` **and** bound into `web` via a Service Binding (`env.API`).

The split is mandatory (Durable Objects can't live in an Astro/Pages frontend project) and gives blast-radius isolation at zero cost (Service-Binding calls bill only CPU). Keep it at exactly two Workers. Session cookie scoped to `.thinkersjournal.com`, httpOnly, Secure, **SameSite=Lax** (Strict breaks the OAuth return leg). Pin Astro + adapter deliberately.

### 2. Rendering — per-route split, viewer-agnostic edge cache

Global `output: 'server'`, per-page `export const prerender`:
- **Prerendered:** marketing, ToS/privacy, help, 404/500, logged-out homepage.
- **SSR on-demand (SEO/unfurl-critical):** `/@user`, `/@user/slug`, explore/trending, tag pages, search results, `sitemap.xml`, RSS — fully-formed HTML with OG/JSON-LD. SSR middleware calls `env.API` for **viewer-agnostic** content only, wrapped in `Cache-Control: public, max-age=30–60, stale-while-revalidate=300–600` + `Cache-Tag: post:<id>` (purged on edit/comment). **Never** bake per-viewer state into cached HTML.
- **Client islands:** personalization bar (is-following/has-reacted, fetched client-side), reaction/follow/comment buttons, the Markdown editor + upload + `@`/slash picker (`client:only` on `/new`,`/edit`), the personalized home feed (SSR skeleton + client fetch), the notifications bell (WebSocket + poll fallback).

Biggest cost lever: cache HITs on public pages cost a request but **zero** CPU and zero Hyperdrive query.

### 3. Runtime data-access rules (Hyperdrive is a transaction-mode pooler)

Two Hyperdrive bindings on the same Postgres: a **cached binding** (60s) for public reads, and a **cache-disabled binding** for all auth/session/permission reads, search, unread counts, and read-after-write paths (Hyperdrive's cache doesn't invalidate on write). Transaction-mode ⇒ no session state across queries, no `LISTEN/NOTIFY`, no advisory locks; push all uniqueness/race handling into DB constraints + `INSERT … ON CONFLICT`; pass timestamps as bound params (not `NOW()`) so read paths stay cacheable. Origin connection ceiling ~20 (free)/~100 (paid) shared across isolates.

### 4. Data model (PostgreSQL) — key decisions

- **UUIDv7 PKs** (time-sortable); extensions `citext`, `pg_trgm`, `tsvector`+GIN.
- **`users` (sensitive) split from `profiles` (public, cacheable)**.
- **`posts`**: clean `markdown_source` with `{{ref:TOKEN}}` placeholders + generated `search_vector`; denormalized `comment_count`/`reaction_count`/`view_count`/`trending_score`.
- **References first-class:** `references` (type, `source` jsonb, `snapshot` jsonb, `live_state` jsonb, `access_state` separate from `diff_state`) + `post_references` (token → reference) + `source_connections` (envelope-encrypted OAuth tokens, `key_version`). *(Per review: private-resource rows keyed by owning connection, never shared cross-author.)*
- **Comments:** materialized-path tree (`ORDER BY path` = correct threads in one index scan).
- **Reactions:** dual-nullable-FK with `CHECK` + `UNIQUE NULLS NOT DISTINCT`.
- **Media bytes never in Postgres** — only R2 keys. **Reference snapshots bounded** (±N lines, truncated diff stats; images → R2).
- **`moderation_reports`**: app-level polymorphic `target_type/target_id`.

### 5. Auth & sessions

- **Opaque session, not JWT-as-login** — cookie holds an opaque ID; KV holds `{user_id, roles, security_epoch, csrf, issued_at}`. JWTs only for narrow uses (R2-upload authorization). *(Per review: own the session primitive directly rather than depend on Astro's experimental Sessions API.)*
- **Revocation:** one SQLite-backed **`UserSecurityDO` per user** holds a monotonic `security_epoch`; checked on **mutating** requests only. Ban / logout-everywhere / password-change bumps the epoch → invalidates sessions on next write, strongly-consistently. 95%+ of traffic stays on the cheap KV path.
- **Password hashing:** Argon2id (RustCrypto → WASM), OWASP params (m=19456,t=2,p=1).
- **CSRF:** Origin check + per-session double-submit token on all non-GET calls.
- **Email verification:** unverified user + hashed 256-bit token (24h TTL) + link via transactional provider over `fetch()` (SMTP port 25 blocked). Rate-limit via the `ratelimit` binding + Turnstile.
- **OAuth "connect a source":** Authorization Code + `state` nonce in KV; **AES-256-GCM envelope-encrypted tokens**, root key in a Workers Secret (never in Postgres), decrypt in-memory only at fetch-live; `key_version` per row; on 401/403 mark `degraded` → snapshot-only.

### 6. Home feed — pull-on-read

Fan-out-**on-read** join (`posts JOIN follows`), reverse-chronological, keyset pagination on `(published_at, id)`. Covering index `posts(author_id, published_at DESC, id)` + `follows(follower_id)`. Feed fetched **client-side** after a fast SSR skeleton (per-user, un-cacheable). KV caches followee-id lists + rendered fragments (10–30s TTL). A later `feed_entries` materialization (via Queues, above a follower threshold) is **additive** — same tables, same cursor code.

### 7. Search — Postgres-native

`tsvector`+GIN (weighted title/body/tags via `setweight`) for ranked FTS + `pg_trgm`+GIN for fuzzy/prefix, via the **cache-disabled** binding (new posts searchable instantly). Adequate to ~10k users / low-hundreds-of-thousands of posts. Migration to Meilisearch/Typesense deferred behind a concrete trigger + a write-sync pipeline (outbox + Queue).

### 8. Reference engine (the moat)

**Core rule:** never call a source API synchronously in render (any post can go viral and blow the 5,000 req/hr limit). Resolve once at post time (snapshot); a detached background sweep refreshes live-state into KV; renders read Postgres + KV only.

- **Connector interface (TS, one per source):** `identify(url)` (pure; optional WASM-Rust regex), `resolve(target, auth)` (one-time), `fetchLive(snap, auth)` (background only), `deepLink(target)`. `LiveState` keeps **`access` (Ok/StaleCredentials/Revoked) separate from `diff` (Unchanged/Changed/Resolved/Gone)**.
- **Storage:** structured snapshot in Postgres; large/immutable blobs (captured code ranges, downloaded OG/YouTube thumbnails — never hotlinked) in R2 keyed by content hash *(public resources only; private resources keyed by owning connection)*.
- **Render path:** one `SELECT … WHERE id = ANY($ids)` + parallel `KV.get()`. Zero origin calls.
- **Background refresh:** Cron (1–5 min) selects `next_check_at <= now()`, enqueues to a Queue whose consumer concurrency respects GitHub secondary limits. Prefer **REST + `If-None-Match`/ETag** (a 304 is free) over GraphQL for polling; GraphQL only for one-time `resolve()`. Per-type cadence (file/line pinned to commit SHA 10–15min; CI 30–60s while pending then 24h+; PR/issue 5–15min open, 24h+ closed; web OG 24–72h via HTMLRewriter; YouTube via free oEmbed; **X via free `publish.twitter.com/oembed`** — avoiding the paid X API v2).
- **Auth:** register a **GitHub App** (fine-grained per-repo, scales toward 12,500 req/hr, webhooks later). Two contexts: author's token (their private/own repos) + a platform "service" identity (others' public repos). Per-author rate-budget DO fed by `X-RateLimit-Remaining/-Reset`. Nudge every author to connect their own account to spread load across independent budgets. GitLab mirrors this.

Reference-status-change notifications flow through the **same** pipeline as social events.

### 9. Notifications

- **In-app realtime:** Postgres `notifications` row is source of record → action Worker enqueues to a Queue → consumer looks up the recipient's **`NotifyDO` (one per user)** and pushes over a WebSocket using the **Hibernation API** (`ctx.acceptWebSocket()`) — near-zero cost idle (hibernation vs plain is ~$10 vs ~$138–416/mo). Client holds one WS for live deltas + `GET /api/notifications` (KV-cached unread count) on load/reconnect for authoritative state. Queues are at-least-once ⇒ dedupe by notification id; collapse chatty events ("12 people reacted") server-side before the queue.
- **Email (two tiers, one vendor at launch):** Tier 1 (verification/reset/moderation) + Tier 2 (social/digest) on **Postmark**, from **distinct subdomains** (`verify.` vs `notify.`). Migrate Tier 2 → **Amazon SES** at >~20–30k/mo. Avoid Cloudflare Email Service until GA-stable.

### 10. Media pipeline

Worker-proxied synchronous flow: authed POST → **sniff real type from magic bytes** → `env.IMAGES` transform to a fixed WebP variant set (thumb/feed/full, strips EXIF/GPS on re-encode) → R2 under a content-hashed key → `image_assets` row → served from `cdn.thinkersjournal.com` (never `r2.dev`) with immutable `Cache-Control`. **Disallow SVG** (stored-XSS). Enable the free **CSAM Scanning Tool**. Synchronous (vs presigned) gives a pre-publish moderation checkpoint + one code path. Cost scales with uploads × variants, not views (no egress).

### 11. Moderation & safety (day one — open signup)

- **Signup/session gate:** **Turnstile** (free) on signup/login/reset/comment/publish, server-verified before any DB write; Bot Fight Mode.
- **Rate limiting:** WAF on auth endpoints; `ratelimit` binding on writes; resource-sharded DOs for brigade detection.
- **Pre-publish detection:** OpenAI `omni-moderation-latest` (free) to **score into the queue, not hard-block** (avoids censoring legit security-research posts); honeypots; link-density/new-domain scoring; KV duplicate-content hashing; stricter limits for accounts <7 days.
- **Report → queue → action:** rate-limited reports; Postgres queue ranked by score × report-count × reporter-trust; **auto-hide (not delete)** past a distinct-reporter threshold; admin UI behind **Cloudflare Access** (free ≤50 users); append-only `moderation_actions` audit log (satisfies DSA statement-of-reasons).
- **Legal baseline:** register a **DMCA Designated Agent**; `reason=copyright` → §512 takedown/counter-notice; **CSAM/NCMEC** playbook + automated tool; repeat-infringer strike count; EU **DSA** notice-and-action (report form must not require an account); one-time attorney pass on ToS/Guidelines/Privacy/DMCA.

### 12. Cost envelope & plan posture

**Workers Paid ($5/mo) from day one.** **Neon** as Postgres host (serverless; watch cold-start TTFB on SEO pages). Rough monthly all-in: **~$0–10 at 100 users, ~$40–90 at 1k, ~$150–450 at 10k, ~$1,000–3,500 at 100k**, with **Postgres compute the dominant, only-uncapped line item** at scale. Structural moat: **zero egress on Workers/R2/Hyperdrive**. Biggest blow-up risks: DO hibernation discipline, GitHub/GitLab API rate limits (availability wall, not $), and anonymous SEO/HN/Reddit traffic spikes (the real driver of Workers cost, uncorrelated with user count).

---

## Build sequence (internal milestones toward one private→public launch)

- **M0 — Foundations & spine.** Neon + two Hyperdrive bindings; two-Worker topology + Service Binding + Workers Builds deploy; domain/cookie layout; hand-rolled auth (signup/login/opaque-KV-sessions, Argon2id-in-WASM, email verification, Turnstile + ratelimit, `UserSecurityDO`, CSRF); `users`/`profiles` migrations. Retires the biggest risk (auth on Workers) first.
- **M1 — Publishing & public web.** `posts` + Markdown editor island; media pipeline; SSR public post/profile pages with OG/JSON-LD + edge cache + sitemap/RSS. End of M1 = a working SEO-friendly publishing site.
- **M2 — Social graph & engagement.** Follows; pull-on-read feed; comments (materialized-path); reactions; notifications (Postgres + Queue + `NotifyDO` Hibernation WS + email + batching). Postgres search + explore/trending land here/early M3.
- **M3 — Reference engine (the moat).** GitHub App + GitLab OAuth; connector interface + connectors; snapshot capture; paste-to-enrich + `@`/slash picker; Cron+Queue live-refresh sweep → KV; per-author rate-budget DO; reference-change notifications reuse M2 pipeline; envelope-encrypted `source_connections`.
- **M4 — Safety hardening, legal, launch readiness.** Full report → queue → auto-hide → action + audit log behind Access; moderation scoring; DMCA agent + takedown flow; CSAM/NCMEC playbook; repeat-infringer strikes; attorney review; load/EXPLAIN-ANALYZE validation; DO-hibernation cost audit; flip private → public.

*(Reviewer's recommended variant: ship Pillar A publicly after M2 + M4-safety; treat M3 references as a flagged fast-follow — decouples go-live from the moat.)*

# M1 — Publishing & public web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M0 auth spine into a working, SEO-friendly publishing site — `posts` + `media` on Postgres 18, a sanitize-first Markdown render pipeline, a transform-on-write image pipeline, and SSR public post/profile/sitemap/RSS pages behind Workers Cache with cross-Worker tag purge on edit.

**Architecture:** The `api` Worker gains posts CRUD (through the existing `runMutatingPipeline`) and a `POST /media` pipeline (magic-byte sniff → Images binding → WebP → content-addressed R2), plus public read routes the `web` Worker calls **anonymously**. The `web` Worker renders `markdown_source` at READ time through `@thinkersjournal/markdown` (unified → **rehype-sanitize** → Shiki), and marks those renders cacheable in **Workers Cache** with `Cache-Tag`s that `api` purges over a new `api → web` Service Binding after every edit.

**Tech Stack:** Everything M0 pinned (pnpm workspaces, TypeScript **6.0.3** exactly, wrangler 4.110.0, vitest 4.1.10 + `@cloudflare/vitest-pool-workers` 0.18.4, Astro **7.0.9** + `@astrojs/cloudflare` **14.1.3**, zod 4.4.3, pg 8.22.0, Playwright), **plus**: Postgres **18** (native `uuidv7()`), `unified@11` + `remark-parse@11` + `remark-gfm@4` + `remark-rehype@11.1.2` + **`rehype-sanitize@6`** + `rehype-external-links` + `rehype-stringify@10`, `shiki@4.3.1` (`createHighlighterCore` + **JS regex engine**, no WASM), `mdast-util-to-string`, Cloudflare **Images** binding + **R2**, **Workers Cache** (`"cache": { "enabled": true }` + Astro `cacheCloudflare()`).

## Global Constraints

*(Every task implicitly includes these. Exact values are load-bearing.)*

> **Inherited from M0's Global Constraints**, which were themselves corrected against the as-built code (2026-07-14/15). Rules reproduced here are still true and still binding. M1's own additions follow under *New in M1*. Where M1 amends an M0 rule, the amendment says so **explicitly** and carries its evidence.

### Inherited from M0 (unchanged, still binding)

- **Node ≥ 20; pnpm** (via `corepack enable`). TypeScript `strict`, `moduleResolution: "bundler"`, target `ES2022`. `compatibility_date: "2026-07-13"`, `compatibility_flags: ["nodejs_compat"]` on both Workers.
- **TypeScript is pinned to EXACTLY `6.0.3` — do NOT "upgrade" to 7.x.** TS **7.0** is the Go-native rewrite and ships **without the programmatic Compiler API** until 7.1; `astro check`, vitest's TS integration and typescript-eslint all require it. Pinned without a caret in the root `package.json`.
- **Postgres access:** `pg.Client` (NOT `Pool` — Hyperdrive *is* the pool), one per request, ended via `ctx.waitUntil`. **`withClient(hd, ctx, fn)` — THREE arguments** (M0 deviation H1). Transaction-mode pooler: no cross-query session state / `LISTEN`/`NOTIFY` / session advisory locks; keep multi-statement atomicity inside a single `BEGIN/COMMIT`. All uniqueness/races via DB constraints + `INSERT … ON CONFLICT`.
- **Durable Objects:** new DO namespaces MUST use `new_sqlite_classes`; the migrations `tag` is mandatory.
- **Argon2id** via the openpgpjs **`argon2id`** package driven by a statically-imported `.wasm` module — **never `hash-wasm`** (workerd forbids runtime Wasm compilation). Params `{ parallelism:1, iterations:2, memorySize:19456, hashLength:32 }`, PHC-encoded. Requires Workers **Paid**.
- **Session cookie:** name `tj_session`, opaque token. **Production attributes exactly:** `Path=/; Domain=.thinkersjournal.com; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`. When `env.TEST_ROUTES === "1"` (an explicit `=== "1"` allowlist, never truthiness) the cookie omits `Domain` and `Secure` **and nothing else**. Roles/`securityEpoch`/`csrfSecret` live in the KV value, never the cookie. Astro's Sessions API stays **actively disabled** via the literal `{ entrypoint: "unstorage/drivers/memory" }` driver in `astro.config.mjs` — **do not remove that block** (leaving `session` unset silently opts into a KV session store + provisions a `SESSION` binding).
- **Revocation:** per-user `UserSecurityDO` monotonic `epoch`, snapshotted at login, re-read fresh from the DO on every mutating request; mismatch → 401 + cleared cookie.
- **CSRF:** BOTH an Origin/Referer allowlist check AND a per-session double-submit token (`X-CSRF-Token` vs `sha256Hex(session.csrfSecret)`, timing-safe) on every non-GET, before touching the DB. Token delivered only via authenticated HTML/same-origin JSON, never a readable cookie.
- **Pipeline order is load-bearing:** `checkOrigin` → `readSession` → `checkCsrf` → `checkSecurityEpoch` → `requireVerifiedEmail` (opt-in) → rate limit (opt-in) → handler. **Origin before the limiter** (M0 deviation H4); **rate limit last** — quota is spent only by a request otherwise fully entitled to proceed.
- **The ROUTER does not apply the pipeline — each HANDLER does** (M0 deviation H3). ⚠️ **Task 3 changes the router's SHAPE but NOT this rule**: routes still own their opt-ins, and `apps/api/test/route-protection.test.ts` remains the compensating default-deny inventory. **Every new mutating route MUST call `runMutatingPipeline`.**
- **Soft email-verification gate:** unverified users read/browse; posting/commenting/following require `email_verified_at`. Content-mutation routes only.
- **Rate-limit keys:** every auth-shaped route consumes **two** buckets — `${ip}:${email}` **and** `email:${email}` — both keyed on the schema-lowercased email. The binding is **per key PER CLOUDFLARE LOCATION** and eventually consistent — a ceiling-shaping tool, never an exact counter.
- **Tooling-shape pins (tutorials are stale):** `cloudflareTest()` Vite plugin (Vitest 4); the rate-limit key is the top-level **PLURAL `ratelimits`** (singular is hard-rejected by wrangler 4.110.0), `simple.period` must be `10` or `60`; the Hyperdrive local override env var is `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`; adapter v14 has **no `platformProxy`**, Astro 7 has **no `Astro.locals.runtime.env`** (use `import { env } from "cloudflare:workers"`), the build emits `dist/server/` (point wrangler at the **generated** `apps/web/dist/server/wrangler.json`), and **never run `astro build` while a `wrangler dev` is alive**. Always build via `pnpm --filter @thinkersjournal/web build`.
- **`__test` routes** are gated on `env.TEST_ROUTES === "1"`, set only in `.dev.vars`/CI/vitest bindings — never in `wrangler.jsonc`'s `vars`. `pnpm smoke:deploy` asserts their absence in prod. **One flag, one gate, cannot drift.**
- **After changing bindings**, run `wrangler types` in that app and commit the regenerated `src/worker-configuration.d.ts` / `worker-configuration.d.ts`.

### New in M1

- **`HYPERDRIVE_FRESH` vs `HYPERDRIVE_CACHED` — AMENDED.** M0's rule stands for everything it named: **FRESH for ALL auth / session / permission / dup-email / verify / read-after-write.** M1 adds the boundary the M0 rule could not have known:
  > **`HYPERDRIVE_CACHED` is correct ONLY on reads whose edge entry is NOT purge-invalidated.**

  **Why (this is a real defect, not a preference).** The design (decision #20) paired a **60s** edge TTL with Hyperdrive's **60s** query cache, so a stale origin read could only ever re-cache 60s of staleness — harmless. M1 adopts the research's purge-driven **`maxAge: 3600, swr: 86400`**. That inverts the arithmetic: after a purge, the very next render is a **read-after-write**, and if it reads through `HYPERDRIVE_CACHED` it can serve a pre-edit row (Hyperdrive **never invalidates on write**) which then gets **re-cached at the edge for up to 25 hours**. A published typo fix that silently doesn't land for a day.
  And the compensation is nil: behind a 3600s edge TTL the origin is hit ~once per hour per PoP, so a **60s** query cache has a hit rate approaching **zero**. On purge-tagged paths `HYPERDRIVE_CACHED` is *strictly worse* than FRESH — a real hazard bought with no saving.
  **Therefore in M1:** post pages, profile pages and every posts-CRUD read use **FRESH**. **`sitemap.xml` + `rss.xml` use `HYPERDRIVE_CACHED`** — they are untagged, TTL-only (`maxAge: 60, swr: 600`, exactly decision #20's values), so Hyperdrive's 60s window is a subset of staleness already accepted, and its regional cache genuinely serves multiple PoPs inside one window. **That is `HYPERDRIVE_CACHED`'s first real use.** M2's feed (viewer-specific ⇒ never edge-cached ⇒ high origin rate) is where it starts paying properly.
- **Cookie is NOT in the Workers Cache key and does NOT trigger bypass.** A logged-in SSR render that doesn't set a cookie **will be cached and served to everyone** — a mass session leak. Public pages render **fully anonymous** (never forward the browser's `Cookie` to the api) and hydrate viewer state client-side; `cache.set(false)` whenever a `tj_session` cookie is present is belt-and-braces, not the defense. **`Set-Cookie` on the response DOES force bypass — do NOT rely on it.**
- **`max-age`, NEVER `s-maxage`.** `s-maxage`, `must-revalidate` and `proxy-revalidate` **silently disable** stale-while-revalidate (RFC 9111 §4.2.4). Revalidation goes foreground and the cost lever dies with no error anywhere.
- **`rehype-sanitize` is REQUIRED — raw-HTML-off is NOT sufficient.** `remark-rehype` performs **zero URL-protocol validation**: it drops raw HTML while happily emitting `href="javascript:…"`, `href="java&#115;cript:…"`, `href="vbscript:…"`, `src="data:text/html;base64,…"`. Raw-HTML-off stops **tag** injection and does nothing about **URL** injection. **NEVER add `rehype-raw`** — it is the only reason we'd need an HTML parser and it re-opens everything, including invalidating the `clobber: []` premise.
- **Sanitize is the LAST unsafe thing.** `rehype-external-links`, Shiki, and (M3) ref-cards run **AFTER** `rehypeSanitize` because `defaultSchema` allows **no `rel`, no `target`, no `style`** on any element — running them before silently strips exactly what they add. Their output is app-generated and trusted.
- **Assert on the PARSED tree, never a substring.** `expect(html).not.toContain('javascript:')` produces false positives (`<a>javascript:alert(1)</a>` with the href stripped is inert text) and trains people to ignore the noise.
- **The magic-byte allowlist IS the SVG defense.** SVG is a **supported Cloudflare Images input** — the binding will **not** reject it (it sanitizes via svg-hush and passes it through). An SVG can survive the pipeline. Only the sniff stops it, and only as an **allowlist** (SVG has no magic number — it is XML with arbitrary leading whitespace/BOM/comments, which is exactly why signature-*deny*listing it is unreliable).
- **UUIDv7 for `posts` and `media` ONLY; `users`/`profiles` stay v4.** The invariant is **per-table**, not per-database — FKs are plain `uuid` comparisons with no version semantics. Use v7 only where we keyset-paginate. ⚠️ **A v7 id LEAKS ITS ROW'S CREATION TIME** to anyone holding it; fine for posts/media (already public), never for anything where creation time is sensitive.
- **Error envelope:** every **non-2xx** api response body is `{"code": ApiErrorCode, "message"?: string, "fields"?: string[]}` with `content-type: application/json`. Success bodies stay per-route. `code` values are a **wire contract** — the `web` Worker branches on them.
- **Nonces are useless on a cached page.** Every viewer of a cached render receives the *same* nonce, so a nonce-based CSP is security theatre here. Public-page CSP is therefore allowlist-based: **`script-src 'self'` with no `unsafe-inline`** (the directive the CSP exists for), and `style-src 'self' 'unsafe-inline'` because Shiki emits an inline `style` attribute per token span and CSP has no hash/nonce mechanism for style *attributes*. That widening is safe **only** because `defaultSchema` has no `style` in `attributes`, so user content can never carry one — every inline style on the page is app-generated, post-sanitize.
- **Tooling-shape pins, M1 edition — VERIFY BEFORE RELYING.** Workers Cache shipped **2026-07-06** and Astro's CDN cache-provider API is flagged **experimental**. Verify `"cache": { "enabled": true }`, `cacheCloudflare()`, `Astro.cache.set(...)` and `context.cache.invalidate({ tags })` against the **installed** astro 7.0.9 / `@astrojs/cloudflare` 14.1.3 / wrangler 4.110.0 — not against a blog post. Each task that touches them carries an explicit verification step; the **constraints** above (never `s-maxage`, never per-viewer state, batch tags) are what is load-bearing, not the spelling of the call. **⚠️ CORRECTED BY TASK 12'S ACTUAL RUN of that verification against the installed packages:** the Astro cache provider writes the response header as **`Cloudflare-CDN-Cache-Control`, NOT `Cache-Control`** — every check in this plan that reads cache behaviour off `Cache-Control` is reading a header the provider never sets. The task-level fixes below carry this correction; do not reintroduce the old name.
- **Any top-level Astro config key — `cache`, and any future `routeRules` — stays TOP-LEVEL, never nested under `experimental`.** Astro validates `experimental` with a `z.strictObject`: an unrecognized key inside it is a hard config-parse error, not a silently-ignored extra. Task 12's `cache: { provider: cacheCloudflare() }` is already top-level for exactly this reason — keep it that way on any refactor.
- **Purge is scoped to the Worker that OWNS the cache.** `api` **cannot** purge `web`'s cache. The hop is a Service Binding `api → web` + an internal route on `web` guarded by a shared secret. **Batch every tag for an edit into ONE call** — the Free-zone purge limit is **5 requests/minute** (burst 25, 100 ops/request).
- **`Cache-Tag` is a purge handle — Cloudflare CONSUMES and STRIPS it before the response reaches the client.** It is never observable against a real deployed page (curl, browser devtools, Playwright against a deployed Worker). Locally, under `wrangler dev`, there is no real edge in front of the Worker to strip it, so the header passes straight through — useful for pinning what OUR code emits, but it proves nothing about what a real client sees. The only client-visible, deploy-verifiable proof that caching is active is **`Cf-Cache-Status`** (`MISS` then `HIT` on a second request) — see the M1 deploy gate.
- **Workers Cache is NOT simulated by miniflare / `wrangler dev`.** Two GETs against a local dev server are two independent Worker invocations — there is no local `Cf-Cache-Status`, and a local cache HIT is unobservable **by construction**, not by toolchain gap. Any step below claiming to verify a cache hit locally means "the headers our code emits", never a real cached response; the real proof is deploy-gate-only.
- **`Astro.cache.set(...)` ALWAYS needs an explicit `maxAge`/`swr` — never call it with only `{ tags }`.** An untimed `cache.set({ tags })` emits a bare `public` `Cloudflare-CDN-Cache-Control`, which (a) falls back to Cloudflare's ~2h heuristic-freshness caching instead of the TTLs this plan chose deliberately, and (b) is the one directive that overrides the "never cache a request carrying `Authorization`" default (RFC 9111 §3) — i.e. an untimed call can defeat the exact per-viewer cache-poisoning defense Task 13 exists for. `src/lib/cache.ts`'s helpers are the only place a TTL is chosen, for this reason too.
- **`"cache": { "enabled": true }` in `wrangler.jsonc` is NOT a runtime off-switch once the Astro provider is wired.** Verified against the installed adapter by calling its wrangler-config customizer: `enabled: false` **plus** `cache: { provider: cacheCloudflare() }` present in `astro.config.mjs` still emits `{"enabled": true}` — the adapter re-asserts it. **The only real off-switch is not wiring the provider in `astro.config.mjs` at all.** Cloudflare's documented pattern of keeping a staging/preview environment uncached via `env.production` does **not** work here — do not rely on it.
- **`PIPELINE_VERSION` is a `Cache-Tag`, not a cache-key input — the deploy-time invalidation guarantee is TRANSITIVE, not direct.** Cloudflare's cache key is not user-composable for ordinary eyeball traffic (`cf.cacheKey` overrides apply only to same-account/Service-Binding requests), and a `Cache-Tag` is a purge handle, not a key component — `PIPELINE_VERSION` cannot be "put in the cache key." What actually invalidates every cached render atomically on a `PIPELINE_VERSION` bump is that `packages/markdown` is bundled INTO `web`: bumping it changes the bundle, which changes the Worker's VERSION, which **is** in the cache key by default (see Task 12's `wrangler.jsonc` note) — so every entry across every route goes cold on that deploy, with no purge call needed. ⚠️ **`cross_version_cache: true` would silently void this guarantee** (old-version entries would keep serving under the new version's key); it is therefore kept at its default (unset/off) and is a deploy-gate item.

---

## Prerequisites (user-provisioned; local-first ordering)

| When needed | Prerequisite |
|---|---|
| Task 1 (now) | Docker Desktop, already used by M0. Task 1 runs `docker compose down -v` — **this WIPES the local dev + test databases.** There is no in-place PG16→PG18 upgrade for the container's data directory. Local data is disposable (the E2E writes throwaway users); nothing else is lost. |
| Task 8 (Images/R2 local) | Nothing cloud-side. `wrangler dev`/miniflare simulate the `images` and `r2_buckets` bindings locally. Step 1 of Task 8 **verifies that claim** before any code depends on it. |
| Task 12 (Workers Cache) | Nothing cloud-side — Workers Cache is available to every Worker on any plan, on `workers.dev` **and** custom domains (Workers are zoneless), so it is buildable and verifiable **before** DNS cutover. |
| Deploy | **Neon project on Postgres 18** — GA on Neon since 2026-05-01 and the **default for new projects** since 2026-06-05. ⚠️ **Neon has NO in-place major upgrade**: a wrong choice here means creating a new project and migrating data forever after. Take the default. Still a **DIRECT (non-pooled), `sslmode=require`** string for Hyperdrive. |
| Deploy | **R2 bucket `tj-media`** + a **custom domain `cdn.thinkersjournal.com`** on it (which requires a zone). |
| Deploy | **A Cache Rule on the `cdn.thinkersjournal.com` zone** (Cache Everything + long Edge TTL). ⚠️ **NOT optional and NOT merely performance** — "cached" is *exactly* the set the CSAM Scanning Tool covers. Media that bypasses cache is media that isn't scanned. |
| Deploy | **CSAM Scanning Tool** activated on the zone (Caching → Configuration → CSAM Scanning Tool). **Free, all plans. NCMEC credentials are NO LONGER REQUIRED.** Requirements are: activate, verify a notification email, accept the Service-Specific Terms. We still file our own reports — the tool detects, it does not report. |
| Deploy | **`PURGE_SECRET`** — one high-entropy value set as a secret on **BOTH** Workers (`wrangler secret put PURGE_SECRET`). |
| Deploy | **Deploy order for the circular Service Binding** (Task 14). `web` binds `api` by name; `api` now binds `web` by name. On a **first** deploy neither exists, so: deploy `api` **without** its `services` block → deploy `web` → add the `WEB` binding to `apps/api/wrangler.jsonc` → redeploy `api`. On every later deploy both exist and order does not matter. |
| Launch | **`workers_dev = false` on both Workers** + custom `routes`. ⚠️ `*.workers.dev` **shares cache entries** with the custom domain at the same Worker version. This also closes M0's "the api has a public workers.dev URL" finding — ⚠️ but it **removes `pnpm smoke:deploy`'s access**, so run every real-infra validation *before* closing the public URL. |
| Launch | **www → apex redirect.** ⚠️ **HOST IS NOT IN THE CACHE KEY** — apex and `www` share entries. |

## File Structure

```
thinkersjournal-community/
├── docker-compose.yml                          # MODIFIED T1: postgres:16 -> postgres:18
├── README.md                                   # MODIFIED T1, T20 (deploy gate + runbook)
├── HANDOFF.md                                  # MODIFIED T20 (green baseline, M1 status)
├── playwright.config.ts                        # unchanged
├── e2e/
│   ├── helpers.ts                              # NEW T19: signup+verify helper, extracted
│   ├── signup.spec.ts                          # MODIFIED T19 (uses helpers.ts)
│   └── publish.spec.ts                         # NEW T19: publish -> render -> edit -> purge
├── packages/
│   ├── shared/src/
│   │   ├── errors.ts                           # NEW T2: ApiErrorCode + ApiErrorBody
│   │   ├── timing-safe.ts                      # NEW T14: timingSafeEqual (one definition)
│   │   ├── posts.ts                            # NEW T9: post zod schemas + public DTOs
│   │   ├── schemas.ts                          # unchanged
│   │   ├── cookie.ts                           # unchanged
│   │   └── index.ts                            # MODIFIED T2, T9, T14
│   └── markdown/                               # NEW T5
│       ├── src/{index,render,excerpt,highlight,lang-allowlist}.ts
│       ├── test/{dom.ts,xss.test.ts,render.test.ts,highlight.test.ts,excerpt.test.ts}
│       ├── package.json                        # @thinkersjournal/markdown
│       └── tsconfig.json
├── apps/api/
│   ├── migrations/0002_posts_and_media.sql     # NEW T4
│   ├── wrangler.jsonc                          # MODIFIED T8 (images+r2+MEDIA_LIMITER), T14 (WEB)
│   ├── vitest.config.ts                        # MODIFIED T8 (r2 bucket), T14 (PURGE_SECRET)
│   ├── .dev.vars                               # MODIFIED T14 (PURGE_SECRET) — gitignored
│   └── src/
│       ├── index.ts                            # MODIFIED T3: dispatch through ROUTES only
│       ├── routes.ts                           # NEW T3: the ROUTES table
│       ├── routing.ts                          # NEW T3: matchPattern / findRoute
│       ├── http/errors.ts                      # NEW T2: errorResponse / notFoundResponse
│       ├── db/errors.ts                        # NEW T9: isUniqueViolation
│       ├── util/random.ts                      # NEW T9: randomSuffix
│       ├── cache/purge.ts                      # NEW T14: purgeTags (api -> web hop)
│       ├── media/{sniff.ts,images.ts,body.ts}  # NEW T7, T8
│       ├── auth/pipeline.ts                    # MODIFIED T2, T9 (readCurrentSession)
│       ├── auth/csrf.ts                        # MODIFIED T14 (import timingSafeEqual)
│       ├── auth/ratelimit.ts                   # MODIFIED T2
│       └── routes/
│           ├── posts.ts                        # REWRITTEN T9 (the M0 stub becomes real)
│           ├── public.ts                       # NEW T9: anonymous read routes
│           ├── media.ts                        # NEW T8: POST /media
│           ├── resend-verification.ts          # NEW T10
│           ├── signup.ts                       # MODIFIED T2, T9, T11 (guarded upsert)
│           ├── login.ts                        # MODIFIED T2
│           ├── csrf.ts                         # MODIFIED T2, T9
│           └── verify-email.ts                 # MODIFIED T2
└── apps/web/
    ├── astro.config.mjs                        # MODIFIED T12: cache provider
    ├── wrangler.jsonc                          # MODIFIED T12: "cache": { "enabled": true }
    ├── .dev.vars                               # NEW T14: PURGE_SECRET — gitignored
    ├── vitest.config.ts                        # unchanged
    ├── test/
    │   ├── cache.test.ts                       # NEW T13: the guard, unit
    │   ├── page-cache-inventory.test.ts        # NEW T13: every page declares cacheability
    │   └── json-ld.test.ts                     # NEW T15: </script> escaping
    └── src/
        ├── lib/{api.ts,cache.ts,csp.ts,json-ld.ts,canonical.ts}
        └── pages/
            ├── __internal/purge.ts             # NEW T14
            ├── media-upload.ts                 # NEW T17: same-origin upload proxy
            ├── [handle]/index.astro            # NEW T16: /@user
            ├── [handle]/[slug].astro           # NEW T15: /@user/slug
            ├── sitemap.xml.ts                  # NEW T18
            ├── rss.xml.ts                      # NEW T18
            ├── new-post.astro                  # REWRITTEN T17: the editor
            └── {index,login,signup,verify-email}.astro   # MODIFIED T13 (markPrivate)
```

## Testing approach

- **api (bulk):** unchanged from M0 — Vitest 4 + `@cloudflare/vitest-pool-workers` in real workerd with real KV/DO/R2/Images and Hyperdrive overridden to the local test Postgres. `import { env } from 'cloudflare:test'`; `createExecutionContext()`/`waitOnExecutionContext()`. **POOL project** = `test/**/*.test.ts` excluding `test/**/*.db.test.ts`; **NODE project** = `*.db.test.ts` (direct `pg`). Root-scoped `globalSetup` runs `node-pg-migrate` against `thinkersjournal_test`.
- **Schema (`*.db.test.ts`):** anything asserting server version, defaults, constraints or index shape belongs in the **node** project — it needs `information_schema` and a direct connection, not a Hyperdrive binding.
- **`@thinkersjournal/markdown`:** plain Vitest (node). ⚠️ **Assertions parse the output with `rehype-parse` and walk the hast tree** (`test/dom.ts`) — never substring matching. The 16-payload XSS corpus is a table-driven regression suite; it is the highest-value test in M1. Workerd compatibility is proven separately by an `esbuild --platform=browser` bundle check (which **errors on any `node:` import`) and end-to-end by Task 19.
- **`web`:** plain Vitest (node) for pure helpers + two **source-inventory** suites in the idiom of M0's `route-protection.test.ts` — they read the pages' source and assert a structural invariant, so a NEW page is covered the moment it exists rather than when someone remembers.
- **E2E (thin):** Playwright, two `wrangler dev` processes (web primary :8787, api its own primary :8788 — **DEV-ONLY**, it is how the test reads the verification token that stands in for an inbox). Dummy Turnstile keys + `GET /__test/last-verify-token`.
- **What local tests CANNOT prove:** real Hyperdrive caching, true rate-limit thresholds, real edge cache hits/purge propagation, and real Images transforms at scale. Those are deploy-gate items, not test assertions. What the E2E **can** prove locally is the **response contract** — that a public render carries `cloudflare-cdn-cache-control: public, max-age=3600, stale-while-revalidate=86400` (⚠️ **not** `cache-control` — that is the standard header name, but it is not what the Astro Cloudflare cache provider writes; see the amended Global Constraint) + the right `cache-tag`s, and that an **authed** render carries neither. ⚠️ `cache-tag` is a LOCAL-ONLY observation: Cloudflare's real edge consumes and strips it before a deployed client ever sees it, so this contract's client-visible, production proof is `Cf-Cache-Status` (`MISS` then `HIT`) at the deploy gate, not this header.

---

### Task 1: Postgres 18 upgrade

> **Why now, and why this is the cheapest it will ever be.** The spec (line 65) already mandates UUIDv7 PKs; PG16 has no `uuidv7()`, PG18 does (GA Sept 2025, RFC 9562 method 3 — ms timestamp + sub-ms timestamp + random, so intra-ms ordering is free from the server with no counter state). This **executes an approved decision; it is not a new one.** The timing argument is decisive and independent of features: **Neon has NO in-place major upgrade** — moving majors means creating a new project and migrating data. We are at M0, with **two low-volume tables** and **no Neon project created yet**, and PG18 is already Neon's default. The cost of this decision grows monotonically forever from here.
>
> **`pg_uuidv7` is REJECTED** even though it is on Neon's allowlist: local `postgres:16` does not ship it ⇒ a custom Dockerfile compiling an extension ⇒ dev/prod skew **on the thing generating primary keys**. It is also redundant on PG18 and its function name differs (`uuid_generate_v7()` vs native `uuidv7()`), so adopting it buys a second migration later.

**Files:** Modify `docker-compose.yml`, `README.md`. Create `apps/api/test/postgres-version.db.test.ts`.

**Interfaces — Produces:** a local Postgres **18** on `:5432` serving `thinkersjournal` + `thinkersjournal_test`; SQL function `uuidv7()` available to Task 4's migration.

- [ ] **Step 1: Write the failing test.** Create `apps/api/test/postgres-version.db.test.ts` — a **`.db.test.ts`**, so it runs in the NODE project with a direct `pg` connection (a server-version assertion has no business inside workerd):

  ```ts
  import { Client } from "pg";
  import { expect, it } from "vitest";

  /**
   * Pins the SERVER MAJOR VERSION, because two things in this repo silently
   * depend on it and neither fails loudly on PG16:
   *   1. migrations/0002 defaults posts.id/media.id to `uuidv7()`, which does
   *      not exist before 18 (`CREATE TABLE` fails outright — loud);
   *   2. Neon has NO in-place major upgrade, so a local/prod major skew is not
   *      a config drift you fix later, it is a data migration.
   * Asserting the major here means a developer on a stale container learns it
   * from one named failure instead of from a confusing migration error.
   */
  const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

  async function query<T>(sql: string): Promise<T> {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(sql);
      return rows[0] as T;
    } finally {
      await client.end();
    }
  }

  it("runs on Postgres 18 or newer", async () => {
    const { major } = await query<{ major: number }>(
      "SELECT (current_setting('server_version_num')::int / 10000) AS major",
    );
    expect(
      major,
      "the local container is not Postgres 18+. Run `docker compose down -v && docker compose up -d` — note `-v`, the PG16 data directory is NOT readable by PG18 and there is no in-place upgrade.",
    ).toBeGreaterThanOrEqual(18);
  });

  it("provides the native uuidv7() function", async () => {
    // NOT `pg_uuidv7`'s uuid_generate_v7() — the NATIVE builtin. See the task
    // header for why the extension was rejected.
    const { v } = await query<{ v: string }>("SELECT uuidv7()::text AS v");
    // Version nibble: char 15 (1-indexed) of the canonical form is the version.
    expect(v[14]).toBe("7");
  });

  it("still provides gen_random_uuid() for the v4 tables", async () => {
    // users/profiles keep v4 PKs (Global Constraints). Prove 18 did not move it.
    const { v } = await query<{ v: string }>("SELECT gen_random_uuid()::text AS v");
    expect(v[14]).toBe("4");
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test` — the version test fails with `expected 16 to be >= 18` and `uuidv7()` fails with `function uuidv7() does not exist`.
- [ ] **Step 3: Implement.** In `docker-compose.yml` change `image: postgres:16` → `image: postgres:18`, and update the header comment's "Postgres 16" → "Postgres 18". Add this note under the `image:` line:

  ```yaml
      # ⚠️ 18, NOT 16 — and the data directory is NOT compatible across majors.
      # Bumping this tag on an existing volume makes the container refuse to
      # start ("database files are incompatible with server"). You must
      # `docker compose down -v` (wiping the volume) and `up -d` again; local
      # data is disposable. Chosen at M0/M1 because PG18 ships NATIVE uuidv7()
      # (migrations/0002), it is already Neon's default for new projects, and
      # Neon has NO in-place major upgrade — so this is the cheapest this
      # decision will ever be. Do not downgrade.
      image: postgres:18
  ```

- [ ] **Step 4: Recreate the container.** `docker compose down -v && docker compose up -d && docker compose exec -T db pg_isready -U postgres` → `accepting connections`. (`-v` is mandatory: the PG16 data dir is unreadable by PG18.)
- [ ] **Step 5: Run → PASS, and run EVERYTHING.** `pnpm --filter @thinkersjournal/api test` → **all 185 tests / 17 files green, plus the 3 new ones** (188/18). Then `pnpm --filter @thinkersjournal/shared test` (9), `pnpm --filter @thinkersjournal/web test` (38), `pnpm typecheck` (exit 0), `pnpm test:e2e` (2). **This full sweep IS the acceptance criterion** — `citext`, `gen_random_uuid`, `pg` 8.22 and node-pg-migrate are all fine on 18, and this is what proves it rather than asserts it.
- [ ] **Step 6: Update the README.** In `## Local development → Prerequisites`, change `# Postgres 16: ...` → `# Postgres 18: ...` and append:

  ```
  > Upgrading from an M0 checkout? `docker compose down -v` first — **the `-v` is
  > required**. PG18 cannot read PG16's data directory and there is no in-place
  > major upgrade (the same property that makes the Neon major choice permanent).
  ```

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(m1): upgrade local Postgres 16 -> 18 for native uuidv7()"`

### Task 2: Normalize the error envelope on `{code, message?}`

> **M0 carry-over, and it must land BEFORE M1 multiplies the routes.** Four dialects exist today: `{error: "Forbidden"}` (pipeline, signup, login), `{code: "EMAIL_NOT_VERIFIED"}` (pipeline, csrf, verify-email), **plain text** (`"Too many requests"`, `"Not Found"`, `"Invalid or expired verification link"`), and **empty**. `apps/web/src/lib/api.ts` already carries a warning that `data: null` is not an error signal *because* of the last two. M1 roughly triples the route count; every new route would pick a dialect by copying whichever neighbour it was written next to.
>
> **Scope: NON-2XX ONLY.** Success bodies are per-route and stay exactly as they are (`{userId}`, `{csrfToken}`, `"ok"`, `"Email verified"`, the empty 200s from logout). This task normalizes *errors*, which is where a client actually has to branch.

**Files:** Create `packages/shared/src/errors.ts`, `apps/api/src/http/errors.ts`, `apps/api/test/error-envelope.test.ts`. Modify `packages/shared/src/index.ts`, `apps/api/src/index.ts`, `apps/api/src/auth/pipeline.ts`, `apps/api/src/auth/ratelimit.ts`, `apps/api/src/routes/{signup,login,csrf,verify-email,__test}.ts`, `apps/web/src/lib/api.ts`, and the api tests that assert bodies.

**Interfaces — Produces:**
- `type ApiErrorCode` and `interface ApiErrorBody { code: ApiErrorCode; message?: string; fields?: string[] }` from `@thinkersjournal/shared`; `isApiErrorBody(value: unknown): value is ApiErrorBody`.
- `errorResponse(code: ApiErrorCode, status: number, init?: { headers?: Record<string,string>; message?: string; fields?: string[] }): Response` and `notFoundResponse(): Response` from `apps/api/src/http/errors.ts`.
- `apiErrorCode(response: ApiResponse<unknown>): ApiErrorCode | null` from `apps/web/src/lib/api.ts`.

- [ ] **Step 1: Write the failing test.** Create `apps/api/test/error-envelope.test.ts`. It is an **inventory**, not a list — it drives one representative request down each error path the Worker can produce and asserts the envelope on every one:

  ```ts
  import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
  import { describe, expect, it } from "vitest";

  import worker from "../src";

  /**
   * THE ERROR-ENVELOPE INVENTORY.
   *
   * ⚠️ WHY THIS FILE EXISTS. Before M1 the api answered errors in FOUR dialects
   * ({error}, {code}, plain text, empty), and apps/web/src/lib/api.ts had to
   * carry a comment warning that a null body is not an error signal. M1 roughly
   * triples the route count; each new route would inherit whichever dialect its
   * neighbour happened to use. This suite makes "every non-2xx is
   * {code, message?}" checkable rather than remembered.
   *
   * It asserts the SHAPE, not the code strings — the individual route suites
   * already pin those (they are a wire contract the web app branches on).
   */
  const ALLOWED_ORIGIN = "http://localhost:8787";

  async function fetchWorker(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  /** One request per distinct error path the Worker can reach without setup. */
  const CASES: ReadonlyArray<readonly [string, () => Request]> = [
    ["404 unmatched path", () => new Request("https://api.test/nope")],
    [
      "400 malformed JSON",
      () =>
        new Request("https://api.test/auth/signup", {
          method: "POST",
          headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
          body: "{",
        }),
    ],
    [
      "400 zod rejection",
      () =>
        new Request("https://api.test/auth/signup", {
          method: "POST",
          headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: "nope", password: "x", turnstileToken: "t" }),
        }),
    ],
    [
      "403 rejected origin",
      () =>
        new Request("https://api.test/auth/login", {
          method: "POST",
          headers: { Origin: "https://evil.example", "content-type": "application/json" },
          body: JSON.stringify({ email: "a@b.com", password: "x" }),
        }),
    ],
    [
      "401 no session (pipeline step 2)",
      () =>
        new Request("https://api.test/posts", {
          method: "POST",
          headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ title: "t", markdownSource: "b" }),
        }),
    ],
    ["400 verify-email with no token", () => new Request("https://api.test/verify-email")],
    [
      "401 csrf route with no session",
      () => new Request("https://api.test/auth/csrf"),
    ],
  ];

  describe("every non-2xx carries the {code, message?} envelope", () => {
    it.each(CASES)("%s", async (_name, build) => {
      const response = await fetchWorker(build());

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const body: unknown = await response.json();
      expect(
        body,
        "a non-2xx body must be an object carrying a string `code` — see apps/api/src/http/errors.ts. If you are here because you added a route: return errorResponse(...), never a bare string or {error}.",
      ).toEqual(expect.objectContaining({ code: expect.any(String) }));
      // Nothing may smuggle the old dialect back in alongside the new one.
      expect(body).not.toHaveProperty("error");
    });
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test error-envelope` — the 404 and the rate-limit paths fail on `content-type` (they are `text/plain`), and the signup/login cases fail on `not.toHaveProperty("error")`.
- [ ] **Step 3: Define the vocabulary in `shared`.** Create `packages/shared/src/errors.ts`:

  ```ts
  /**
   * THE API ERROR ENVELOPE — a WIRE CONTRACT shared by the `api` Worker (which
   * emits it) and the `web` Worker (which branches on it).
   *
   * ⚠️ EVERY non-2xx api response body is `{ code, message?, fields? }` with
   * `content-type: application/json`. Success bodies are per-route and are NOT
   * covered by this type — `POST /auth/logout` still answers 200 with an empty
   * body and `GET /health` still answers "ok".
   *
   * ⚠️ THE `code` STRINGS ARE THE CONTRACT, NOT THE `message`. `web` keys off
   * `code`; renaming one is a breaking change to both Workers at once. `message`
   * is optional, human-facing, and must NEVER be relied on programmatically —
   * and must never carry a submitted value (one of them is a password).
   *
   * This union is declared in ONE place for the same reason
   * apps/api/src/auth/encoding.ts exists: copies that must agree exactly are
   * copies that drift. Codes introduced by later M1 tasks are listed here from
   * the start so the union has a single home rather than five small edits.
   */
  export type ApiErrorCode =
    // --- request shape -------------------------------------------------------
    | "INVALID_JSON"           // 400 — the body was not JSON at all
    | "INVALID_INPUT"          // 400 — zod rejected it; `fields` names the paths
    | "INVALID_TOKEN"          // 400 — a verification token is unknown/expired/used
    // --- authentication ------------------------------------------------------
    | "UNAUTHORIZED"           // 401 — no usable session (pipeline)
    | "LOGIN_REQUIRED"         // 401 — this route needs a session to proceed
    | "INVALID_CREDENTIALS"    // 401 — login only; deliberately not enumerable
    // --- authorization -------------------------------------------------------
    | "FORBIDDEN"              // 403 — origin/CSRF/Turnstile rejection
    | "EMAIL_NOT_VERIFIED"     // 403 — the soft gate
    | "ALREADY_VERIFIED"       // 409 — resend-verification on a verified account (T10)
    | "QUOTA_EXCEEDED"         // 403 — per-user media quota (T8)
    // --- resources -----------------------------------------------------------
    | "NOT_FOUND"              // 404 — no such route, or no such visible resource
    | "EMAIL_TAKEN"            // 409 — a VERIFIED duplicate at signup
    | "SLUG_TAKEN"             // 409 — could not place a unique slug (T9)
    // --- payloads ------------------------------------------------------------
    | "PAYLOAD_TOO_LARGE"      // 413 — over the streaming size cap (T8)
    | "UNSUPPORTED_MEDIA_TYPE" // 415 — failed the magic-byte allowlist (T7/T8)
    // --- limits --------------------------------------------------------------
    | "RATE_LIMITED";          // 429

  export interface ApiErrorBody {
    code: ApiErrorCode;
    /** Human-facing only. Never branch on it; never put a submitted value in it. */
    message?: string;
    /** For INVALID_INPUT: the offending FIELD NAMES only — never their values. */
    fields?: string[];
  }

  /** Narrow an unknown parsed body to the envelope. Structural, not exhaustive. */
  export function isApiErrorBody(value: unknown): value is ApiErrorBody {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { code?: unknown }).code === "string"
    );
  }
  ```

  Re-export from `packages/shared/src/index.ts`: `export * from "./errors";`

- [ ] **Step 4: Add the api's single constructor.** Create `apps/api/src/http/errors.ts`:

  ```ts
  /**
   * The ONE way this Worker builds a non-2xx response. See the envelope contract
   * in packages/shared/src/errors.ts.
   *
   * ⚠️ Every error path goes through here. apps/api/test/error-envelope.test.ts
   * is the backstop: it drives each reachable error path and asserts the shape,
   * so a route that hand-rolls `new Response("nope", { status: 400 })` fails
   * there rather than shipping a fifth dialect.
   */
  import type { ApiErrorCode } from "@thinkersjournal/shared";

  export interface ErrorResponseInit {
    /**
     * ⚠️ `Record<string, string>`, DELIBERATELY NARROWER THAN `HeadersInit` —
     * the same reasoning as src/auth/pipeline.ts's `unauthorized`: this object is
     * SPREAD, and spreading a `Headers` INSTANCE yields `{}` while spreading a
     * `string[][]` yields index keys. Both type-check as `HeadersInit` and both
     * would SILENTLY DROP the revocation path's `Set-Cookie`.
     */
    headers?: Record<string, string>;
    message?: string;
    fields?: string[];
  }

  export function errorResponse(
    code: ApiErrorCode,
    status: number,
    init: ErrorResponseInit = {},
  ): Response {
    const body: Record<string, unknown> = { code };
    if (init.message !== undefined) body.message = init.message;
    if (init.fields !== undefined) body.fields = init.fields;

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }

  /**
   * The one 404 every unmatched path gets — and the one the gated `__test`
   * routes fall through to when `TEST_ROUTES` is unset. ⚠️ Those two MUST stay
   * byte-identical: a distinguishable 404 confirms the test route exists, which
   * is exactly what its gate is for (src/routes/__test.ts).
   */
  export function notFoundResponse(): Response {
    return errorResponse("NOT_FOUND", 404);
  }
  ```

- [ ] **Step 5: Convert every call site.** Find them with `rg -n 'new Response\(' apps/api/src` and apply, exactly:
  - `src/index.ts` — `notFound()` → delete it; import and use `notFoundResponse()`.
  - `src/auth/pipeline.ts` — `forbidden()` → `errorResponse("FORBIDDEN", 403)`; `unauthorized(extraHeaders)` → `errorResponse("UNAUTHORIZED", 401, { headers: extraHeaders })`; `emailNotVerifiedResponse()` → `errorResponse("EMAIL_NOT_VERIFIED", 403)`. **Keep all three local wrappers** — their doc-comments carry the load-bearing "byte-identical across no-session and revoked-session" reasoning, and their bodies are now one line each.
  - `src/auth/ratelimit.ts` — `new Response("Too many requests", { status: 429 })` → `errorResponse("RATE_LIMITED", 429)`.
  - `src/routes/signup.ts` — delete the local `json()`; `{error:"Invalid JSON body"}` → `errorResponse("INVALID_JSON", 400)`; `{error:"Invalid signup input", fields}` → `errorResponse("INVALID_INPUT", 400, { fields })`; `forbidden()` → `errorResponse("FORBIDDEN", 403)` (**keep the wrapper and its comment** — one shared response is what keeps Turnstile and origin from being probed apart); `{error:"Email already registered"}` → `errorResponse("EMAIL_TAKEN", 409)`. The 201 keeps `new Response(JSON.stringify({ userId }), { status: 201, headers: { "content-type": "application/json", "Set-Cookie": cookie } })`.
  - `src/routes/login.ts` — same for `INVALID_JSON` / `INVALID_INPUT` / `FORBIDDEN`; `unauthorized()` → `errorResponse("INVALID_CREDENTIALS", 401)` — **keep the wrapper and its NO USER ENUMERATION comment**, it is why both failure paths share one response.
  - `src/routes/csrf.ts` — `loginRequired(extraHeaders)` → `errorResponse("LOGIN_REQUIRED", 401, { headers: extraHeaders })`.
  - `src/routes/verify-email.ts` — `invalidToken()` → `errorResponse("INVALID_TOKEN", 400)`; `loginRequired(status)` → `errorResponse("LOGIN_REQUIRED", status)`. The 200 stays `new Response("Email verified", { status: 200 })`.
  - `src/routes/__test.ts` — `new Response("No verification token has been issued", { status: 404 })` → `errorResponse("NOT_FOUND", 404)`. (Reachable only with `TEST_ROUTES=1`; normalized for consistency.) The `null` return and the 200 token body are unchanged.

- [ ] **Step 6: Adapt — never weaken — the existing tests.** `rg -n '"error"|Too many requests|Invalid or expired|Not Found|Invalid email or password|Email already registered' apps/api/test` lists every affected assertion. Rewrite each to assert the **code**, keeping the status and every other property the test already pins:
  - `expect(body.error).toBe("Forbidden")` → `expect(body.code).toBe("FORBIDDEN")`
  - `expect(await res.text()).toBe("Too many requests")` → `expect(((await res.json()) as ApiErrorBody).code).toBe("RATE_LIMITED")`
  - `{error:"Invalid email or password"}` → `{code:"INVALID_CREDENTIALS"}` — and **keep** login's byte-identical-body assertion across the no-row and wrong-password paths; it is the enumeration defense, and it must now compare the two JSON bodies as strings.
  - **Do not delete an assertion because it is now awkward.** Every one of these encodes a security property (indistinguishability, no value echoing, no enumeration).

- [ ] **Step 7: Teach `web` the envelope.** In `apps/web/src/lib/api.ts` add, next to `parseJson`:

  ```ts
  import { isApiErrorBody, type ApiErrorCode } from "@thinkersjournal/shared";

  /**
   * The api's error `code` for a non-2xx response, or null for a 2xx / a body
   * that is not the envelope.
   *
   * ⚠️ Branch on THIS, never on `message` and never on the status alone: 403 is
   * both "cross-site origin" (FORBIDDEN) and "verify your email first"
   * (EMAIL_NOT_VERIFIED), and the pages must tell them apart. See the envelope
   * contract in packages/shared/src/errors.ts.
   */
  export function apiErrorCode(response: ApiResponse<unknown>): ApiErrorCode | null {
    if (response.status < 400) return null;
    return isApiErrorBody(response.data) ? response.data.code : null;
  }
  ```

  Add `"@thinkersjournal/shared": "workspace:*"` to `apps/web/package.json` `dependencies` if absent, then `pnpm install`. Update the `ApiResponse.data` doc-comment: the "`null` is NOT an error signal" warning **stays true** (logout still answers an empty 200) — append `A non-2xx, however, is now ALWAYS the {code, message?} envelope; read it with apiErrorCode().`
  In `apps/web/src/pages/new-post.astro`, replace `response.data?.code === "EMAIL_NOT_VERIFIED"` with `apiErrorCode(response) === "EMAIL_NOT_VERIFIED"` (same behaviour, now type-checked against the union).

- [ ] **Step 8: Run → PASS.** `pnpm --filter @thinkersjournal/api test` (188 + the 7 envelope cases = **195/19**), `pnpm --filter @thinkersjournal/shared test`, `pnpm --filter @thinkersjournal/web test`, `pnpm typecheck` → exit 0, `pnpm test:e2e` → 2 passed.
- [ ] **Step 9: Commit.** `git add -A && git commit -m "refactor(m1): normalize every api error on the {code, message?} envelope"`

### Task 3: Dispatch through a ROUTES table + a structural route inventory

> **Why this is its own task, and why it comes before any new route.** M0's router is an if-chain of `pathname === "/literal"`, and `apps/api/test/route-protection.test.ts` — the compensating control for "the router does not apply the pipeline, each handler does" — **reads that literal shape with a regex** to enumerate routes. M1 adds dynamic paths (`PATCH /posts/:id`). A regex over source text **cannot see them**, and the file's own tripwire will not fire: it only checks that the *static* sanity routes are still discoverable, which they would be. The result is a **new mutating route that is silently exempt from the default-deny inventory** — precisely the failure that file exists to prevent, arriving through its blind spot.
>
> That file says: *"if the router is ever rewritten in a shape this pattern cannot read … FIX THE PATTERN, do not delete this test."* Teaching it a second, more fragile regex is the wrong fix. Exporting a **route table** and having the test **import** it is the right one: the inventory stops being textual and becomes structural, and it cannot be fooled by formatting, dynamic segments, or a future rewrite.

**Files:** Create `apps/api/src/routing.ts`, `apps/api/src/routes.ts`, `apps/api/test/routing.test.ts`. Modify `apps/api/src/index.ts`, `apps/api/test/route-protection.test.ts`.

**Interfaces — Produces:**
- `type RouteParams = Readonly<Record<string, string>>`
- `type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext, params: RouteParams) => Promise<Response>`
- `interface RouteDef { readonly method: string; readonly pattern: string; readonly handler: RouteHandler }`
- `matchPattern(pattern: string, pathname: string): RouteParams | null`
- `findRoute(routes: readonly RouteDef[], method: string, pathname: string): { route: RouteDef; params: RouteParams } | null`
- `ROUTES: readonly RouteDef[]` from `apps/api/src/routes.ts` — **the single place every task below registers a route.**

- [ ] **Step 1: Write the failing test.** Create `apps/api/test/routing.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";

  import { findRoute, matchPattern, type RouteDef } from "../src/routing";

  describe("matchPattern", () => {
    it("matches an exact literal path and yields no params", () => {
      expect(matchPattern("/health", "/health")).toEqual({});
    });

    it("rejects a different literal", () => {
      expect(matchPattern("/health", "/healthz")).toBeNull();
    });

    it("rejects a path with a different segment count", () => {
      expect(matchPattern("/posts", "/posts/abc")).toBeNull();
      expect(matchPattern("/posts/:id", "/posts")).toBeNull();
    });

    it("captures a named segment", () => {
      expect(matchPattern("/posts/:id", "/posts/abc-123")).toEqual({ id: "abc-123" });
    });

    it("percent-decodes a captured segment", () => {
      expect(matchPattern("/u/:name", "/u/a%20b")).toEqual({ name: "a b" });
    });

    it("rejects an EMPTY captured segment", () => {
      // `/posts//` must not resolve to `{ id: "" }` — an empty id would reach a
      // handler as a real value and produce a nonsense query.
      expect(matchPattern("/posts/:id", "/posts/")).toBeNull();
    });

    it("rejects an undecodable segment rather than throwing", () => {
      // decodeURIComponent throws on a lone '%'; a malformed URL is a 404, not a 500.
      expect(matchPattern("/posts/:id", "/posts/%")).toBeNull();
    });

    it("does not let a param swallow a slash", () => {
      expect(matchPattern("/posts/:id", "/posts/a/b")).toBeNull();
    });
  });

  describe("findRoute", () => {
    const handler = async (): Promise<Response> => new Response("x");
    const routes: readonly RouteDef[] = [
      { method: "GET", pattern: "/posts", handler },
      { method: "POST", pattern: "/posts", handler },
      { method: "GET", pattern: "/posts/:id", handler },
    ];

    it("matches on method AND path", () => {
      expect(findRoute(routes, "POST", "/posts")?.route.pattern).toBe("/posts");
      expect(findRoute(routes, "GET", "/posts/1")?.params).toEqual({ id: "1" });
    });

    it("returns null for a known path with an unregistered method", () => {
      expect(findRoute(routes, "DELETE", "/posts")).toBeNull();
    });

    it("returns null for an unknown path", () => {
      expect(findRoute(routes, "GET", "/nope")).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test routing` — `Cannot find module '../src/routing'`.
- [ ] **Step 3: Implement `routing.ts`.**

  ```ts
  /**
   * The api Worker's dispatch primitives. Deliberately ~40 lines and dependency-
   * free: a router is not where this project spends its complexity budget.
   *
   * ⚠️ WHY A TABLE AND NOT AN IF-CHAIN. M0's router was a chain of
   * `pathname === "/literal"` checks, and test/route-protection.test.ts — the
   * compensating control for "the router dispatches, each HANDLER runs the
   * pipeline" — enumerated routes by REGEXING that source text. M1 introduces
   * dynamic paths (`PATCH /posts/:id`), which such a regex cannot see, and the
   * file's tripwire would NOT fire (it only requires the static sanity routes to
   * still be found). A new mutating route would have gone silently un-inventoried
   * — the exact failure that file exists to catch, arriving through its blind
   * spot. Exporting a table the test IMPORTS makes the inventory structural: it
   * cannot be defeated by formatting, by a dynamic segment, or by a rewrite.
   *
   * ⚠️ THIS CHANGES THE ROUTER'S SHAPE, NOT ITS RULE. The table still only
   * DISPATCHES. Each handler calls `runMutatingPipeline` itself, because that is
   * what lets a route own its own opt-ins (`requireVerifiedEmail` for
   * POST /posts, deliberately not for logout) — a blanket wrap could not express
   * that. See src/auth/pipeline.ts and the M0 plan's deviation H3.
   */
  export type RouteParams = Readonly<Record<string, string>>;

  export type RouteHandler = (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    params: RouteParams,
  ) => Promise<Response>;

  export interface RouteDef {
    readonly method: string;
    /** A path pattern. `:name` segments capture one path segment each. */
    readonly pattern: string;
    readonly handler: RouteHandler;
  }

  /**
   * Match `pathname` against `pattern`, returning the captured params (`{}` when
   * there are none) or `null` for no match.
   *
   * Segment-count-exact and slash-exact: a `:param` NEVER spans a `/`. An empty
   * capture is a non-match rather than `""` — an empty id reaching a handler as a
   * real value produces a nonsense query rather than a 404. An undecodable
   * segment is likewise a non-match, never a throw: a malformed URL is a 404, not
   * a 500.
   */
  export function matchPattern(pattern: string, pathname: string): RouteParams | null {
    const expected = pattern.split("/");
    const actual = pathname.split("/");
    if (expected.length !== actual.length) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < expected.length; i++) {
      const segment = expected[i]!;
      const value = actual[i]!;

      if (!segment.startsWith(":")) {
        if (segment !== value) return null;
        continue;
      }

      if (value === "") return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        return null;
      }
      if (decoded === "") return null;
      params[segment.slice(1)] = decoded;
    }
    return params;
  }

  /** The first route matching `method` + `pathname`, with its params, or null. */
  export function findRoute(
    routes: readonly RouteDef[],
    method: string,
    pathname: string,
  ): { route: RouteDef; params: RouteParams } | null {
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPattern(route.pattern, pathname);
      if (params !== null) return { route, params };
    }
    return null;
  }
  ```

- [ ] **Step 4: Implement `routes.ts` — move M0's routes over verbatim, comments and all.**

  ```ts
  /**
   * THE ROUTE TABLE — the single inventory of everything this Worker answers.
   *
   * ⚠️ EVERY ROUTE GOES HERE, and test/route-protection.test.ts IMPORTS this
   * array. A new mutating route is therefore held to default-deny (no Origin ->
   * 403, no session -> 401) from the moment it is added, whether or not anyone
   * thought about that file. If it runs `runMutatingPipeline`, it passes. If it
   * does not, it fails there — and the only way to make it pass without the
   * pipeline is to add it to PIPELINE_EXEMPT, which is a reviewable security
   * decision with a documented justification, not an omission.
   */
  import { handleTestRoute } from "./routes/__test";
  import { handleCsrf } from "./routes/csrf";
  import { handleLogin } from "./routes/login";
  import { handleLogout, handleLogoutAll } from "./routes/logout";
  import { handleCreatePost, handleListPosts } from "./routes/posts";
  import { handleSignup } from "./routes/signup";
  import { handleVerifyEmail } from "./routes/verify-email";
  import { notFoundResponse } from "./http/errors";

  import type { RouteDef } from "./routing";

  export const ROUTES: readonly RouteDef[] = [
    { method: "GET", pattern: "/health", handler: async () => new Response("ok", { status: 200 }) },

    // ⚠️ Signup and login do NOT run the mutating pipeline (src/auth/pipeline.ts)
    // — they are how a session comes to exist, so its "401 if no session" step
    // would reject every one of them. Each performs its own `checkOrigin` + rate
    // limiting inline. See the pipeline's header and PIPELINE_EXEMPT in
    // test/route-protection.test.ts.
    { method: "POST", pattern: "/auth/signup", handler: handleSignup },
    { method: "POST", pattern: "/auth/login", handler: handleLogin },

    // Unlike signup/login these DO run the pipeline — they have a session — but
    // WITHOUT `requireVerifiedEmail`: an unverified user must still be able to
    // end their own session. See src/routes/logout.ts.
    { method: "POST", pattern: "/auth/logout", handler: handleLogout },
    { method: "POST", pattern: "/auth/logout-all", handler: handleLogoutAll },

    // Delivers the CSRF token for the caller's session to the `web` Worker. NOT
    // the pipeline (and it must not be): the pipeline's CSRF step would require
    // the very token this route issues. See src/routes/csrf.ts.
    { method: "GET", pattern: "/auth/csrf", handler: handleCsrf },

    // Likewise NOT the pipeline: a GET carries no session/CSRF/epoch requirement.
    // This route authenticates INLINE (session + token ownership + epoch) for its
    // own reasons — see its header; do not weaken it.
    { method: "GET", pattern: "/verify-email", handler: handleVerifyEmail },

    // Content routes. `POST /posts` runs the full mutating pipeline, applied
    // inside the handler so the route owns its own opt-ins. GET is deliberately
    // NOT gated: reads stay open.
    { method: "GET", pattern: "/posts", handler: handleListPosts },
    { method: "POST", pattern: "/posts", handler: handleCreatePost },

    // TEST-ONLY. `handleTestRoute` returns null when `TEST_ROUTES` is unset (i.e.
    // in production), and we fall through to the SAME notFoundResponse() every
    // unmatched path gets — so the route is indistinguishable from one that does
    // not exist. Do not turn this into a 403. See src/routes/__test.ts.
    {
      method: "GET",
      pattern: "/__test/last-verify-token",
      handler: async (request, env) => (await handleTestRoute(request, env)) ?? notFoundResponse(),
    },
  ];
  ```

- [ ] **Step 5: Reduce `index.ts` to dispatch + the DO export.**

  ```ts
  import { notFoundResponse } from "./http/errors";
  import { ROUTES } from "./routes";
  import { findRoute } from "./routing";

  export { UserSecurityDO } from "./durable-objects/UserSecurityDO";

  /**
   * ⚠️ THIS FILE ONLY DISPATCHES. Do not add an `if` here: every route belongs in
   * src/routes.ts, which test/route-protection.test.ts imports as its inventory —
   * a route dispatched from here would be invisible to it. That test asserts this
   * file's shape for exactly that reason.
   */
  export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      const match = findRoute(ROUTES, request.method, pathname);
      if (match === null) return notFoundResponse();
      return await match.route.handler(request, env, ctx, match.params);
    },
  } satisfies ExportedHandler<Env>;
  ```

- [ ] **Step 6: Rewrite the inventory's discovery — keep every assertion.** In `apps/api/test/route-protection.test.ts`, replace `ROUTE_PATTERN` / `discoverRoutes()` / `SANITY_ROUTES` and the `route inventory` describe block with:

  ```ts
  import indexSource from "../src/index.ts?raw";
  import { ROUTES } from "../src/routes";
  import type { RouteDef } from "../src/routing";

  /** `"POST /posts"` — the key used by PIPELINE_EXEMPT and the test names. */
  function label(route: RouteDef): string {
    return `${route.method} ${route.pattern}`;
  }

  const MUTATING = ROUTES.filter((r) => r.method !== "GET" && r.method !== "HEAD");

  /**
   * Concrete sample values for `:param` segments, so a pattern can be probed as a
   * real URL. The values need only be well-formed — every assertion below rejects
   * the request long before a handler could look one up.
   */
  const PARAM_SAMPLES: Readonly<Record<string, string>> = {
    id: "00000000-0000-7000-8000-000000000000",
  };

  function concretePath(pattern: string): string {
    return pattern
      .split("/")
      .map((s) => (s.startsWith(":") ? (PARAM_SAMPLES[s.slice(1)] ?? "sample") : s))
      .join("/");
  }

  describe("route inventory", () => {
    it("the router dispatches ONLY through the ROUTES table", () => {
      // ⚠️ THE TRIPWIRE. Every assertion below iterates over ROUTES, so a route
      // dispatched by a hand-rolled `if` in index.ts would be invisible here and
      // this suite would pass vacuously about it. This is the one thing that
      // cannot be checked structurally, so it is checked textually.
      expect(
        indexSource,
        "src/index.ts no longer dispatches via findRoute(ROUTES, ...) — every assertion in this file enumerates ROUTES, so a route reachable any other way is NOT covered by the default-deny checks below.",
      ).toContain("findRoute(ROUTES,");
      expect(
        indexSource,
        "src/index.ts matches a path directly. Move that route into src/routes.ts — see this file's header.",
      ).not.toMatch(/pathname === /);
    });

    it("found at least one mutating route to check", () => {
      expect(MUTATING.length).toBeGreaterThan(0);
    });

    it("every exemption in PIPELINE_EXEMPT still corresponds to a real route", () => {
      const discovered = new Set(MUTATING.map(label));
      for (const exempt of PIPELINE_EXEMPT) {
        expect(
          discovered,
          `PIPELINE_EXEMPT lists "${exempt}", which the router no longer has. Remove the exemption.`,
        ).toContain(exempt);
      }
    });
  });
  ```

  Then change `probe()` to build from the pattern, leaving every downstream assertion untouched:

  ```ts
  function probe(route: RouteDef, headers: Record<string, string>): Request {
    return new Request(`https://api.test${concretePath(route.pattern)}`, {
      method: route.method,
      headers: { "content-type": "application/json", ...headers },
      body: probeBody(),
    });
  }
  ```

  and replace every `MUTATING.filter(...)`/`it.each(... r => [label(r), r])` usage's element type from the old local `Route` to `RouteDef`. **The three default-deny describes and every failure message stay exactly as they are** — they are the whole point of the file.

- [ ] **Step 7: Run → PASS.** `pnpm --filter @thinkersjournal/api test` → 195 + 12 routing = **207/20**, all green. `pnpm typecheck` → exit 0.
- [ ] **Step 8: Commit.** `git add -A && git commit -m "refactor(m1): dispatch via a ROUTES table; make the route inventory structural"`

### Task 4: Migration 0002 — `posts` + `media`

> **UUIDv7 on `posts` and `media` ONLY.** `users`/`profiles` **stay v4 — do not migrate them.** The invariant is **per-table**: FKs are plain `uuid` comparisons with no version semantics, so mixed v4/v7 *across* tables is a non-issue, while mixed *within* `users` would be strictly worse than clean v4. `users`/`profiles` are PK-lookup and low-volume — v7's locality buys nothing there, and rewriting their PKs means rewriting every FK reference: high risk, zero benefit. Use v7 **only where we keyset-paginate**.
>
> ⚠️ **A v7 id LEAKS ITS ROW'S CREATION TIME** to anyone holding it. That is fine here — posts and media are public artifacts whose publication time we display anyway — and it is exactly why this must never be reflexively applied to a table where creation time is sensitive.

**Files:** Create `apps/api/migrations/0002_posts_and_media.sql`, `apps/api/test/posts-media-schema.db.test.ts`.

**Interfaces — Produces:** tables `posts` and `media` as below; the keyset index `posts (author_id, id DESC) WHERE status = 'published'`; the per-author unique slug index.

- [ ] **Step 1: Write the failing test.** Create `apps/api/test/posts-media-schema.db.test.ts` (a `.db.test.ts` → NODE project, direct `pg`):

  ```ts
  import { Client } from "pg";
  import { afterAll, beforeAll, describe, expect, it } from "vitest";

  /**
   * Schema-level guarantees for migrations/0002 that no route test can express:
   * the PK VERSION per table, per-author slug uniqueness, the status CHECKs, and
   * the FK cascades. Runs in the NODE project — it needs a direct connection and
   * information_schema, not a Hyperdrive binding.
   */
  const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

  let client: Client;
  let userA: string;
  let userB: string;

  /** Canonical UUID: char 15 (1-indexed) is the version nibble. */
  const versionOf = (uuid: string): string => uuid[14]!;

  async function makeUser(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
      [`schema-${crypto.randomUUID()}@example.com`],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    userA = await makeUser();
    userB = await makeUser();
  });

  afterAll(async () => {
    await client.query("DELETE FROM users WHERE id = ANY($1)", [[userA, userB]]);
    await client.end();
  });

  describe("primary key versions (the invariant is PER TABLE)", () => {
    it("posts.id defaults to a UUIDv7", async () => {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1, 't', $2, 'b') RETURNING id::text AS id",
        [userA, `v7-${crypto.randomUUID()}`],
      );
      expect(versionOf(rows[0]!.id)).toBe("7");
    });

    it("media.id defaults to a UUIDv7", async () => {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,'k','h',1,1,1) RETURNING id::text AS id",
        [userA],
      );
      expect(versionOf(rows[0]!.id)).toBe("7");
    });

    it("users.id is STILL a UUIDv4 — do not migrate it", async () => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM users WHERE id = $1",
        [userA],
      );
      expect(
        versionOf(rows[0]!.id),
        "users.id changed version. The v7 invariant is PER TABLE: users/profiles stay v4 (PK-lookup, low-volume, and rewriting their PKs means rewriting every FK). See the Global Constraints.",
      ).toBe("4");
    });
  });

  describe("posts.id is time-ordered (this is what keyset pagination rests on)", () => {
    it("ORDER BY id DESC is newest-first, even within one millisecond", async () => {
      const inserted: string[] = [];
      for (let i = 0; i < 25; i++) {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b') RETURNING id::text AS id",
          [userB, `ord-${i}-${crypto.randomUUID()}`],
        );
        inserted.push(rows[0]!.id);
      }
      const { rows } = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM posts WHERE author_id = $1 ORDER BY id DESC",
        [userB],
      );
      expect(rows.map((r) => r.id)).toEqual([...inserted].reverse());
    });
  });

  describe("posts constraints", () => {
    it("rejects a duplicate slug for the SAME author", async () => {
      const slug = `dup-${crypto.randomUUID()}`;
      await client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [userA, slug],
      );
      await expect(
        client.query(
          "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
          [userA, slug],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("ALLOWS the same slug for a DIFFERENT author", async () => {
      const slug = `shared-${crypto.randomUUID()}`;
      await client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [userA, slug],
      );
      await expect(
        client.query(
          "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
          [userB, slug],
        ),
      ).resolves.toBeDefined();
    });

    it("matches slugs case-insensitively (citext)", async () => {
      const slug = `Case-${crypto.randomUUID()}`;
      await client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [userA, slug],
      );
      await expect(
        client.query(
          "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
          [userA, slug.toUpperCase()],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("rejects an unknown status", async () => {
      await expect(
        client.query(
          "INSERT INTO posts (author_id, title, slug, markdown_source, status) VALUES ($1,'t',$2,'b','deleted')",
          [userA, `st-${crypto.randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects status='published' with a NULL published_at", async () => {
      await expect(
        client.query(
          "INSERT INTO posts (author_id, title, slug, markdown_source, status) VALUES ($1,'t',$2,'b','published')",
          [userA, `pub-${crypto.randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("cascades on author deletion", async () => {
      const doomed = await makeUser();
      await client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [doomed, `cascade-${crypto.randomUUID()}`],
      );
      await client.query("DELETE FROM users WHERE id = $1", [doomed]);
      const { rows } = await client.query("SELECT 1 FROM posts WHERE author_id = $1", [doomed]);
      expect(rows).toHaveLength(0);
    });
  });

  describe("media", () => {
    it("allows TWO rows to share one r2_key (content addressing dedupes across users)", async () => {
      const hash = "a".repeat(64);
      const key = `media/post/${hash}.webp`;
      for (const owner of [userA, userB]) {
        await client.query(
          "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,$2,$3,10,1,1)",
          [owner, key, hash],
        );
      }
      const { rows } = await client.query("SELECT 1 FROM media WHERE r2_key = $1", [key]);
      expect(
        rows,
        "r2_key must NOT be unique: two users uploading the same image share ONE R2 object with TWO rows. Ownership lives here, not in the key.",
      ).toHaveLength(2);
    });
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test posts-media-schema` → `relation "posts" does not exist`.
- [ ] **Step 3: Implement the migration.** Create `apps/api/migrations/0002_posts_and_media.sql`:

  ```sql
  -- Up Migration
  --
  -- ⚠️ REQUIRES POSTGRES 18 — `uuidv7()` is a native builtin added in 18 and does
  -- not exist before it. See docker-compose.yml and test/postgres-version.db.test.ts.
  --
  -- ⚠️ UUIDv7 HERE, v4 IN users/profiles — DELIBERATE, AND PER TABLE. FKs are
  -- plain uuid comparisons with no version semantics, so mixing across tables is
  -- a non-issue. v7 is used ONLY where we keyset-paginate (posts, media; comments
  -- in M2). users/profiles are PK-lookup and low-volume: v7 locality buys nothing
  -- there, and rewriting their PKs would mean rewriting every FK reference.
  --
  -- ⚠️ A v7 id LEAKS ITS ROW'S CREATION TIME to anyone holding it. Accepted here
  -- (posts and media are public artifacts and we display their dates anyway).
  -- NEVER put a v7 PK on a table where creation time is sensitive.

  CREATE TABLE posts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    -- citext: slugs are matched from a URL, which is case-carrying. Case-folding
    -- here is what stops `/@me/Post` and `/@me/post` being two rows (two cache
    -- entries, two canonical URLs, one duplicate-content penalty).
    slug citext NOT NULL,
    -- THE SINGLE SOURCE OF TRUTH. Clean Markdown, rendered at READ time (see
    -- packages/markdown). No rendered HTML is ever stored: that is what makes a
    -- sanitizer fix a DEPLOY rather than a backfill of every row, and it is what
    -- M3's live ref-cards require. `{{ref:TOKEN}}` placeholders land here in M3.
    markdown_source text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    published_at timestamptz NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT posts_status_check CHECK (status IN ('draft', 'published')),
    -- A published post ALWAYS has a publication time. Enforced here rather than
    -- in the handler because the transaction-mode pooler means the database is
    -- the only place an invariant cannot be raced around.
    CONSTRAINT posts_published_has_timestamp
      CHECK (status <> 'published' OR published_at IS NOT NULL)
  );

  -- The public URL `/@username/slug` must resolve to exactly one row.
  CREATE UNIQUE INDEX posts_author_slug_key ON posts (author_id, slug);

  -- KEYSET PAGINATION. v7 ids are time-ordered, so `ORDER BY id DESC` IS
  -- newest-first and NO created_at index is needed — that is the whole payoff.
  --   SELECT ... WHERE author_id = $1 AND status = 'published' AND id < $2
  --   ORDER BY id DESC LIMIT 20;   -- $2 = last-seen id; page 1 uses the all-f UUID
  -- Partial: drafts are never in a public listing, so they do not belong in the
  -- index that serves one.
  CREATE INDEX posts_author_published_key ON posts (author_id, id DESC)
    WHERE status = 'published';

  -- Site-wide newest-first, for sitemap.xml + rss.xml.
  CREATE INDEX posts_published_key ON posts (id DESC) WHERE status = 'published';

  CREATE TABLE media (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The R2 object key, CONTENT-ADDRESSED on the TRANSFORMED output:
    -- `media/<variant>/<sha256>.webp`. Deliberately NOT unique, and deliberately
    -- WITHOUT the user id in it.
    --
    -- ⚠️ DEDUPE/DELETION HAZARD — DESIGNED FOR, NOT DISCOVERED LATER. Two users
    -- uploading the same image share ONE R2 object with TWO rows. Deleting A's
    -- row MUST NOT delete the object while B still references it. M1 therefore
    -- NEVER deletes an R2 object inline; reclamation is an offline GC that drops
    -- objects with no remaining `media` row (M4, alongside moderation deletion).
    r2_key text NOT NULL,
    -- Hex SHA-256 of the TRANSFORMED (WebP) bytes — the same value embedded in
    -- r2_key. Stored separately so an upload of an already-known image can be
    -- answered without an R2 round-trip.
    sha256 text NOT NULL,
    -- Of the stored WebP, not the discarded original. This column is the quota.
    bytes bigint NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Serves both the per-user quota sum and a future "my uploads" keyset listing.
  CREATE INDEX media_owner_key ON media (owner_id, id DESC);
  CREATE INDEX media_sha256_key ON media (sha256);

  -- Down Migration
  -- media first is not required (no FK between them), but keep the mirror order.
  DROP TABLE IF EXISTS media;
  DROP TABLE IF EXISTS posts;
  ```

- [ ] **Step 4: Apply + run → PASS.** `pnpm --filter @thinkersjournal/api migrate:test` then `pnpm --filter @thinkersjournal/api test` → **207 + 11 = 218/21**, all green. (The root `globalSetup` applies migrations automatically on a normal run; the explicit `migrate:test` is only to see the SQL succeed on its own first.)
- [ ] **Step 5: Prove `down` still works.** `pnpm --filter @thinkersjournal/api exec node scripts/migrate.mjs test down` → drops `media` + `posts`; then `... test up` → recreates them. (`node-pg-migrate` tracks state in `pgmigrations`; a migration that cannot roll back is a migration that cannot be reverted in an incident.)
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(m1): posts + media schema on uuidv7 primary keys"`

### Task 5: `@thinkersjournal/markdown` — the sanitize-first render pipeline

> **The highest-risk surface in M1.** User-authored Markdown → rendered in workerd (**no DOM, ever**) → **edge-cached** → mass-served. An XSS here is a **stored, cached, mass-distributed** XSS.
>
> **Why unified and not markdown-it/marked: the AST, not the parser.** String-emitting renderers force sanitization to *re-parse* their HTML — which in workerd means a DOM shim (broken) or `htmlparser2` (needs `process`). unified goes mdast → hast → **sanitize the TREE** → stringify: **HTML is never parsed, only serialized once, at the end, from an already-sanitized tree.** No parser-differential/mXSS surface. It also cleanly serves M3, where `{{ref:TOKEN}}` becomes trusted hast-node injection *after* sanitize.
>
> **`rehype-sanitize`, and nothing else.** DOMPurify+linkedom is **disqualifying**: its source reads `if (!DOMPurify.isSupported) { return dirty; }` — an imperfect DOM shim makes `sanitize()` return **attacker HTML unmodified**, with no throw and no warning (`cloudflare/workerd#5752`, open since 2025-12). A sanitizer whose failure mode is "silently become a pass-through" cannot sit on a stored+cached+mass-served surface. HTMLRewriter is **not a sanitizer** (per Cloudflare's own maintainer) and the Sanitizer API will not ship. `sanitize-html` needs `process` + `htmlparser2` and is string→parse→string, i.e. the exact surface unified avoids.
>
> **Render at READ time.** The edge cache amortizes it (~1–5ms/render, once per PoP per TTL, against a 30s CPU limit), so write-time buys ~nothing while costing the thing that matters most: **a sanitizer fix would require a backfill of every row.** Read-time makes tightening the schema or patching a rehype-sanitize CVE a **deploy** that fixes every post at once. `PIPELINE_VERSION`'s bump is the write-time backfill, replaced by a one-character change — ⚠️ **not** because it sits "in the cache key" (a `Cache-Tag` is a purge handle, not a key component, and Cloudflare's cache key is not user-composable for eyeball traffic), but **transitively**: `packages/markdown` is bundled into `web`, so the bump changes the bundle, which changes the Worker's VERSION, which **is** in the cache key by default — every entry goes cold on that deploy. See the amended Global Constraint.

**Files:** Create `packages/markdown/package.json`, `packages/markdown/tsconfig.json`, `packages/markdown/src/{index,render,excerpt}.ts`, `packages/markdown/test/{dom.ts,xss.test.ts,render.test.ts,excerpt.test.ts}`.

**Interfaces — Produces:**
- `PIPELINE_VERSION: string` — **bump ⇒ every cached render is invalidated on deploy.**
- `renderMarkdown(markdown: string): Promise<string>` — trusted-to-embed HTML.
- `markdownExcerpt(markdown: string, maxChars?: number): string` — plain text, for `<meta description>`/OG/RSS.

- [ ] **Step 1: Scaffold the package.** `packages/markdown/package.json`:

  ```json
  {
    "name": "@thinkersjournal/markdown",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": {
      "typecheck": "tsc --noEmit",
      "test": "vitest run",
      "check:workerd": "esbuild src/index.ts --bundle --format=esm --platform=browser --outfile=/dev/null"
    },
    "dependencies": {
      "mdast-util-to-string": "^4.0.0",
      "rehype-external-links": "^3.0.0",
      "rehype-sanitize": "6.0.0",
      "rehype-stringify": "^10.0.1",
      "remark-gfm": "^4.0.1",
      "remark-parse": "^11.0.0",
      "remark-rehype": "11.1.2",
      "unified": "11.0.5"
    },
    "devDependencies": {
      "@types/hast": "^3.0.4",
      "esbuild": "^0.25.0",
      "rehype-parse": "^9.0.1",
      "unist-util-visit": "^5.0.0",
      "vitest": "^4.1.10"
    }
  }
  ```

  `packages/markdown/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`. Run `pnpm install`.

  > `rehype-parse` + `unist-util-visit` are **devDependencies**: they parse the pipeline's *output* in tests so assertions run against a real tree. They never ship to workerd, so the DOMPurify objection does not apply to them.

- [ ] **Step 2: Write the tree-walking test helper** (`packages/markdown/test/dom.ts`) — this is what makes every assertion below structural:

  ```ts
  /**
   * ⚠️ ASSERT ON THE PARSED TREE, NEVER A SUBSTRING.
   *
   * `expect(html).not.toContain("javascript:")` produces FALSE POSITIVES that
   * train people to ignore this suite:
   *   • `<a>javascript:alert(1)</a>` — href stripped, inert TEXT — "contains" it;
   *   • `title="onmouseover=alert(1)"` — quoted, inert — "contains" it.
   * Both are perfectly safe. So the output is re-parsed with a real HTML parser
   * and the assertions read ATTRIBUTES off the resulting tree.
   */
  import rehypeParse from "rehype-parse";
  import { unified } from "unified";
  import { visit } from "unist-util-visit";

  import type { Element, Root } from "hast";

  export function elements(html: string): Element[] {
    const tree = unified().use(rehypeParse, { fragment: true }).parse(html) as Root;
    const found: Element[] = [];
    visit(tree, "element", (node: Element) => {
      found.push(node);
    });
    return found;
  }

  export function tagNames(html: string): string[] {
    return elements(html).map((el) => el.tagName);
  }

  /** hast property names for every attribute that can carry a URL. */
  const URL_PROPERTIES = ["href", "src", "cite", "longDesc", "srcSet", "action", "formAction", "poster"] as const;

  export function urlValues(html: string): string[] {
    return elements(html).flatMap((el) =>
      URL_PROPERTIES.map((k) => el.properties?.[k]).filter((v): v is string => typeof v === "string"),
    );
  }

  /**
   * Every `on*` attribute surviving in the output. hast maps `onerror` to the
   * camelCase `onError` via property-information, so match case-insensitively.
   */
  export function eventHandlerNames(html: string): string[] {
    return elements(html).flatMap((el) =>
      Object.keys(el.properties ?? {}).filter((k) => k.toLowerCase().startsWith("on")),
    );
  }

  /** The URL scheme, lowercased, or null for a relative/fragment URL. */
  export function schemeOf(url: string): string | null {
    const match = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
    return match === null ? null : match[1]!.toLowerCase();
  }

  /** null (relative) plus exactly the schemes our schema permits. */
  const SAFE_SCHEMES: ReadonlySet<string | null> = new Set([null, "http", "https", "mailto"]);

  export function unsafeUrls(html: string): string[] {
    return urlValues(html).filter((u) => !SAFE_SCHEMES.has(schemeOf(u)));
  }
  ```

- [ ] **Step 3: Write the failing XSS corpus** (`packages/markdown/test/xss.test.ts`) — the 16 verified payloads, pinned:

  ```ts
  import { describe, expect, it } from "vitest";

  import { renderMarkdown } from "../src";
  import { elements, eventHandlerNames, tagNames, unsafeUrls } from "./dom";

  /**
   * THE XSS REGRESSION CORPUS. Every payload here was verified against this exact
   * pipeline; each one is a documented way that a "no raw HTML" renderer still
   * leaks. Deleting a case is deleting the proof that a defense is still on.
   *
   * ⚠️ Payloads 1-9 exist BECAUSE remark-rehype performs ZERO URL-protocol
   * validation. Raw-HTML-off stops TAG injection and does NOTHING about URL
   * injection. rehype-sanitize is what blocks them — it is not belt-and-braces.
   */
  const DANGEROUS_TAGS = ["script", "iframe", "object", "embed", "style", "svg", "math", "base", "link", "meta", "form"];

  /** Every payload must satisfy ALL of these. */
  async function expectInert(markdown: string): Promise<string> {
    const html = await renderMarkdown(markdown);
    expect(unsafeUrls(html), "a URL attribute survived with a non-http(s)/mailto scheme").toEqual([]);
    expect(eventHandlerNames(html), "an event-handler attribute survived").toEqual([]);
    expect(
      tagNames(html).filter((t) => DANGEROUS_TAGS.includes(t)),
      "a scriptable/injectable element survived",
    ).toEqual([]);
    return html;
  }

  describe("URL-protocol injection (remark-rehype validates NOTHING here)", () => {
    it.each([
      ["1. plain javascript:", "[x](javascript:alert(1))"],
      ["2. mixed case", "[x](JaVaScRiPt:alert(1))"],
      ["3. numeric entity", "[x](java&#115;cript:alert(1))"],
      ["4. named entity colon", "[x](javascript&colon;alert(1))"],
      ["5a. leading whitespace", "[x](  javascript:alert(1))"],
      ["5b. backslash escape", "[x](javascript\\:alert(1))"],
      ["6. REFERENCE-STYLE", "[x][ref]\n\n[ref]: javascript:alert(1)"],
      ["7. vbscript:", "[x](vbscript:msgbox(1))"],
      ["8. data:text/html image", "![](data:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)"],
      ["9. data:image/svg+xml", "![](data:image/svg+xml;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)"],
    ])("%s is blocked", async (_name, markdown) => {
      await expectInert(markdown);
    });

    it("9b. is STRICTER than markdown-it's GOOD_DATA_RE — no data: URL survives at all", async () => {
      const html = await renderMarkdown("![](data:image/png;base64,iVBORw0KGgo=)");
      // markdown-it's validateLink ALLOWS data:image/(gif|png|jpeg|webp) — even in
      // href. Our schema's `src: ['http','https']` blocks ALL data: URLs. Pinned
      // so nobody "fixes" the schema toward markdown-it's looser policy.
      expect(unsafeUrls(html)).toEqual([]);
      expect(elements(html).filter((e) => e.tagName === "img").map((e) => e.properties?.src)).toEqual([undefined]);
    });
  });

  describe("raw HTML injection", () => {
    it.each([
      ["10a. img onerror", "<img src=x onerror=alert(1)>"],
      ["10b. script", "<script>alert(1)</script>"],
      ["11a. svg onload", "<svg onload=alert(1)></svg>"],
      ["11b. iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
      ["11c. style", "<style>body{background:url(javascript:alert(1))}</style>"],
      ["12. interleaved emphasis", "*<img src=x onerror=alert(1)>*"],
    ])("%s is blocked", async (_name, markdown) => {
      await expectInert(markdown);
    });

    it("13. entity smuggling stays LITERAL TEXT", async () => {
      const html = await renderMarkdown("&lt;img src=x onerror=alert(1)&gt;");
      await expectInert("&lt;img src=x onerror=alert(1)&gt;");
      // The decoded text must survive as TEXT — an over-eager "fix" that strips it
      // would be a correctness bug (people write about HTML on this site).
      expect(html).toContain("&#x3C;img src=x onerror=alert(1)>");
    });

    it("14. attribute breakout in alt text does not create an attribute", async () => {
      const html = await renderMarkdown('![alt"onerror=alert(1)](https://a.com/i.png)');
      expect(eventHandlerNames(html)).toEqual([]);
      const img = elements(html).find((e) => e.tagName === "img");
      // The quote is INSIDE the alt value, escaped by the serializer — not a breakout.
      expect(img?.properties?.alt).toBe('alt"onerror=alert(1)');
      expect(img?.properties?.src).toBe("https://a.com/i.png");
    });
  });

  describe("15. DOM clobbering", () => {
    it("cannot clobber a footnote target", async () => {
      await expectInert('<a id="body" name="body"></a>\n\nx[^body]\n\n[^body]: note');
    });

    it("footnote links still WORK (clobber: [] is load-bearing in both directions)", async () => {
      const html = await renderMarkdown("x[^1]\n\n[^1]: note");
      const ids = elements(html).map((e) => e.properties?.id).filter((v): v is string => typeof v === "string");
      // remark-rehype ALREADY prefixes footnote ids with `user-content-`. Leaving
      // sanitize's `clobber` on DOUBLE-prefixes them and BREAKS EVERY FOOTNOTE
      // LINK (reproduced in both the default and clobberPrefix:'' configs). This
      // asserts the id and the href still agree.
      expect(ids.some((id) => id.startsWith("user-content-"))).toBe(true);
      const hrefs = elements(html).map((e) => e.properties?.href).filter((v): v is string => typeof v === "string");
      const fragments = hrefs.filter((h) => h.startsWith("#")).map((h) => h.slice(1));
      expect(fragments.every((f) => ids.includes(f))).toBe(true);
    });
  });

  describe("16. fence-language injection", () => {
    it("does not throw and produces no element from the info string", async () => {
      // ⚠️ The fence info string is ATTACKER-CONTROLLED. Here (pre-Shiki) it must
      // survive only as an escaped, inert class. Task 6 pins the other half: that
      // it cannot make Shiki THROW, which would 500 every post.
      const html = await renderMarkdown('```"><img src=x onerror=alert(1)\ncode\n```');
      expect(eventHandlerNames(html)).toEqual([]);
      expect(tagNames(html).filter((t) => t === "img")).toEqual([]);
    });
  });
  ```

- [ ] **Step 4: Run → FAIL.** `pnpm --filter @thinkersjournal/markdown test` → `Cannot find module '../src'`.
- [ ] **Step 5: Implement the pipeline.** `packages/markdown/src/render.ts`:

  ```ts
  /**
   * THE MARKDOWN RENDER PIPELINE — the highest-risk surface in the platform.
   * User-authored Markdown, rendered in workerd (NO DOM), EDGE-CACHED, and
   * mass-served: an XSS here is a stored, cached, mass-distributed XSS.
   *
   * ⚠️ "NO RAW HTML" IS NOT SUFFICIENT. remark-rehype performs ZERO URL-protocol
   * validation — it drops raw HTML while happily emitting href="javascript:...",
   * href="java&#115;cript:...", href="vbscript:..." and src="data:text/html;...".
   * Raw-HTML-off stops TAG injection and does nothing about URL injection.
   * rehype-sanitize is LOAD-BEARING, not defense-in-depth. test/xss.test.ts pins
   * all sixteen verified payloads.
   *
   * ⚠️ NEVER ADD rehype-raw. It is the only reason we would need an HTML parser,
   * and it re-opens everything — including invalidating the `clobber: []` premise
   * below, which rests entirely on raw HTML being off.
   *
   * ⚠️ NEVER SWAP IN DOMPurify (+ any DOM shim). Its source reads
   * `if (!DOMPurify.isSupported) { return dirty; }` — an imperfect shim makes
   * sanitize() return ATTACKER HTML UNMODIFIED, with no throw and no warning
   * (cloudflare/workerd#5752, open since 2025-12). A sanitizer whose failure mode
   * is "silently become a pass-through" is disqualifying on this surface.
   * HTMLRewriter is not a sanitizer (per Cloudflare's own maintainer).
   */
  import rehypeExternalLinks from "rehype-external-links";
  import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
  import rehypeStringify from "rehype-stringify";
  import remarkGfm from "remark-gfm";
  import remarkParse from "remark-parse";
  import remarkRehype from "remark-rehype";
  import { unified } from "unified";

  /**
   * ⚠️ BUMP THIS AND EVERY CACHED RENDER IS INVALIDATED ON DEPLOY.
   *
   * This is why rendering happens at READ time. The alternative — storing HTML —
   * would make a schema tightening or a rehype-sanitize CVE patch a BACKFILL OF
   * EVERY ROW. Here it is a deploy, plus this one character.
   *
   * ⚠️ NOT "part of the cache key" — it is folded into a `pipeline:` Cache-TAG
   * (apps/web/src/lib/cache.ts), and a Cache-Tag is a purge handle, not a key
   * component (Cloudflare's cache key is not user-composable for eyeball
   * traffic). The real deploy-time guarantee is TRANSITIVE: this package is
   * bundled into `web`, so bumping this string changes the bundle, which changes
   * the Worker's VERSION, which IS in the cache key by default — every cached
   * render goes cold on that deploy. Bump it whenever the pipeline's OUTPUT
   * changes for the same input.
   */
  export const PIPELINE_VERSION = "v1";

  /**
   * ⚠️ defaultSchema IS NOT OUR POLICY. Every override below is load-bearing.
   */
  const schema: typeof defaultSchema = {
    ...defaultSchema,

    // ⚠️ MUST be [] — and it is correct ONLY because raw HTML is off. remark-rehype
    // already prefixes footnote ids with `user-content-`, and raw HTML is dropped,
    // so no attacker-controlled id/name can reach the tree in the first place.
    // Leaving sanitize's clobber ON therefore DOUBLE-prefixes ids and BREAKS EVERY
    // FOOTNOTE LINK (reproduced in both the default and clobberPrefix:'' configs).
    // ⚠️ If rehype-raw is ever enabled, restore `clobber` AND re-audit this entire
    // file — that one flag invalidates the premise this whole config rests on.
    clobber: [],

    protocols: {
      ...defaultSchema.protocols,
      // defaultSchema ALSO allows irc/ircs/xmpp on href. Dropped: we have no use
      // for them and every extra scheme is a handler we have not thought about.
      href: ["http", "https", "mailto"],
      // Blocks ALL data: URLs — including data:image/*, which markdown-it's
      // GOOD_DATA_RE permits. We are deliberately stricter.
      src: ["http", "https"],
      cite: ["http", "https"],
      longDesc: ["http", "https"],
    },

    // Markdown cannot produce these; belt-and-braces. `srcSet` is NOT
    // protocol-checked by defaultSchema — moot once source/picture are gone.
    tagNames: (defaultSchema.tagNames ?? []).filter((t) => !["picture", "source"].includes(t)),
  };
  // Do NOT drop `input`: GFM tasklists need it, and defaultSchema.required pins it
  // to { disabled: true, type: 'checkbox' }, which is safe.

  function buildRenderer() {
    return (
      unified()
        .use(remarkParse)
        .use(remarkGfm)
        // allowDangerousHtml is false by DEFAULT => raw HTML is dropped here.
        .use(remarkRehype)
        // ─────────────────────────────────────────────────────────────────────
        // ⚠️ THE LAST UNSAFE THING IS ABOVE THIS LINE.
        .use(rehypeSanitize, schema)
        // Everything below is trusted, app-generated, and MUST run AFTER sanitize.
        // ORDERING IS NOT COSMETIC: defaultSchema allows NO `rel`, NO `target` and
        // NO `style` on any element, so running these BEFORE the sanitizer would
        // silently STRIP exactly what they add. rehype's own rule: "use
        // rehype-sanitize after the last unsafe thing."
        // ─────────────────────────────────────────────────────────────────────
        .use(rehypeExternalLinks, {
          rel: ["nofollow", "ugc", "noopener", "noreferrer"],
          target: "_blank",
          protocols: ["http", "https"],
        })
        // Task 6 inserts Shiki here. M3 inserts the ref-card plugin here.
        .use(rehypeStringify)
    );
  }

  /**
   * Memoized because Task 6 makes construction genuinely async (Shiki's
   * highlighter init). Declared async NOW so that task adds a step rather than
   * changing this module's signature and every call site with it.
   */
  let rendererPromise: ReturnType<typeof buildRendererAsync> | null = null;
  async function buildRendererAsync(): Promise<ReturnType<typeof buildRenderer>> {
    return buildRenderer();
  }

  /** Render `markdown` to HTML that is safe to embed. */
  export async function renderMarkdown(markdown: string): Promise<string> {
    rendererPromise ??= buildRendererAsync();
    const renderer = await rendererPromise;
    return String(await renderer.process(markdown));
  }
  ```

  `packages/markdown/src/excerpt.ts`:

  ```ts
  import { toString } from "mdast-util-to-string";
  import remarkParse from "remark-parse";
  import { unified } from "unified";

  /**
   * Plain TEXT for `<meta name="description">`, OG, and RSS — never HTML.
   *
   * Derived from the mdast, not from the rendered HTML: there is no markup to
   * strip and therefore no stripping to get wrong. The result goes into an
   * attribute (Astro escapes it) or into XML (escaped by apps/web/src/lib/xml.ts).
   */
  export function markdownExcerpt(markdown: string, maxChars = 160): string {
    const text = toString(unified().use(remarkParse).parse(markdown)).replace(/\s+/g, " ").trim();
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }
  ```

  `packages/markdown/src/index.ts`:

  ```ts
  export { markdownExcerpt } from "./excerpt";
  export { PIPELINE_VERSION, renderMarkdown } from "./render";
  ```

- [ ] **Step 6: Write the behaviour tests** (`packages/markdown/test/render.test.ts`) — the pipeline must also *work*, not just refuse:

  ```ts
  import { describe, expect, it } from "vitest";

  import { renderMarkdown } from "../src";
  import { elements } from "./dom";

  describe("rehype-external-links runs AFTER sanitize (and is why it works at all)", () => {
    it("decorates an external link with rel + target", async () => {
      const html = await renderMarkdown("[e](https://e.com)");
      const a = elements(html).find((el) => el.tagName === "a");
      // defaultSchema allows NO rel and NO target. If these are missing, the
      // plugin has been moved BEFORE rehypeSanitize and is being stripped.
      expect(a?.properties?.rel).toEqual(["nofollow", "ugc", "noopener", "noreferrer"]);
      expect(a?.properties?.target).toBe("_blank");
    });

    it("leaves relative and mailto: links alone", async () => {
      const relative = elements(await renderMarkdown("[r](/about)")).find((e) => e.tagName === "a");
      expect(relative?.properties?.href).toBe("/about");
      expect(relative?.properties?.target).toBeUndefined();
      const mail = elements(await renderMarkdown("[m](mailto:a@b.com)")).find((e) => e.tagName === "a");
      expect(mail?.properties?.href).toBe("mailto:a@b.com");
    });
  });

  describe("GFM", () => {
    it("renders tables", async () => {
      const html = await renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
      expect(elements(html).map((e) => e.tagName)).toContain("table");
    });

    it("renders tasklists WITH the checkbox (input must stay in tagNames)", async () => {
      const html = await renderMarkdown("- [x] done");
      const input = elements(html).find((e) => e.tagName === "input");
      // defaultSchema.required pins these two, which is what makes `input` safe.
      expect(input?.properties?.type).toBe("checkbox");
      expect(input?.properties?.disabled).toBe(true);
    });

    it("renders strikethrough and autolinks", async () => {
      expect(elements(await renderMarkdown("~~x~~")).map((e) => e.tagName)).toContain("del");
      const auto = elements(await renderMarkdown("https://e.com")).find((e) => e.tagName === "a");
      expect(auto?.properties?.href).toBe("https://e.com");
    });
  });

  describe("images", () => {
    it("keeps an https image", async () => {
      const img = elements(await renderMarkdown("![a](https://cdn.example/i.webp)")).find((e) => e.tagName === "img");
      expect(img?.properties?.src).toBe("https://cdn.example/i.webp");
      expect(img?.properties?.alt).toBe("a");
    });
  });

  describe("PIPELINE_VERSION", () => {
    it("is a non-empty string (folded into a Cache-Tag; invalidation is transitive via the Worker version — see render.ts)", async () => {
      const { PIPELINE_VERSION } = await import("../src");
      expect(PIPELINE_VERSION).toMatch(/^v\d+$/);
    });
  });
  ```

  And `packages/markdown/test/excerpt.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";

  import { markdownExcerpt } from "../src";

  describe("markdownExcerpt", () => {
    it("strips markup and collapses whitespace", () => {
      expect(markdownExcerpt("# Title\n\nSome **bold**  text.")).toBe("Title Some bold text.");
    });

    it("truncates with an ellipsis at the limit", () => {
      const out = markdownExcerpt("a".repeat(500), 20);
      expect(out).toHaveLength(20);
      expect(out.endsWith("…")).toBe(true);
    });

    it("returns TEXT, never markup — including for raw HTML input", () => {
      // The excerpt lands in an attribute and in XML; it must never carry a tag.
      expect(markdownExcerpt("<img src=x onerror=alert(1)> hi")).not.toContain("<");
    });

    it("handles an empty document", () => {
      expect(markdownExcerpt("")).toBe("");
    });
  });
  ```

- [ ] **Step 7: Run → PASS.** `pnpm --filter @thinkersjournal/markdown test` → all green (16 corpus cases + behaviour + excerpt).
- [ ] **Step 8: Prove it loads in workerd — the cheap guard.** `pnpm --filter @thinkersjournal/markdown run check:workerd` → **exit 0**. `--platform=browser` **errors on any `node:` import**, which is exactly the failure mode a transitive dep would introduce; this is the same check that verified the stack resolves at **161 KB min / 49.9 KB gzipped** (0.5% of the 10MB Paid limit). Run it in CI alongside `typecheck`. (Task 15 is the end-to-end proof; this is the one that fails in 200ms instead of at the end of a task.)
- [ ] **Step 9: Commit.** `git add -A && git commit -m "feat(m1): @thinkersjournal/markdown — sanitize-first render pipeline + XSS corpus"`

### Task 6: Shiki highlighting + the language-allowlist DoS guard

> **`createHighlighterCore` + `createJavaScriptRegexEngine()` — no WASM at all.** The full `shiki` bundle is **two** failures at once: size, and Oniguruma's **runtime** WASM, which workerd forbids (`CompileError: Wasm code generation disallowed by embedder` — the same wall `hash-wasm` hit in M0). ⚠️ **The argon2id static-`.wasm` precedent does NOT transfer**: that is a small, pure-compute, fixed-size-input module; a regex engine loaded at runtime is not.
>
> **Shiki emits HAST, not an HTML string**, so it never round-trips through a parser and is safe **after** sanitize — which is also where it must go, since `defaultSchema` allows no `style` and would strip every token colour.
>
> ⚠️ **The fence info string is ATTACKER-CONTROLLED and reaches Shiki.** It survives sanitization as an escaped, inert class (Task 5, payload 16) — **but Shiki THROWS on an unloaded language**, which is a 500 on **every post containing that fence**: a trivial, permanent, one-character DoS. The allowlist is not tidiness.

**Files:** Create `packages/markdown/src/{highlight,lang-allowlist}.ts`, `packages/markdown/test/highlight.test.ts`. Modify `packages/markdown/src/render.ts`, `packages/markdown/package.json`.

**Interfaces — Produces:** `HIGHLIGHT_THEME`, `HIGHLIGHT_LANGS`, `getHighlighter(): Promise<HighlighterCore>`, and the `rehypeLanguageAllowlist` plugin. `renderMarkdown`'s signature is **unchanged** (Task 5 already made it async for exactly this).

- [ ] **Step 1: Add the deps.** In `packages/markdown/package.json` `dependencies` add `"shiki": "4.3.1"`, `"@shikijs/rehype": "^4.3.1"`, `"@shikijs/langs": "^4.3.1"`, `"@shikijs/themes": "^4.3.1"`. `pnpm install`.
- [ ] **Step 2: Write the failing test** (`packages/markdown/test/highlight.test.ts`):

  ```ts
  import { describe, expect, it } from "vitest";

  import { renderMarkdown } from "../src";
  import { HIGHLIGHT_LANGS } from "../src/highlight";
  import { elements, eventHandlerNames, tagNames } from "./dom";

  describe("syntax highlighting", () => {
    it("highlights an allowlisted language", async () => {
      const html = await renderMarkdown("```typescript\nconst x: number = 1;\n```");
      const styled = elements(html).filter((e) => typeof e.properties?.style === "string");
      // Shiki's output is per-token spans carrying inline colours. No spans means
      // Shiki did not run — most likely it was placed BEFORE rehypeSanitize, whose
      // defaultSchema allows no `style` and silently strips every one of them.
      expect(styled.length).toBeGreaterThan(0);
    });

    it("renders a plain fence with no language", async () => {
      const html = await renderMarkdown("```\nplain\n```");
      expect(tagNames(html)).toContain("pre");
    });
  });

  describe("the language allowlist (a DoS guard, not tidiness)", () => {
    it.each([
      ["an unknown language", "```definitely-not-a-language\nx\n```"],
      ["16. the fence-language XSS payload", '```"><img src=x onerror=alert(1)\nx\n```'],
      ["an absurdly long info string", "```" + "a".repeat(5000) + "\nx\n```"],
    ])("%s does NOT throw", async (_name, markdown) => {
      // ⚠️ Shiki THROWS on an unloaded language. Unguarded, one fence 500s EVERY
      // render of that post — a permanent, one-character DoS by any author.
      await expect(renderMarkdown(markdown)).resolves.toBeTypeOf("string");
    });

    it("falls back to plain text without inventing markup", async () => {
      const html = await renderMarkdown('```"><img src=x onerror=alert(1)\nx\n```');
      expect(tagNames(html)).toContain("pre");
      expect(tagNames(html).filter((t) => t === "img")).toEqual([]);
      expect(eventHandlerNames(html)).toEqual([]);
    });

    it("every advertised language actually loads", async () => {
      // A typo in HIGHLIGHT_LANGS would silently demote a real language to `text`.
      for (const lang of HIGHLIGHT_LANGS) {
        const html = await renderMarkdown(`\`\`\`${lang}\nx\n\`\`\``);
        expect(
          elements(html).some((e) => typeof e.properties?.style === "string"),
          `\`${lang}\` is advertised in HIGHLIGHT_LANGS but rendered unhighlighted — the import in src/highlight.ts is missing or misspelled.`,
        ).toBe(true);
      }
    });
  });
  ```

- [ ] **Step 3: Run → FAIL.** `pnpm --filter @thinkersjournal/markdown test highlight` → `Cannot find module '../src/highlight'`.
- [ ] **Step 4: Implement the allowlist plugin** (`packages/markdown/src/lang-allowlist.ts`):

  ```ts
  /**
   * Rewrite any `language-<x>` class Shiki cannot handle to `language-text`.
   *
   * ⚠️ THIS IS A DoS GUARD. The fence info string is ATTACKER-CONTROLLED and
   * reaches Shiki, which THROWS on an unloaded language. Unguarded, ```` ```zzz ````
   * in any post 500s EVERY render of that post, forever, for everyone — the
   * cheapest denial of service on the platform.
   *
   * ⚠️ RUNS AFTER rehypeSanitize AND BEFORE Shiki. Before the sanitizer it would
   * be pointless (the class it reads is what sanitize's `/^language-./` rule
   * decides to keep); after Shiki it would be too late to prevent the throw.
   */
  import { visit } from "unist-util-visit";

  import type { Element, Root } from "hast";

  /**
   * Shiki's built-in no-op languages. `getLoadedLanguages()` does NOT list them
   * (they never load), but Shiki accepts them — so they must be added by hand or
   * the fallback below would itself be an unloaded language.
   */
  const SPECIAL_LANGS = ["text", "plaintext", "txt", "ansi"] as const;

  export const FALLBACK_LANG = "text";

  export interface LanguageAllowlistOptions {
    /** Typically `highlighter.getLoadedLanguages()` — names AND aliases. */
    readonly languages: readonly string[];
  }

  export function rehypeLanguageAllowlist(options: LanguageAllowlistOptions) {
    const allowed = new Set<string>([...options.languages, ...SPECIAL_LANGS]);

    return (tree: Root): void => {
      visit(tree, "element", (node: Element, _index, parent) => {
        if (node.tagName !== "code") return;
        if ((parent as Element | undefined)?.tagName !== "pre") return;

        const classes = node.properties?.className;
        if (!Array.isArray(classes)) return;

        node.properties!.className = classes.map((c) => {
          if (typeof c !== "string" || !c.startsWith("language-")) return c;
          const lang = c.slice("language-".length).toLowerCase();
          return allowed.has(lang) ? c : `language-${FALLBACK_LANG}`;
        });
      });
    };
  }
  ```

- [ ] **Step 5: Implement the highlighter** (`packages/markdown/src/highlight.ts`):

  ```ts
  /**
   * ⚠️ createHighlighterCore + the JAVASCRIPT REGEX ENGINE — NO WASM AT ALL.
   *
   * The full `shiki` bundle is two failures at once: bundle size, and Oniguruma's
   * RUNTIME WebAssembly, which workerd forbids outright ("Wasm code generation
   * disallowed by embedder") — the same wall hash-wasm hit in M0.
   *
   * ⚠️ THE argon2id STATIC-.wasm PRECEDENT DOES NOT TRANSFER. That works because
   * a statically-imported `.wasm` yields an ALREADY-COMPILED Module and argon2 is
   * small, pure-compute, and fixed-size-input. A regex engine compiled at runtime
   * from a grammar is none of those. createJavaScriptRegexEngine() sidesteps the
   * question entirely.
   */
  import { createHighlighterCore } from "shiki/core";
  import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

  import type { HighlighterCore } from "shiki/core";

  export const HIGHLIGHT_THEME = "github-dark";

  /**
   * THE EXPLICIT ALLOWLIST. Every entry costs bundle size, so this is a curated
   * launch set, not "everything Shiki has". Anything else renders as plain text
   * (src/lang-allowlist.ts) rather than throwing.
   */
  export const HIGHLIGHT_LANGS = [
    "typescript", "javascript", "tsx", "jsx", "json", "html", "css",
    "bash", "python", "rust", "go", "sql", "yaml", "markdown", "diff",
  ] as const;

  let highlighterPromise: Promise<HighlighterCore> | null = null;

  /** The process-wide highlighter. Built once per isolate; never per render. */
  export async function getHighlighter(): Promise<HighlighterCore> {
    highlighterPromise ??= createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark")],
      langs: [
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/javascript"),
        import("@shikijs/langs/tsx"),
        import("@shikijs/langs/jsx"),
        import("@shikijs/langs/json"),
        import("@shikijs/langs/html"),
        import("@shikijs/langs/css"),
        import("@shikijs/langs/bash"),
        import("@shikijs/langs/python"),
        import("@shikijs/langs/rust"),
        import("@shikijs/langs/go"),
        import("@shikijs/langs/sql"),
        import("@shikijs/langs/yaml"),
        import("@shikijs/langs/markdown"),
        import("@shikijs/langs/diff"),
      ],
      engine: createJavaScriptRegexEngine(),
    });
    return await highlighterPromise;
  }
  ```

- [ ] **Step 6: Wire it into the pipeline** — `packages/markdown/src/render.ts`:
  - Add `import rehypeShikiFromHighlighter from "@shikijs/rehype/core";`, `import { getHighlighter, HIGHLIGHT_THEME } from "./highlight";`, `import { rehypeLanguageAllowlist } from "./lang-allowlist";`.
  - Change `buildRenderer()` to take the highlighter: `function buildRenderer(highlighter: HighlighterCore) {`.
  - Insert **after** `.use(rehypeExternalLinks, {...})` and **before** `.use(rehypeStringify)`:

    ```ts
        // ⚠️ ORDER: allowlist THEN Shiki. The allowlist reads the class the
        // sanitizer decided to keep, and must run before Shiki can throw on it.
        .use(rehypeLanguageAllowlist, { languages: highlighter.getLoadedLanguages() })
        // ⚠️ AFTER rehypeSanitize, non-negotiably: defaultSchema allows no `style`,
        // so a sanitizer running after this would strip every token colour. Safe
        // because Shiki emits HAST — it never round-trips through a string parser.
        .use(rehypeShikiFromHighlighter, highlighter, { theme: HIGHLIGHT_THEME })
    ```

  - Replace `buildRendererAsync` with:

    ```ts
    async function buildRendererAsync(): Promise<ReturnType<typeof buildRenderer>> {
      return buildRenderer(await getHighlighter());
    }
    ```

  - Bump nothing: `PIPELINE_VERSION` stays `"v1"` — no post has been rendered or cached yet.

- [ ] **Step 7: Run → PASS.** `pnpm --filter @thinkersjournal/markdown test` → all green, **including the Task 5 corpus** (Shiki must not have reopened anything). Then `pnpm --filter @thinkersjournal/markdown run check:workerd` → **exit 0** — this is what proves the JS regex engine kept every `node:`/WASM path out of the bundle.
- [ ] **Step 8: Commit.** `git add -A && git commit -m "feat(m1): Shiki highlighting via the JS regex engine + language-allowlist DoS guard"`

### Task 7: The magic-byte sniffer

> ⚠️ **SVG IS A SUPPORTED CLOUDFLARE IMAGES INPUT — THE BINDING WILL NOT REJECT IT.** Cloudflare does not resize SVG; it sanitizes it via svg-hush and passes it through. **An SVG can survive the whole pipeline. The Images binding is NOT the SVG defense. This function is.**
>
> **An ALLOWLIST, never a denylist**, and hand-rolled at ~30 lines rather than `file-type` — which is a large dependency (attack surface) that **does not detect SVG anyway**. Frame it as "accept only these four": SVG fails **by construction**, because it has no magic number at all — it is XML, frequently with leading whitespace, a BOM, comments, or an XML declaration, which is precisely why signature-*deny*listing it is unreliable.

**Files:** Create `apps/api/src/media/sniff.ts`, `apps/api/test/sniff.test.ts`.

**Interfaces — Produces:** `type SniffedFormat = "image/jpeg" | "image/png" | "image/gif" | "image/webp"`; `SNIFF_HEADER_BYTES = 16`; `sniffImageFormat(header: Uint8Array): SniffedFormat | null`.

- [ ] **Step 1: Write the failing test** (`apps/api/test/sniff.test.ts`) — byte literals, so there is no fixture that can be subtly wrong:

  ```ts
  import { describe, expect, it } from "vitest";

  import { sniffImageFormat, SNIFF_HEADER_BYTES } from "../src/media/sniff";

  const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);
  const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
  /** A header padded to the real slice length the route will pass. */
  const header = (head: Uint8Array): Uint8Array => {
    const out = new Uint8Array(SNIFF_HEADER_BYTES);
    out.set(head.subarray(0, SNIFF_HEADER_BYTES));
    return out;
  };

  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
  const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const GIF87A = ascii("GIF87a");
  const GIF89A = ascii("GIF89a");
  const webp = (): Uint8Array => {
    const out = new Uint8Array(12);
    out.set(ascii("RIFF"), 0);
    out.set(ascii("WEBP"), 8); // "WEBP" at offset 8, NOT 4 (4..8 is the size)
    return out;
  };

  describe("the allowlist accepts exactly four formats", () => {
    it.each([
      ["JPEG", JPEG, "image/jpeg"],
      ["PNG", PNG, "image/png"],
      ["GIF87a", GIF87A, "image/gif"],
      ["GIF89a", GIF89A, "image/gif"],
      ["WebP", webp(), "image/webp"],
    ] as const)("%s", (_n, head, expected) => {
      expect(sniffImageFormat(header(head))).toBe(expected);
    });
  });

  describe("SVG fails BY CONSTRUCTION (this is the whole point)", () => {
    it.each([
      ["bare", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"],
      ["leading whitespace", "   \n\t<svg/>"],
      ["XML declaration", '<?xml version="1.0"?><svg/>'],
      ["leading comment", "<!-- hi --><svg/>"],
      ["BOM", "﻿<svg/>"],
      ["DOCTYPE", "<!DOCTYPE svg><svg/>"],
    ])("%s", (_name, svg) => {
      // ⚠️ SVG IS A SUPPORTED CLOUDFLARE IMAGES INPUT — the binding will NOT
      // reject any of these. This function is the only thing that does. And it
      // works because SVG has NO magic number: every variant above starts with
      // different bytes, which is exactly why DENYlisting a signature fails.
      expect(sniffImageFormat(header(ascii(svg)))).toBeNull();
    });
  });

  describe("everything else is rejected", () => {
    it.each([
      ["empty", new Uint8Array(0)],
      ["one byte", bytes(0xff)],
      ["a truncated PNG signature", bytes(0x89, 0x50, 0x4e)],
      ["a truncated JPEG signature", bytes(0xff, 0xd8)],
      ["HTML", ascii("<!DOCTYPE html><html>")],
      ["a PDF", ascii("%PDF-1.7")],
      ["a ZIP", bytes(0x50, 0x4b, 0x03, 0x04)],
      ["ELF", bytes(0x7f, 0x45, 0x4c, 0x46)],
      ["all zeroes", new Uint8Array(SNIFF_HEADER_BYTES)],
    ])("%s", (_name, head) => {
      expect(sniffImageFormat(head)).toBeNull();
    });

    it("RIFF that is NOT WebP (a WAV)", () => {
      const wav = new Uint8Array(12);
      wav.set(ascii("RIFF"), 0);
      wav.set(ascii("WAVE"), 8);
      // The RIFF container is shared. Checking only "RIFF" would accept audio.
      expect(sniffImageFormat(wav)).toBeNull();
    });

    it("RIFF truncated before offset 8 does not read past the end", () => {
      expect(sniffImageFormat(ascii("RIFF"))).toBeNull();
    });
  });

  describe("polyglots", () => {
    it("a JPEG-prefixed polyglot sniffs as JPEG — the .info() cross-check is what catches it", () => {
      const poly = new Uint8Array(SNIFF_HEADER_BYTES);
      poly.set(JPEG, 0);
      poly.set(ascii("<svg"), 4);
      // Honest about the bound: a signature check answers "what does this claim
      // to be", never "what will a decoder do with it". The belt-and-braces is
      // Task 8's free IMAGES.info() format cross-check.
      expect(sniffImageFormat(poly)).toBe("image/jpeg");
    });
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test sniff` → `Cannot find module '../src/media/sniff'`.
- [ ] **Step 3: Implement** (`apps/api/src/media/sniff.ts`):

  ```ts
  /**
   * Magic-byte type sniffing for uploaded images — an ALLOWLIST of exactly four
   * formats.
   *
   * ⚠️ THIS IS THE SVG DEFENSE, AND NOTHING ELSE IS.
   * SVG is a SUPPORTED input format for Cloudflare Images: the binding will NOT
   * reject it — it does not resize SVG, it merely sanitizes it via svg-hush and
   * passes it through. An SVG can survive the entire pipeline. Do not delete this
   * check because "the Images binding validates the format"; it does not validate
   * the format WE need validated.
   *
   * ⚠️ AN ALLOWLIST, NEVER A DENYLIST. SVG has no magic number — it is XML, and it
   * legitimately begins with a BOM, whitespace, a comment, a DOCTYPE, or an XML
   * declaration in any combination. There is no byte prefix to deny. "Accept only
   * these four" rejects it by construction and needs no knowledge of it at all.
   *
   * ⚠️ HAND-ROLLED ON PURPOSE. `file-type` is a large dependency on a path that
   * handles hostile bytes, and it does not detect SVG anyway. Thirty lines with no
   * dependency is the smaller risk.
   *
   * ⚠️ WHAT THIS CANNOT DO. A signature answers "what does this claim to be",
   * never "what will a decoder do with it" — a JPEG-prefixed polyglot sniffs as
   * JPEG. The belt-and-braces is the FREE `env.IMAGES.info()` format cross-check
   * in src/routes/media.ts. Never rely on either alone.
   */

  export type SniffedFormat = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  /** Enough for every signature below (WebP's needs offset 8..12). */
  export const SNIFF_HEADER_BYTES = 16;

  function matchesAt(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
    if (bytes.length < offset + signature.length) return false;
    for (let i = 0; i < signature.length; i++) {
      if (bytes[offset + i] !== signature[i]) return false;
    }
    return true;
  }

  const JPEG = [0xff, 0xd8, 0xff] as const;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const; // "GIF87a"
  const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const; // "GIF89a"
  const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF" at 0
  const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP" at 8 (4..8 is the size)

  /** The sniffed format, or `null` — which callers MUST turn into a 415. */
  export function sniffImageFormat(header: Uint8Array): SniffedFormat | null {
    if (matchesAt(header, JPEG)) return "image/jpeg";
    if (matchesAt(header, PNG)) return "image/png";
    if (matchesAt(header, GIF87A) || matchesAt(header, GIF89A)) return "image/gif";
    // Both halves required: the RIFF container is shared with WAV/AVI.
    if (matchesAt(header, RIFF) && matchesAt(header, WEBP, 8)) return "image/webp";
    return null;
  }
  ```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test sniff` → all green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(m1): magic-byte image allowlist (the SVG defense)"`

### Task 8: `POST /media` — the transform-on-write image pipeline

> **Transform-on-WRITE.** Transform once at upload → store WebP in R2 → serve from R2. The Images bill then scales with **uploads, not views** (~100k users ⇒ 50k uploads/mo × 3 variants = 150k transforms ⇒ ~$72.50/mo + R2 storage, **egress $0**), and it sidesteps the "Images responses are not auto-cached" warning entirely — that warning targets transform-on-*read* designs; ours never re-transforms.
>
> **Rejected:** `cf.image`/`cdn-cgi` URL transforms (would require publishing the **untrusted, un-sniffed original** to a public URL first — that inverts the threat model); the Cloudflare Images *storage* product (~$100/mo at 100k, traffic-scaling, vs **$0** on R2); a WASM codec in-Worker (burns Worker CPU, fights the 128MB limit on 15MB images, and owns an image decoder's CVE/RCE surface — the argon2id precedent does not transfer).
>
> **EXIF stripping is automatic and free**: for non-JPEG output "all metadata will always be discarded". No config. (Colour profile + EXIF rotation are *applied* before the strip, so images are not sideways.)
>
> ⚠️ **DEVIATION FROM THE RESEARCH'S SKETCH: a RAW body, not multipart.** The research's step 1 says "POST /api/media (multipart)", but its own steps 2 and 10 pull the other way — *"enforce the size cap WHILE STREAMING (do not trust Content-Length)"* and *"never echo user Content-Type/filename"*. `request.formData()` **buffers the whole body** before you can cap it, and it costs a multipart parser on a hostile-byte path — to yield a filename and a `Content-Type` we have already decided to ignore. So `POST /media` takes the image bytes as the **raw body**: `fetch(url, { method: "POST", body: file })` sends exactly that natively, the cap is a trivial stream loop, and there is no parser. Nothing in the research's *verified findings* is contradicted; only its sketch of the transport.

**Files:** Create `apps/api/src/media/{body,images}.ts`, `apps/api/src/routes/media.ts`, `apps/api/test/media.test.ts`, `apps/api/test/fixtures/images.ts`. Modify `apps/api/wrangler.jsonc`, `apps/api/vitest.config.ts`, `apps/api/src/routes.ts`, `apps/api/src/worker-configuration.d.ts` (generated).

**Interfaces — Produces:**
- `readCappedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null>` (null ⇒ over the cap).
- `streamOf(bytes: Uint8Array): ReadableStream<Uint8Array>`
- `inspectImage(env, bytes): Promise<ImageFacts | null>` where `interface ImageFacts { format: string; width: number; height: number; fileSize: number }`
- `toWebp(env, bytes, maxEdge): Promise<Uint8Array>`
- `sha256HexOf(bytes: Uint8Array): Promise<string>`
- route `POST /media` → `201 {"id","url","width","height","bytes"}`
- bindings `IMAGES`, `MEDIA` (R2), `MEDIA_LIMITER`.

- [ ] **Step 1: VERIFY the bindings exist locally BEFORE anything depends on them.** Add the bindings to `apps/api/wrangler.jsonc`:

  ```jsonc
    // Cloudflare Images. NO zone, NO Images subscription, NO base fee — it is a
    // per-Worker binding (GA since Feb 2025). 5,000 free unique transforms/mo,
    // then $0.50/1k, billed once per unique (source+params) per calendar month.
    // `.info()` is FREE.
    // ⚠️ SVG IS A SUPPORTED INPUT — this binding will NOT reject it. The magic-byte
    // allowlist in src/media/sniff.ts is the SVG defense, not this.
    "images": { "binding": "IMAGES" },
    // Transformed WebP bytes, content-addressed on the OUTPUT hash. Served to the
    // public from the `cdn.thinkersjournal.com` R2 CUSTOM DOMAIN — deliberately
    // NOT through a Worker, which would add an invocation per image to buy authz
    // we do not need on a public CDN. Egress $0.
    "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "tj-media" }],
  ```

  and to the `ratelimits` array:

  ```jsonc
      {
        "name": "MEDIA_LIMITER",
        "namespace_id": "1003",
        "simple": { "limit": 20, "period": 60 }
      }
  ```

  Add the R2 simulation to `apps/api/vitest.config.ts` inside `cloudflareTest({ miniflare: { ... } })`:

  ```ts
                // Miniflare simulates R2 locally with an in-memory/disk-backed
                // bucket. The name need only match wrangler.jsonc's.
                r2Buckets: ["MEDIA"],
  ```

  Then run `pnpm --filter @thinkersjournal/api exec wrangler types` and commit the regenerated `src/worker-configuration.d.ts`. Now write a **throwaway probe** at `apps/api/test/images-probe.test.ts`:

  ```ts
  import { env } from "cloudflare:test";
  import { expect, it } from "vitest";

  import { PNG_1X1 } from "./fixtures/images";

  it("PROBE: the Images binding runs under miniflare", async () => {
    const info = await env.IMAGES.info(new Response(PNG_1X1).body!);
    expect(info.format).toBe("image/png");
  });

  it("PROBE: R2 round-trips under miniflare", async () => {
    await env.MEDIA.put("probe", PNG_1X1);
    expect(await env.MEDIA.get("probe")).not.toBeNull();
  });
  ```

  Create `apps/api/test/fixtures/images.ts` first:

  ```ts
  /**
   * Real, decodable image bytes for the media tests.
   *
   * ⚠️ Deliberately ONE real image. Task 7's sniffer is tested with byte literals
   * (no fixture can be subtly wrong there); this file exists only because the
   * Images binding needs bytes it can actually DECODE, and one format is enough
   * to exercise the pipeline end to end.
   */
  function fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /** A valid 1×1 opaque PNG. */
  export const PNG_1X1 = fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  );

  /** An SVG the Images binding would happily accept. Only the sniff stops it. */
  export const SVG_BYTES = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="alert(1)"/>',
  );

  /** Not an image at all. */
  export const TEXT_BYTES = new TextEncoder().encode("just some text, definitely not a PNG");

  /** A PNG-signed buffer larger than the route's cap, for the streaming test. */
  export function oversizeBytes(limit: number): Uint8Array {
    const out = new Uint8Array(limit + 1024);
    out.set(PNG_1X1.subarray(0, 8), 0);
    return out;
  }
  ```

  **Run the probe: `pnpm --filter @thinkersjournal/api test images-probe`.**
  - **Green** → delete `images-probe.test.ts` and proceed to Step 2.
  - **Red with "not implemented"/"no such binding"** → the Images binding has no local simulation in this toolchain. **The documented fallback**: keep `src/media/images.ts` exactly as written below (it is already the only place `env.IMAGES` is touched — that is why it exists as a module), and in `apps/api/test/media.test.ts` add `vi.mock("../src/media/images", ...)` returning `{ format: "image/png", width: 1, height: 1, fileSize: PNG_1X1.byteLength }` from `inspectImage` and `PNG_1X1` from `toWebp`. Every other assertion in the task is unchanged; only the transform itself becomes a deploy-gate item rather than a test one — **add it to the deploy gate in Task 20 if you take this path.**

- [ ] **Step 2: Write the failing test** (`apps/api/test/media.test.ts`). The auth-shaped assertions are covered structurally by `route-protection.test.ts`; this file is about the pipeline:

  ```ts
  import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
  import { beforeAll, describe, expect, it } from "vitest";

  import worker from "../src";
  import { MAX_UPLOAD_BYTES } from "../src/routes/media";
  import { oversizeBytes, PNG_1X1, SVG_BYTES, TEXT_BYTES } from "./fixtures/images";

  const ALLOWED_ORIGIN = "http://localhost:8787";

  /** A verified user + a session cookie + its CSRF token. */
  interface Actor { userId: string; cookie: string; csrfToken: string }
  let actor: Actor;

  async function fetchWorker(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  /**
   * Signs up, verifies via the gated __test token route, and returns the actor.
   * Uses the REAL routes end to end — the same reason test/soft-gate.test.ts does.
   */
  async function createVerifiedActor(): Promise<Actor> { /* see Step 3 */ }

  function upload(body: BodyInit, actor: Actor): Request {
    return new Request("https://api.test/media", {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken },
      body,
    });
  }

  beforeAll(async () => {
    actor = await createVerifiedActor();
  });

  describe("the happy path", () => {
    it("stores a content-addressed WebP and returns a CDN URL", async () => {
      const response = await fetchWorker(upload(PNG_1X1, actor));
      expect(response.status).toBe(201);

      const body = (await response.json()) as { id: string; url: string; width: number; height: number; bytes: number };
      // Content-addressed on the OUTPUT hash, with NO user id in the path:
      // content addressing dedupes across users; ownership belongs in Postgres.
      expect(body.url).toMatch(/^https:\/\/cdn\.thinkersjournal\.com\/media\/post\/[0-9a-f]{64}\.webp$/);
      expect(body.id[14]).toBe("7"); // uuidv7 PK

      const key = new URL(body.url).pathname.slice(1);
      const stored = await env.MEDIA.get(key);
      expect(stored, "the R2 object named by the returned URL does not exist").not.toBeNull();
      expect(stored!.httpMetadata?.contentType).toBe("image/webp");
      // Immutable: the key IS the hash, so the bytes can never change under it.
      expect(stored!.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
    });

    it("writes a media row owned by the SESSION's user, not the request", async () => {
      const response = await fetchWorker(upload(PNG_1X1, actor));
      const { id } = (await response.json()) as { id: string };
      const ctx = createExecutionContext();
      const { rows } = await (await import("../src/db/client")).withClient(
        env.HYPERDRIVE_FRESH, ctx, (c) => c.query("SELECT owner_id FROM media WHERE id = $1", [id]),
      );
      await waitOnExecutionContext(ctx);
      expect(rows[0]!.owner_id).toBe(actor.userId);
    });

    it("DEDUPES: the same image twice yields one R2 key and TWO rows", async () => {
      const a = (await (await fetchWorker(upload(PNG_1X1, actor))).json()) as { id: string; url: string };
      const b = (await (await fetchWorker(upload(PNG_1X1, actor))).json()) as { id: string; url: string };
      expect(b.url).toBe(a.url);
      expect(b.id).not.toBe(a.id);
    });
  });

  describe("the allowlist is the SVG defense", () => {
    it("rejects an SVG with 415", async () => {
      // ⚠️ The Images binding would ACCEPT this (SVG is a supported input; CF
      // sanitizes via svg-hush and passes it through). Only the sniff stops it.
      const response = await fetchWorker(upload(SVG_BYTES, actor));
      expect(response.status).toBe(415);
      expect(((await response.json()) as { code: string }).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("rejects arbitrary bytes with 415", async () => {
      expect((await fetchWorker(upload(TEXT_BYTES, actor))).status).toBe(415);
    });

    it("rejects an EMPTY body with 415", async () => {
      expect((await fetchWorker(upload(new Uint8Array(0), actor))).status).toBe(415);
    });

    it("ignores a LYING Content-Type", async () => {
      const request = new Request("https://api.test/media", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken,
          "content-type": "image/png", // the client says PNG; the bytes say SVG
        },
        body: SVG_BYTES,
      });
      // The bytes decide. Never the header, and never a filename.
      expect((await fetchWorker(request)).status).toBe(415);
    });
  });

  describe("the size cap is enforced while streaming", () => {
    it("rejects an oversize body with 413", async () => {
      const response = await fetchWorker(upload(oversizeBytes(MAX_UPLOAD_BYTES), actor));
      expect(response.status).toBe(413);
      expect(((await response.json()) as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("does NOT trust Content-Length", async () => {
      // A lying (small) Content-Length must not buy a large body through: the cap
      // is counted from the bytes actually read.
      const request = new Request("https://api.test/media", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken,
          "content-length": "10",
        },
        body: oversizeBytes(MAX_UPLOAD_BYTES),
      });
      expect((await fetchWorker(request)).status).toBe(413);
    });
  });

  describe("quota", () => {
    it("rejects an upload once the owner is over quota, BEFORE transforming", async () => {
      // Seed the quota directly — synthesising 100MB of real uploads would test
      // the test harness, not the route.
      const ctx = createExecutionContext();
      const { withClient } = await import("../src/db/client");
      const { MEDIA_QUOTA_BYTES } = await import("../src/routes/media");
      await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        c.query(
          "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,'seed','seed',$2,1,1)",
          [actor.userId, MEDIA_QUOTA_BYTES],
        ),
      );
      await waitOnExecutionContext(ctx);

      const response = await fetchWorker(upload(PNG_1X1, actor));
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("QUOTA_EXCEEDED");
    });
  });
  ```

- [ ] **Step 3: Write the actor helper.** Add to `apps/api/test/media.test.ts` (it is the same shape M0's `soft-gate.test.ts` already uses — reuse that file's version verbatim if it exports one):

  ```ts
  async function createVerifiedActor(): Promise<Actor> {
    const email = `media-${crypto.randomUUID()}@example.com`;
    const signup = await fetchWorker(
      new Request("https://api.test/auth/signup", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery-staple", turnstileToken: "dummy" }),
      }),
    );
    const { userId } = (await signup.json()) as { userId: string };
    const cookie = signup.headers.getSetCookie()[0]!.split(";")[0]!;

    // The gated __test route stands in for the inbox (TEST_ROUTES=1 in vitest).
    const token = await (await fetchWorker(new Request("https://api.test/__test/last-verify-token"))).text();
    await fetchWorker(
      new Request(`https://api.test/verify-email?token=${encodeURIComponent(token)}`, { headers: { Cookie: cookie } }),
    );

    const csrf = await fetchWorker(new Request("https://api.test/auth/csrf", { headers: { Cookie: cookie } }));
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    return { userId, cookie, csrfToken };
  }
  ```

- [ ] **Step 4: Run → FAIL.** `pnpm --filter @thinkersjournal/api test media` → 404 (no route yet).
- [ ] **Step 5: Implement the streaming cap** (`apps/api/src/media/body.ts`):

  ```ts
  /**
   * Body helpers for the media upload path.
   *
   * ⚠️ NEVER TRUST Content-Length. It is client-supplied; the cap must be counted
   * from the bytes actually read, and the read must STOP at the limit rather than
   * discovering it afterwards. `request.arrayBuffer()` / `request.formData()`
   * cannot do that — they buffer first and let you check second, which on a
   * 128MB-memory Worker is the whole problem.
   */

  /**
   * Read `body` into memory, aborting at `limit` bytes. Returns null when the
   * body exceeds the limit (callers MUST turn that into a 413).
   */
  export async function readCappedBody(
    body: ReadableStream<Uint8Array> | null,
    limit: number,
  ): Promise<Uint8Array | null> {
    if (body === null) return new Uint8Array(0);

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          // Cancel rather than drain: there is no reason to keep pulling bytes we
          // have already decided to reject.
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /**
   * A one-shot stream over `bytes`, for the Images binding (which takes streams).
   *
   * ⚠️ A ReadableStream can only be consumed ONCE, and the pipeline needs the
   * bytes TWICE (info, then transform). Hence a fresh stream per call rather than
   * one shared stream — and hence `Response`, whose body is exactly this, with no
   * hand-rolled controller to get wrong.
   */
  export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new Response(bytes).body!;
  }

  /** Lowercase hex SHA-256 of raw bytes. (auth/encoding.ts's sha256Hex takes a string.) */
  export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  ```

- [ ] **Step 6: Implement the Images wrapper** (`apps/api/src/media/images.ts`):

  ```ts
  /**
   * The ONLY place `env.IMAGES` is touched. One module so the binding's surface is
   * in one place — and so a toolchain without a local Images simulation has a
   * single, honest seam to stub (see Task 8 Step 1's fallback).
   */
  import { streamOf } from "./body";

  export interface ImageFacts {
    /** A MIME type, e.g. "image/png" — comparable to sniffImageFormat's output. */
    format: string;
    width: number;
    height: number;
    fileSize: number;
  }

  /** ~50 megapixels. A 12KB PNG can decode to gigabytes; the byte cap does not bound this. */
  export const MAX_PIXELS = 50_000_000;

  /** FREE. Returns null when the binding cannot make sense of the bytes at all. */
  export async function inspectImage(env: Env, bytes: Uint8Array): Promise<ImageFacts | null> {
    try {
      const info = await env.IMAGES.info(streamOf(bytes));
      return info as ImageFacts;
    } catch {
      // A throw here means "not a decodable image" — a client error, not a 500.
      return null;
    }
  }

  /**
   * Transform to WebP.
   *
   * `fit: "scale-down"` NEVER upscales — a 100×100 avatar stays 100×100 rather
   * than being blown up to 2048.
   *
   * ⚠️ EXIF IS STRIPPED AUTOMATICALLY AND FREE: for non-JPEG output "all metadata
   * will always be discarded". No config, and none to forget. (Colour profile and
   * EXIF rotation are APPLIED first, so images are not sideways.)
   *
   * ⚠️ `.input()` caps at 20MB — a HARD ceiling. Our 15MB cap must be enforced
   * BEFORE we get here (src/routes/media.ts), or this throws.
   */
  export async function toWebp(env: Env, bytes: Uint8Array, maxEdge: number): Promise<Uint8Array> {
    const result = await env.IMAGES.input(streamOf(bytes))
      .transform({ width: maxEdge, height: maxEdge, fit: "scale-down" })
      // `format` is REQUIRED by .output().
      .output({ format: "image/webp", quality: 82 });
    return new Uint8Array(await result.response().arrayBuffer());
  }
  ```

- [ ] **Step 7: Implement the route** (`apps/api/src/routes/media.ts`):

  ```ts
  /**
   * `POST /media` — the upload pipeline. Raw image bytes in, a CDN URL out.
   *
   * ⚠️ RAW BODY, NOT MULTIPART — deliberate. `request.formData()` buffers the whole
   * body before a cap can be applied, and costs a multipart parser on a hostile-
   * byte path, to yield a filename and a Content-Type we ignore on principle. The
   * browser sends a File as a raw body natively (`fetch(url, { body: file })`), the
   * cap becomes a stream loop, and there is no parser.
   *
   * THE ORDER IS LOAD-BEARING — each step is cheaper than the one below it, and
   * each exists to stop the next from running on input that will be rejected:
   *   1. pipeline (origin -> session -> CSRF -> epoch -> verified -> rate limit)
   *   2. read the body WITH the cap  -> 413. Never trust Content-Length.
   *   3. magic-byte allowlist        -> 415. THE SVG DEFENSE.
   *   4. IMAGES.info() cross-check   -> 415. FREE; catches polyglots + pixel bombs.
   *   5. quota (FRESH)               -> 403. BEFORE paying for a transform.
   *   6. transform -> WebP           (EXIF auto-stripped)
   *   7. SHA-256 the OUTPUT
   *   8. R2 put, content-addressed on that hash
   *   9. media row (FRESH)
   *  10. 201 + the CDN URL. THE ORIGINAL IS DISCARDED — never persisted.
   */
  import { errorResponse } from "../http/errors";
  import { runMutatingPipeline } from "../auth/pipeline";
  import { withClient } from "../db/client";
  import { readCappedBody, sha256HexOf } from "../media/body";
  import { inspectImage, MAX_PIXELS, toWebp } from "../media/images";
  import { sniffImageFormat, SNIFF_HEADER_BYTES } from "../media/sniff";

  /**
   * 15MB. ⚠️ Two independent ceilings sit above this and BOTH must stay above it:
   *   • `IMAGES.input()` caps at 20MB — a HARD limit, it throws;
   *   • the request-body limit is set by the ZONE plan, NOT the Workers plan
   *     (Free/Pro 100MB, Business 200MB) — so 15MB is fine even on Free.
   */
  export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

  /** Per-user total of STORED (post-transform) bytes. */
  export const MEDIA_QUOTA_BYTES = 100 * 1024 * 1024;

  /** Longest edge of the stored variant. */
  const MAX_EDGE = 2048;

  /**
   * The public CDN origin. A module constant, not a var: it is not configuration,
   * and `vars` is a surface that can drift (the same reasoning as signup.ts's
   * CANONICAL_ORIGIN). ⚠️ NEVER derived from the request's Host header.
   */
  const MEDIA_CDN_ORIGIN = "https://cdn.thinkersjournal.com";

  /**
   * ⚠️ CONTENT-ADDRESSED ON THE OUTPUT, WITH NO USER ID IN THE PATH. Content
   * addressing dedupes across users; ownership belongs in Postgres, not the key.
   * See the DEDUPE/DELETION HAZARD note in migrations/0002.
   */
  function mediaKey(hash: string): string {
    return `media/post/${hash}.webp`;
  }

  export async function handleUploadMedia(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // ---- 1. Auth -------------------------------------------------------------
    const result = await runMutatingPipeline(request, env, ctx, {
      requireVerifiedEmail: true,
      // Keyed on the SESSION's user, not an IP: this quota-adjacent limiter
      // bounds a logged-in, verified account, and the session is the only
      // identity that means anything here.
      rateLimit: { limiter: env.MEDIA_LIMITER, key: `media:${(await peekUserId(env, request)) ?? "anon"}` },
    });
    if (result instanceof Response) return result;
    const { userId } = result.session;

    // ---- 2. Body, capped WHILE STREAMING -------------------------------------
    const bytes = await readCappedBody(request.body, MAX_UPLOAD_BYTES);
    if (bytes === null) {
      return errorResponse("PAYLOAD_TOO_LARGE", 413, {
        message: `Images must be ${MAX_UPLOAD_BYTES / 1024 / 1024}MB or smaller.`,
      });
    }

    // ---- 3. Magic-byte allowlist — THE SVG DEFENSE ---------------------------
    const sniffed = sniffImageFormat(bytes.subarray(0, SNIFF_HEADER_BYTES));
    if (sniffed === null) {
      // ⚠️ The message NEVER echoes the client's Content-Type or filename.
      return errorResponse("UNSUPPORTED_MEDIA_TYPE", 415, {
        message: "Images must be JPEG, PNG, GIF or WebP.",
      });
    }

    // ---- 4. Cross-check with the FREE .info() --------------------------------
    const facts = await inspectImage(env, bytes);
    if (facts === null || facts.format !== sniffed) {
      // A mismatch is a POLYGLOT: bytes that claim one format in their header and
      // decode as another. The sniff alone cannot see this; .info() is free, so
      // there is no reason not to.
      return errorResponse("UNSUPPORTED_MEDIA_TYPE", 415, {
        message: "Images must be JPEG, PNG, GIF or WebP.",
      });
    }
    if (facts.width * facts.height > MAX_PIXELS) {
      // A PIXEL BOMB: a few KB of PNG that decodes to gigabytes. The byte cap does
      // not bound this at all.
      return errorResponse("PAYLOAD_TOO_LARGE", 413, { message: "That image is too many pixels." });
    }

    // ---- 5. Quota — BEFORE paying for a transform ----------------------------
    // FRESH: this is a permission decision AND a read-after-write against the
    // user's own prior uploads.
    const used = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ used: string }>(
        "SELECT coalesce(sum(bytes), 0)::bigint AS used FROM media WHERE owner_id = $1",
        [userId],
      );
      // pg returns bigint as a STRING (it exceeds Number's safe range in general).
      return Number(rows[0]!.used);
    });
    if (used >= MEDIA_QUOTA_BYTES) {
      return errorResponse("QUOTA_EXCEEDED", 403, { message: "You have used all of your upload storage." });
    }

    // ---- 6. Transform (EXIF stripped automatically + free) -------------------
    const webp = await toWebp(env, bytes, MAX_EDGE);

    // ---- 7. Hash the OUTPUT --------------------------------------------------
    const hash = await sha256HexOf(webp);
    const key = mediaKey(hash);

    // ---- 8. R2 ----------------------------------------------------------------
    // Unconditional put: the key IS the content hash, so re-putting identical
    // bytes is idempotent, and a conditional put would cost a HEAD to save
    // nothing. `immutable` is honest for the same reason.
    await env.MEDIA.put(key, webp, {
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    // ---- 9. Row ---------------------------------------------------------------
    const stored = await inspectImage(env, webp);
    const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [userId, key, hash, webp.byteLength, stored?.width ?? facts.width, stored?.height ?? facts.height],
      );
      return rows[0]!.id;
    });

    // ---- 10. Done. THE ORIGINAL IS DISCARDED — it was never written anywhere. --
    return new Response(
      JSON.stringify({
        id,
        url: `${MEDIA_CDN_ORIGIN}/${key}`,
        width: stored?.width ?? facts.width,
        height: stored?.height ?? facts.height,
        bytes: webp.byteLength,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }
  ```

  ⚠️ The `rateLimit` key above needs the user id *before* the pipeline validates the session, which is circular. **Resolve it by moving the limiter out of the pipeline opts and calling it explicitly after auth** — delete `peekUserId` and the `rateLimit` option, and insert directly after the pipeline block:

  ```ts
    // Rate limit LAST among the checks, per src/auth/pipeline.ts's rule: quota is
    // spent only by a request otherwise fully entitled to proceed. Keyed on the
    // SESSION's user — the only identity that means anything for an authenticated
    // upload, and one an attacker cannot rotate the way they can an IP.
    const limited = await enforceRateLimit(env.MEDIA_LIMITER, `media:${userId}`);
    if (limited !== null) return limited;
  ```

  with `import { enforceRateLimit } from "../auth/ratelimit";`.

- [ ] **Step 8: Register the route** — in `apps/api/src/routes.ts` add `import { handleUploadMedia } from "./routes/media";` and:

  ```ts
    { method: "POST", pattern: "/media", handler: handleUploadMedia },
  ```

- [ ] **Step 9: Run → PASS.** `pnpm --filter @thinkersjournal/api test` → all green. ⚠️ **`route-protection.test.ts` now covers `POST /media` automatically** — it is in `ROUTES`, so its no-Origin→403 and no-session→401 assertions ran without anyone adding them. That is the design working.
- [ ] **Step 10: Commit.** `git add -A && git commit -m "feat(m1): POST /media — sniff, transform to WebP, content-addressed R2"`

### Task 9: Posts CRUD — the M0 stub becomes real

> **⚠️ NO CACHE PURGE IN THIS TASK — Task 14 wires it in, and that is not a
> deferral.** There is **no cache to purge until Task 12 creates one**, so a
> `purgeTags` call written here would be dead code invalidating a cache that does
> not exist. Purge-on-edit belongs where the cache does. These handlers are
> **complete and independently testable without it**: creating, editing and reading
> a post are the whole contract, and every test below passes standalone with no
> reference to `purgeTags`. Task 14 adds the two call sites and the tests that pin
> them.

**Files:** Create `apps/api/src/db/errors.ts`, `apps/api/src/util/random.ts`, `apps/api/src/routes/public.ts`, `packages/shared/src/posts.ts`, `apps/api/test/{posts.test.ts,public-reads.test.ts}`. Modify `apps/api/src/routes/posts.ts` (rewrite), `apps/api/src/routes/{signup,csrf}.ts`, `apps/api/src/auth/pipeline.ts`, `apps/api/src/routes.ts`, `packages/shared/src/index.ts`.

**Interfaces — Produces:**
- `CreatePostInput`, `UpdatePostInput`, `PostStatus`, and DTOs `PublicPost`, `PublicPostSummary`, `PublicProfile`, `AuthoredPost`, plus `MAX_CURSOR` from `@thinkersjournal/shared`.
- `isUniqueViolation(err: unknown): boolean` (`apps/api/src/db/errors.ts`), `randomSuffix(): string` (`apps/api/src/util/random.ts`), `slugify(title: string): string`.
- `readCurrentSession(env, request, onFailure): Promise<SessionData | Response>` (`apps/api/src/auth/pipeline.ts`).
- Routes: `POST /posts`, `PATCH /posts/:id`, `GET /posts/:id`, `GET /public/posts`, `GET /public/profile`, `GET /public/recent`.

- [ ] **Step 1: Define the wire types** (`packages/shared/src/posts.ts`):

  ```ts
  import { z } from "zod";

  export const PostStatus = z.enum(["draft", "published"]);
  export type PostStatusValue = z.infer<typeof PostStatus>;

  /** ~100k characters. Bounds the render cost and the row width. */
  const MARKDOWN_MAX = 100_000;

  export const CreatePostInput = z.object({
    title: z.string().trim().min(1).max(200),
    markdownSource: z.string().min(1).max(MARKDOWN_MAX),
    // Default draft: publishing must be an explicit act, never the fallback of a
    // client that omitted a field.
    status: PostStatus.default("draft"),
  });

  export const UpdatePostInput = z.object({
    title: z.string().trim().min(1).max(200),
    markdownSource: z.string().min(1).max(MARKDOWN_MAX),
    status: PostStatus,
  });

  /**
   * The first-page keyset sentinel: every uuid sorts below it.
   * `WHERE id < $cursor ORDER BY id DESC` then needs no special-casing — one query
   * serves page 1 and page N, so the two cannot drift apart.
   */
  export const MAX_CURSOR = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  /** A published post as served to an ANONYMOUS renderer. */
  export interface PublicPost {
    id: string;
    authorId: string;
    username: string;
    displayName: string | null;
    title: string;
    slug: string;
    /** Rendered by the WEB Worker at read time — never stored as HTML. */
    markdownSource: string;
    publishedAt: string;
    updatedAt: string;
  }

  export interface PublicPostSummary {
    id: string;
    title: string;
    slug: string;
    /** The first ~400 chars of markdown_source; the excerpt is derived from it. */
    excerptSource: string;
    publishedAt: string;
    updatedAt: string;
  }

  export interface PublicProfile {
    userId: string;
    username: string;
    displayName: string | null;
    bio: string | null;
    posts: PublicPostSummary[];
    /** The last id on this page, or null when there are no more. */
    nextCursor: string | null;
  }

  /** A post as served to its OWN author (drafts included). */
  export interface AuthoredPost {
    id: string;
    title: string;
    slug: string;
    markdownSource: string;
    status: PostStatusValue;
    publishedAt: string | null;
    updatedAt: string;
  }

  /** What `GET /public/recent` returns — the source for sitemap.xml + rss.xml. */
  export interface RecentPost extends PublicPostSummary {
    username: string;
  }
  ```

  Re-export from `packages/shared/src/index.ts`: `export * from "./posts";`

- [ ] **Step 2: Write the failing tests** (`apps/api/test/posts.test.ts`). Reuse `createVerifiedActor` from Task 8 by extracting it to `apps/api/test/actor.ts` and importing it in both files:

  ```ts
  describe("POST /posts", () => {
    it("creates a draft owned by the SESSION's user", async () => {
      const response = await createPost(actor, { title: "Hello world", markdownSource: "# hi" });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string; slug: string; status: string };
      expect(body.slug).toBe("hello-world");
      expect(body.status).toBe("draft");
      expect(body.id[14]).toBe("7");
    });

    it("NEVER takes author_id from the body", async () => {
      const victim = await createVerifiedActor();
      const response = await createPost(actor, {
        title: "Spoof", markdownSource: "x",
        // @ts-expect-error — deliberately sending a field the schema does not have
        authorId: victim.userId,
      });
      const { id } = (await response.json()) as { id: string };
      expect(await authorOf(id)).toBe(actor.userId);
    });

    it("publishes with a published_at when status=published", async () => {
      const response = await createPost(actor, { title: "Live", markdownSource: "x", status: "published" });
      const { id } = (await response.json()) as { id: string };
      const row = await postRow(id);
      expect(row.status).toBe("published");
      expect(row.published_at).not.toBeNull();
    });

    it("uniquifies a slug that collides for the SAME author", async () => {
      await createPost(actor, { title: "Same Title", markdownSource: "a" });
      const second = await createPost(actor, { title: "Same Title", markdownSource: "b" });
      const { slug } = (await second.json()) as { slug: string };
      expect(slug).toMatch(/^same-title-[a-z0-9]+$/);
    });

    it("lets a DIFFERENT author keep the same slug", async () => {
      const other = await createVerifiedActor();
      await createPost(actor, { title: "Shared Title", markdownSource: "a" });
      const second = await createPost(other, { title: "Shared Title", markdownSource: "b" });
      expect(((await second.json()) as { slug: string }).slug).toBe("shared-title");
    });

    it.each([
      ["an empty title", { title: "", markdownSource: "x" }],
      ["an empty body", { title: "t", markdownSource: "" }],
      ["an over-long title", { title: "a".repeat(201), markdownSource: "x" }],
      ["an unknown status", { title: "t", markdownSource: "x", status: "deleted" }],
    ])("400s on %s", async (_name, payload) => {
      const response = await createPost(actor, payload as never);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    });

    it("403s for an UNVERIFIED author (the soft gate)", async () => {
      const unverified = await createUnverifiedActor();
      const response = await createPost(unverified, { title: "t", markdownSource: "x" });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
    });
  });

  describe("PATCH /posts/:id", () => {
    it("edits the author's own post and bumps updated_at", async () => {
      const { id } = await create(actor, { title: "Before", markdownSource: "a" });
      const before = await postRow(id);
      const response = await patchPost(actor, id, { title: "After", markdownSource: "b", status: "published" });
      expect(response.status).toBe(200);
      const after = await postRow(id);
      expect(after.title).toBe("After");
      expect(after.published_at).not.toBeNull();
      expect(after.updated_at > before.updated_at).toBe(true);
    });

    it("404s on ANOTHER author's post — never 403", async () => {
      const { id } = await create(actor, { title: "Mine", markdownSource: "a" });
      const attacker = await createVerifiedActor();
      const response = await patchPost(attacker, id, { title: "Yours", markdownSource: "b", status: "published" });
      // ⚠️ 404, not 403: a 403 would confirm the id names a real post. Ownership is
      // enforced IN the UPDATE's WHERE clause, so there is no check to race.
      expect(response.status).toBe(404);
      expect((await postRow(id)).title).toBe("Mine");
    });

    it("404s on a well-formed but unknown id", async () => {
      const response = await patchPost(actor, "00000000-0000-7000-8000-000000000000", {
        title: "x", markdownSource: "y", status: "draft",
      });
      expect(response.status).toBe(404);
    });

    it("does NOT change the slug when the title changes", async () => {
      const { id, slug } = await create(actor, { title: "Original Title", markdownSource: "a" });
      await patchPost(actor, id, { title: "Completely New", markdownSource: "a", status: "published" });
      // A published URL is a promise. Re-slugging on edit would 404 every inbound
      // link and every cached copy at once.
      expect((await postRow(id)).slug).toBe(slug);
    });

    it("keeps the ORIGINAL published_at across re-publishes", async () => {
      const { id } = await create(actor, { title: "P", markdownSource: "a", status: "published" });
      const first = (await postRow(id)).published_at;
      await patchPost(actor, id, { title: "P", markdownSource: "b", status: "published" });
      expect((await postRow(id)).published_at).toEqual(first);
    });
  });

  describe("GET /posts/:id (the author's own draft)", () => {
    it("returns the author's own draft", async () => {
      const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
      const response = await getPost(actor, id);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { markdownSource: string }).markdownSource).toBe("secret");
    });

    it("404s another author's draft", async () => {
      const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
      expect((await getPost(await createVerifiedActor(), id)).status).toBe(404);
    });

    it("401s with no session", async () => {
      const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
      expect((await fetchWorker(new Request(`https://api.test/posts/${id}`))).status).toBe(401);
    });
  });
  ```

  And `apps/api/test/public-reads.test.ts`:

  ```ts
  describe("GET /public/posts", () => {
    it("returns a published post by username + slug", async () => {
      const { slug } = await create(actor, { title: "Public One", markdownSource: "# body", status: "published" });
      const response = await fetchWorker(
        new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`),
      );
      expect(response.status).toBe(200);
      const post = (await response.json()) as PublicPost;
      expect(post.markdownSource).toBe("# body");
      expect(post.username).toBe(actor.username);
    });

    it("404s a DRAFT — anonymously and for its own author alike", async () => {
      const { slug } = await create(actor, { title: "Hidden", markdownSource: "x" });
      const anon = await fetchWorker(new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`));
      expect(anon.status).toBe(404);
      // ⚠️ Even WITH the author's own cookie. This route is what the edge caches;
      // if it could ever vary by viewer, one author's draft would be cached and
      // served to the world. It must be viewer-INDEPENDENT by construction.
      const authed = await fetchWorker(
        new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`, {
          headers: { Cookie: actor.cookie },
        }),
      );
      expect(authed.status).toBe(404);
    });

    it("404s a missing username or slug", async () => {
      expect((await fetchWorker(new Request("https://api.test/public/posts?username=nobody&slug=x"))).status).toBe(404);
      expect((await fetchWorker(new Request("https://api.test/public/posts"))).status).toBe(404);
    });

    it("matches the slug case-insensitively (citext)", async () => {
      const { slug } = await create(actor, { title: "Case Test", markdownSource: "x", status: "published" });
      const response = await fetchWorker(
        new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug.toUpperCase()}`),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("GET /public/profile", () => {
    it("paginates newest-first by keyset", async () => {
      const author = await createVerifiedActor();
      for (let i = 0; i < 25; i++) {
        await create(author, { title: `Post ${i}`, markdownSource: "x", status: "published" });
      }
      const first = (await (await fetchWorker(
        new Request(`https://api.test/public/profile?username=${author.username}`),
      )).json()) as PublicProfile;
      expect(first.posts).toHaveLength(20);
      expect(first.posts[0]!.title).toBe("Post 24");
      expect(first.nextCursor).toBe(first.posts[19]!.id);

      const second = (await (await fetchWorker(
        new Request(`https://api.test/public/profile?username=${author.username}&cursor=${first.nextCursor}`),
      )).json()) as PublicProfile;
      expect(second.posts).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      // No overlap and no gap — the property keyset pagination exists to give.
      expect(new Set([...first.posts, ...second.posts].map((p) => p.id)).size).toBe(25);
    });

    it("excludes drafts", async () => {
      const author = await createVerifiedActor();
      await create(author, { title: "Draft", markdownSource: "x" });
      await create(author, { title: "Live", markdownSource: "x", status: "published" });
      const profile = (await (await fetchWorker(
        new Request(`https://api.test/public/profile?username=${author.username}`),
      )).json()) as PublicProfile;
      expect(profile.posts.map((p) => p.title)).toEqual(["Live"]);
    });

    it("404s an unknown username", async () => {
      expect((await fetchWorker(new Request("https://api.test/public/profile?username=nobody"))).status).toBe(404);
    });

    it("400s a malformed cursor rather than 500ing", async () => {
      const response = await fetchWorker(
        new Request(`https://api.test/public/profile?username=${actor.username}&cursor=not-a-uuid`),
      );
      // `id < 'not-a-uuid'` is a Postgres 22P02 cast error -> a 500 without this.
      expect(response.status).toBe(400);
    });
  });
  ```

- [ ] **Step 3: Run → FAIL.** `pnpm --filter @thinkersjournal/api test posts public-reads` → 404s everywhere.
- [ ] **Step 4: Extract the two helpers signup already owns.** Create `apps/api/src/db/errors.ts`:

  ```ts
  /** Postgres SQLSTATE for `unique_violation`. */
  const UNIQUE_VIOLATION = "23505";

  /**
   * Whether `err` is a Postgres unique-constraint violation.
   *
   * Shared because the transaction-mode pooler makes "INSERT and handle 23505" the
   * ONLY correct way to place a unique value (src/routes/signup.ts's username,
   * src/routes/posts.ts's slug) — a SELECT-then-INSERT check is a race by
   * construction. One definition so the two cannot drift.
   */
  export function isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === UNIQUE_VIOLATION
    );
  }

  /** Postgres SQLSTATE for `invalid_text_representation` (e.g. a bad uuid cast). */
  const INVALID_TEXT_REPRESENTATION = "22P02";

  /**
   * Whether `err` is Postgres refusing to cast a value — which for us always means
   * a malformed client-supplied id/cursor reached a query. That is a 400, never a
   * 500: `WHERE id < 'not-a-uuid'` throws before it can match nothing.
   */
  export function isInvalidTextRepresentation(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === INVALID_TEXT_REPRESENTATION
    );
  }
  ```

  Create `apps/api/src/util/random.ts`:

  ```ts
  /** A ~64-bit random value in base36 — the uniqueness half of a generated name. */
  export function randomSuffix(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
    return value.toString(36);
  }
  ```

  In `apps/api/src/routes/signup.ts`: delete the local `UNIQUE_VIOLATION`, `isUniqueViolation` and `randomSuffix`, and import them (`import { isUniqueViolation } from "../db/errors";`, `import { randomSuffix } from "../util/random";`). Behaviour unchanged; `pnpm --filter @thinkersjournal/api test signup` must stay green.

- [ ] **Step 5: Add `readCurrentSession` to the pipeline** — `apps/api/src/auth/pipeline.ts`:

  ```ts
  /**
   * The GET-side counterpart to `runMutatingPipeline`: resolve an authenticated,
   * UNREVOKED session, or the `Response` to return verbatim.
   *
   * No Origin and no CSRF check — `checkOrigin`/`checkCsrf` pass GET/HEAD by
   * design (src/auth/csrf.ts), so running them here would be theatre. What a
   * session-bearing GET DOES owe is the epoch check: `readSession` ALONE IS NOT
   * ENOUGH, because a session's KV record outlives revocation — that is exactly
   * what makes revocation O(1). See src/routes/csrf.ts's note.
   *
   * `onFailure` is the CALLER's response factory rather than a fixed body: the
   * routes here answer LOGIN_REQUIRED and the pipeline answers UNAUTHORIZED, and
   * both are wire contracts the web app branches on. Passing it in is what lets
   * this be one implementation instead of a third hand-rolled copy of the same
   * three steps.
   *
   * ⚠️ `GET /verify-email` deliberately does NOT use this: it must resolve the
   * token's owner BETWEEN the session read and the epoch check (the token is what
   * says who is being verified), so its three steps are interleaved rather than
   * sequential. See that file's header.
   */
  export async function readCurrentSession(
    env: Env,
    request: Request,
    onFailure: (extraHeaders?: Record<string, string>) => Response,
  ): Promise<SessionData | Response> {
    const session = await readSession(env, request);
    if (session === null) return onFailure();

    const currentEpoch = await env.USER_SECURITY.getByName(session.userId).getEpoch();
    if (currentEpoch !== session.securityEpoch) {
      // Destroy rather than merely reject: the KV record is dead server-side from
      // here, and the cleared cookie stops the browser replaying a dead token.
      const { cookie } = await destroySession(env, request);
      return onFailure({ "Set-Cookie": cookie });
    }
    return session;
  }
  ```

  Then simplify `apps/api/src/routes/csrf.ts`'s `handleCsrf` to use it — **keeping `loginRequired` and its entire doc-comment**, which is now passed as `onFailure`:

  ```ts
  export async function handleCsrf(request: Request, env: Env): Promise<Response> {
    const session = await readCurrentSession(env, request, loginRequired);
    if (session instanceof Response) return session;
    return new Response(JSON.stringify({ csrfToken: await csrfTokenFor(session) }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  ```

  Move the long "readSession ALONE IS NOT ENOUGH" comment from `handleCsrf`'s body onto `readCurrentSession` (above) and leave a one-line pointer at the call site. `pnpm --filter @thinkersjournal/api test csrf-route` must stay green.

- [ ] **Step 6: Implement `apps/api/src/routes/posts.ts`** (a rewrite — the M0 header describing stubs goes):

  ```ts
  /**
   * Post authoring routes. The M0 stub is gone; the auth around it is unchanged.
   *
   *   POST  /posts      — create (draft or published)
   *   PATCH /posts/:id  — edit
   *   GET   /posts/:id  — the AUTHOR's own post, drafts included
   *
   * All three are AUTHOR-facing. Anonymous reads live in src/routes/public.ts.
   *
   * ⚠️ EVERY DB ACCESS HERE USES HYPERDRIVE_FRESH — including the reads. These are
   * permission decisions and read-after-write against the author's own writes, and
   * Hyperdrive never invalidates on write.
   *
   * ⚠️ OWNERSHIP IS ENFORCED IN THE `WHERE` CLAUSE, never by a preceding SELECT.
   * The transaction-mode pooler means a check-then-act is a race by construction;
   * `WHERE id = $1 AND author_id = $2` returning zero rows is the check, atomically.
   * Zero rows is a 404 — NEVER a 403, which would confirm the id names a real post.
   *
   * ⚠️ NO CACHE PURGE HERE YET — Task 14 wires it in. There is no cache to purge
   * until Task 12 creates one, so a purge call written here would be dead code
   * against a cache that does not exist. See this task's preamble.
   */
  import { CreatePostInput, UpdatePostInput } from "@thinkersjournal/shared";

  import { runMutatingPipeline, readCurrentSession } from "../auth/pipeline";
  import { withClient } from "../db/client";
  import { isUniqueViolation } from "../db/errors";
  import { errorResponse } from "../http/errors";
  import { randomSuffix } from "../util/random";

  import type { RouteParams } from "../routing";
  import type { AuthoredPost } from "@thinkersjournal/shared";
  import type { Client } from "pg";

  /** Attempts to place a unique slug before giving up. */
  const SLUG_ATTEMPTS = 3;
  const SLUG_BASE_MAX = 60;

  /**
   * A URL-safe slug from a title.
   *
   * NFKD + combining-mark strip folds accents rather than dropping them ("Café" ->
   * "cafe", not "caf"). Everything outside [a-z0-9] collapses to a single hyphen.
   * A title that is entirely non-Latin sanitizes to "" and falls back to "post",
   * whose uniqueness then comes entirely from the suffix retry below.
   */
  export function slugify(title: string): string {
    const base = title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_BASE_MAX)
      .replace(/-+$/, "");
    return base === "" ? "post" : base;
  }

  function loginRequired(extraHeaders: Record<string, string> = {}): Response {
    return errorResponse("LOGIN_REQUIRED", 401, { headers: extraHeaders });
  }

  /** The one 404 for "no such post, or not yours" — deliberately not two answers. */
  function notFound(): Response {
    return errorResponse("NOT_FOUND", 404);
  }

  interface InsertedPost { id: string; slug: string }

  /**
   * INSERT the post, retrying with a suffixed slug on a `posts_author_slug_key`
   * violation.
   *
   * No SAVEPOINT (unlike signup's profile insert): this is a SINGLE statement with
   * no enclosing transaction, so a failure poisons nothing and the retry is just a
   * retry. Only a unique violation is retried; anything else propagates.
   */
  async function insertPost(
    client: Client,
    authorId: string,
    title: string,
    markdownSource: string,
    status: string,
  ): Promise<InsertedPost | null> {
    const base = slugify(title);
    for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 1 ? base : `${base}-${randomSuffix()}`;
      try {
        const { rows } = await client.query<InsertedPost>(
          `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'published' THEN now() ELSE NULL END)
           RETURNING id, slug`,
          [authorId, title, slug, markdownSource, status],
        );
        return rows[0]!;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === SLUG_ATTEMPTS) throw err;
      }
    }
    return null;
  }

  export async function handleCreatePost(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
    if (result instanceof Response) return result;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", 400);
    }
    const parsed = CreatePostInput.safeParse(raw);
    if (!parsed.success) {
      // FIELD NAMES only — never the submitted values.
      return errorResponse("INVALID_INPUT", 400, {
        fields: parsed.error.issues.map((i) => i.path.map(String).join(".")),
      });
    }
    const { title, markdownSource, status } = parsed.data;

    // ⚠️ author_id comes from the PIPELINE's validated session, NEVER the body —
    // which a caller controls. `CreatePostInput` has no authorId field at all, so
    // this is unrepresentable rather than merely unused.
    const authorId = result.session.userId;

    let inserted: InsertedPost | null;
    try {
      inserted = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        insertPost(c, authorId, title, markdownSource, status),
      );
    } catch (err) {
      if (isUniqueViolation(err)) return errorResponse("SLUG_TAKEN", 409);
      throw err;
    }
    if (inserted === null) return errorResponse("SLUG_TAKEN", 409);

    // Task 14 adds the cache purge here (publishing changes what a LISTING shows).
    // Not now: no cache exists until Task 12.

    return new Response(JSON.stringify({ id: inserted.id, slug: inserted.slug, status }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  export async function handleUpdatePost(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    params: RouteParams,
  ): Promise<Response> {
    const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
    if (result instanceof Response) return result;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", 400);
    }
    const parsed = UpdatePostInput.safeParse(raw);
    if (!parsed.success) {
      return errorResponse("INVALID_INPUT", 400, {
        fields: parsed.error.issues.map((i) => i.path.map(String).join(".")),
      });
    }
    const { title, markdownSource, status } = parsed.data;
    const authorId = result.session.userId;

    let updated: { id: string; slug: string } | null;
    try {
      updated = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
        const { rows } = await c.query<{ id: string; slug: string }>(
          `UPDATE posts
              SET title = $1,
                  markdown_source = $2,
                  status = $3,
                  -- FIRST publication only: coalesce keeps the original date across
                  -- every later edit, so re-publishing does not rewrite history (or
                  -- re-order the author's own listing under them).
                  published_at = CASE WHEN $3 = 'published' THEN coalesce(published_at, now()) ELSE published_at END,
                  updated_at = now()
            -- ⚠️ OWNERSHIP IS THIS LINE. Not a preceding SELECT: under a
            -- transaction-mode pooler a check-then-act is a race by construction.
            WHERE id = $4 AND author_id = $5
        RETURNING id, slug`,
          [title, markdownSource, status, params.id, authorId],
        );
        return rows[0] ?? null;
      });
    } catch (err) {
      // A well-formed-looking but uncastable id is a 404, not a 500.
      if ((err as { code?: string }).code === "22P02") return notFound();
      throw err;
    }
    // ⚠️ Zero rows means "no such post" OR "not yours" — answered identically.
    if (updated === null) return notFound();

    // Task 14 adds the cache purge here — this is THE call site the whole purge hop
    // exists for. Not now: no cache exists until Task 12.

    return new Response(JSON.stringify({ id: updated.id, slug: updated.slug, status }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  export async function handleGetPost(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    params: RouteParams,
  ): Promise<Response> {
    const session = await readCurrentSession(env, request, loginRequired);
    if (session instanceof Response) return session;

    let post: AuthoredPost | null;
    try {
      post = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
        const { rows } = await c.query(
          `SELECT id, title, slug, markdown_source AS "markdownSource", status,
                  published_at AS "publishedAt", updated_at AS "updatedAt"
             FROM posts WHERE id = $1 AND author_id = $2`,
          [params.id, session.userId],
        );
        return (rows[0] ?? null) as AuthoredPost | null;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") return notFound();
      throw err;
    }
    if (post === null) return notFound();

    return new Response(JSON.stringify(post), {
      status: 200,
      // Per-author and includes unpublished text: never let a shared cache hold it.
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  ```

  ⚠️ **Delete `handleListPosts` and its `GET /posts` route.** It was an M0 stub returning `{posts: []}`; the real public listing is `GET /public/profile`. Leaving a route that lies is worse than having none. Update `route-protection.test.ts`'s `SANITY_ROUTES` if it still names `/posts` — replace with `/public/recent`.

- [ ] **Step 7: Implement the anonymous reads** (`apps/api/src/routes/public.ts`):

  ```ts
  /**
   * ANONYMOUS public reads — the only api routes the `web` Worker calls WITHOUT
   * forwarding the browser's cookie, and the ones whose output the edge caches.
   *
   * ⚠️ THESE MUST BE VIEWER-INDEPENDENT BY CONSTRUCTION. Cookie is NOT in the
   * Workers Cache key and does NOT trigger bypass, so any per-viewer variance here
   * becomes content cached under one viewer's identity and served to everyone. No
   * route in this file reads a session, and test/public-reads.test.ts pins that a
   * draft 404s even for its OWN author.
   *
   * ⚠️ HYPERDRIVE BINDING CHOICE — read the amended Global Constraint.
   *   • /public/posts and /public/profile use FRESH. Their edge entries are
   *     PURGE-invalidated, so the first render after a purge is a read-after-write:
   *     a CACHED read there could serve a pre-edit row (Hyperdrive never
   *     invalidates on write) which the edge would then re-cache for up to 25h.
   *     And behind a 3600s edge TTL a 60s query cache hits ~never, so it would buy
   *     nothing for that hazard.
   *   • /public/recent uses CACHED. It is untagged and TTL-only (60s edge), so
   *     Hyperdrive's 60s window is a subset of staleness already accepted, and its
   *     REGIONAL cache genuinely serves several PoPs inside one window.
   */
  import { MAX_CURSOR } from "@thinkersjournal/shared";

  import { withClient } from "../db/client";
  import { isInvalidTextRepresentation } from "../db/errors";
  import { errorResponse } from "../http/errors";

  import type { PublicPost, PublicProfile, PublicPostSummary, RecentPost } from "@thinkersjournal/shared";

  const PAGE_SIZE = 20;
  /** Bounded because sitemap/RSS consume this; real pagination is M2. */
  const RECENT_MAX = 1000;
  /** Enough for an excerpt; bounds the listing payload. */
  const EXCERPT_SOURCE_CHARS = 400;

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function notFound(): Response {
    return errorResponse("NOT_FOUND", 404);
  }

  export async function handlePublicPost(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const username = url.searchParams.get("username");
    const slug = url.searchParams.get("slug");
    if (username === null || slug === null) return notFound();

    const post = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.author_id AS "authorId", pr.username, pr.display_name AS "displayName",
                p.title, p.slug, p.markdown_source AS "markdownSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt"
           FROM posts p
           JOIN profiles pr ON pr.user_id = p.author_id
          WHERE pr.username = $1 AND p.slug = $2 AND p.status = 'published'`,
        [username, slug],
      );
      return (rows[0] ?? null) as PublicPost | null;
    });
    // ⚠️ `status = 'published'` is IN the query, not a filter afterwards: a draft
    // must be indistinguishable from a nonexistent post to everyone, its author
    // included (see the file header).
    return post === null ? notFound() : json(post);
  }

  export async function handlePublicProfile(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const username = url.searchParams.get("username");
    if (username === null) return notFound();
    // The all-f sentinel: every uuid sorts below it, so ONE query serves page 1
    // and page N and the two cannot drift apart.
    const cursor = url.searchParams.get("cursor") ?? MAX_CURSOR;

    try {
      const profile = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
        const { rows: owner } = await c.query<{ userId: string; username: string; displayName: string | null; bio: string | null }>(
          `SELECT user_id AS "userId", username, display_name AS "displayName", bio
             FROM profiles WHERE username = $1`,
          [username],
        );
        if (owner[0] === undefined) return null;

        const { rows: posts } = await c.query(
          `SELECT id, title, slug,
                  left(markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                  published_at AS "publishedAt", updated_at AS "updatedAt"
             FROM posts
            WHERE author_id = $1 AND status = 'published' AND id < $2
            -- v7 ids are time-ordered, so this IS newest-first. No created_at
            -- index exists, and none is needed. Served by posts_author_published_key.
            ORDER BY id DESC
            LIMIT ${PAGE_SIZE}`,
          [owner[0].userId, cursor],
        );

        const page = posts as PublicPostSummary[];
        return {
          ...owner[0],
          posts: page,
          // null when this page was short — i.e. there is no next page to ask for.
          nextCursor: page.length === PAGE_SIZE ? page[page.length - 1]!.id : null,
        } satisfies PublicProfile;
      });
      return profile === null ? notFound() : json(profile);
    } catch (err) {
      // `id < 'not-a-uuid'` throws 22P02. A malformed cursor is the client's error.
      if (isInvalidTextRepresentation(err)) return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
      throw err;
    }
  }

  export async function handlePublicRecent(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? RECENT_MAX);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), RECENT_MAX) : RECENT_MAX;

    // ⚠️ HYPERDRIVE_CACHED — the one place in M1 it is correct. See the file header.
    const posts = await withClient(env.HYPERDRIVE_CACHED, ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.title, p.slug, pr.username,
                left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt"
           FROM posts p
           JOIN profiles pr ON pr.user_id = p.author_id
          WHERE p.status = 'published'
          ORDER BY p.id DESC
          LIMIT $1`,
        [limit],
      );
      return rows as RecentPost[];
    });
    return json({ posts });
  }
  ```

- [ ] **Step 8: Register the routes** — `apps/api/src/routes.ts`:

  ```ts
    { method: "POST", pattern: "/posts", handler: handleCreatePost },
    { method: "PATCH", pattern: "/posts/:id", handler: handleUpdatePost },
    { method: "GET", pattern: "/posts/:id", handler: handleGetPost },

    // ANONYMOUS reads — what the edge caches. See src/routes/public.ts's header:
    // no session is read here, by construction.
    { method: "GET", pattern: "/public/posts", handler: handlePublicPost },
    { method: "GET", pattern: "/public/profile", handler: handlePublicProfile },
    { method: "GET", pattern: "/public/recent", handler: handlePublicRecent },
  ```

  ⚠️ **`PATCH /posts/:id` is now in `MUTATING`** — `route-protection.test.ts` probes it with `PARAM_SAMPLES.id` and asserts no-Origin→403 + no-session→401 **automatically**. That is the whole reason Task 3 came first.

- [ ] **Step 9: Run → PASS.** `pnpm --filter @thinkersjournal/api test` → all green. `pnpm typecheck` → exit 0.
- [ ] **Step 10: Commit.** `git add -A && git commit -m "feat(m1): posts CRUD + anonymous public reads"`

### Task 10: `POST /auth/resend-verification`

> **M0 carry-over, and M1 is what makes it load-bearing.** Posting now **requires** a verified email, and today a lost verification mail has **no recourse whatsoever**: `GET /verify-email`'s own header admits *"there is no resend endpoint until M1"*, and Postmark sends fail **silently by design** (`sendVerificationEmail` never throws, so a signup cannot 500 on a mail outage). Until this exists, one dropped email is a permanently unusable account.
>
> The only other route to recovery is re-signup — which works (it takes over the unverified row) but requires the user to re-enter a password and understand that signing up again is the fix. That is not a recovery flow.

**Files:** Create `apps/api/src/routes/resend-verification.ts`, `apps/api/test/resend-verification.test.ts`. Modify `apps/api/src/routes.ts`, `apps/api/wrangler.jsonc`.

**Interfaces — Produces:** `POST /auth/resend-verification` → `202` (no body). Binding `RESEND_LIMITER`.

- [ ] **Step 1: Add the limiter.** In `apps/api/wrangler.jsonc`'s `ratelimits`:

  ```jsonc
      {
        "name": "RESEND_LIMITER",
        "namespace_id": "1004",
        "simple": { "limit": 3, "period": 60 }
      }
  ```

  Then `pnpm --filter @thinkersjournal/api exec wrangler types` and commit the regenerated types.

- [ ] **Step 2: Write the failing test** (`apps/api/test/resend-verification.test.ts`):

  ```ts
  describe("POST /auth/resend-verification", () => {
    it("202s for an unverified session and mints a NEW usable token", async () => {
      const actor = await createUnverifiedActor();
      const first = await lastVerifyToken();

      const response = await resend(actor);
      expect(response.status).toBe(202);

      const second = await lastVerifyToken();
      expect(second).not.toBe(first);

      // The new token must actually verify — a resend that mints a dead token is
      // worse than no resend at all.
      const verify = await fetchWorker(
        new Request(`https://api.test/verify-email?token=${encodeURIComponent(second)}`, {
          headers: { Cookie: actor.cookie },
        }),
      );
      expect(verify.status).toBe(200);
    });

    it("does NOT invalidate the previous token", async () => {
      // The user may still click the FIRST email — that is the likeliest case when
      // "resend" was pressed because the first was slow, not lost.
      const actor = await createUnverifiedActor();
      const first = await lastVerifyToken();
      await resend(actor);
      const verify = await fetchWorker(
        new Request(`https://api.test/verify-email?token=${encodeURIComponent(first)}`, {
          headers: { Cookie: actor.cookie },
        }),
      );
      expect(verify.status).toBe(200);
    });

    it("409s ALREADY_VERIFIED for a verified session", async () => {
      const actor = await createVerifiedActor();
      const response = await resend(actor);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("ALREADY_VERIFIED");
    });

    it("401s with no session", async () => {
      const response = await fetchWorker(
        new Request("https://api.test/auth/resend-verification", {
          method: "POST", headers: { Origin: ALLOWED_ORIGIN },
        }),
      );
      // ⚠️ SESSION-REQUIRED, not email-in-the-body. An unauthenticated
      // "resend to this address" endpoint is a mail-bombing gun aimed at any
      // address an attacker names, AND an enumeration oracle.
      expect(response.status).toBe(401);
    });

    it("403s without a CSRF token", async () => {
      const actor = await createUnverifiedActor();
      const response = await fetchWorker(
        new Request("https://api.test/auth/resend-verification", {
          method: "POST", headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie },
        }),
      );
      expect(response.status).toBe(403);
    });

    it("429s past the limiter", async () => {
      const actor = await createUnverifiedActor();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await resend(actor)).status);
      expect(statuses).toContain(429);
    });
  });
  ```

- [ ] **Step 3: Run → FAIL.** `pnpm --filter @thinkersjournal/api test resend` → 404.
- [ ] **Step 4: Implement** (`apps/api/src/routes/resend-verification.ts`):

  ```ts
  /**
   * `POST /auth/resend-verification` — mint and mail a fresh verification token.
   *
   * ⚠️ WHY THIS EXISTS NOW. M1 makes a verified email a HARD REQUIREMENT for
   * posting, and Postmark sends fail SILENTLY BY DESIGN (src/auth/email-verify.ts
   * never throws, so a mail outage cannot 500 a signup). Without this route, one
   * dropped email is a permanently unusable account whose only recovery is
   * re-signup — which works, but is not a flow anyone will find.
   *
   * ⚠️ SESSION-REQUIRED, NOT EMAIL-IN-THE-BODY, AND THIS IS THE WHOLE DESIGN.
   * A `{ email }` endpoint would be (a) a mail-bombing gun aimed at any address an
   * attacker names — from OUR confirmed sender, i.e. our deliverability
   * reputation — and (b) an enumeration oracle if it answered differently for a
   * registered address. Requiring the session means the only address anyone can
   * trigger mail to is the one on the account they already hold, which is exactly
   * the address that already received one.
   *
   * ⚠️ UNVERIFIED-ONLY. A verified account has nothing to verify, so a 409 is the
   * honest answer and it leaks nothing: the caller already IS that account.
   *
   * ⚠️ THE OLD TOKEN IS NOT BURNED. "Resend" is pressed most often because the
   * first mail was SLOW, not lost — invalidating it would break the link the user
   * is about to click. Both tokens stay live until their own 24h TTL, and each is
   * independently one-time. That is safe because possessing a token is not
   * sufficient to verify: GET /verify-email also requires an authenticated,
   * epoch-current session for the token's OWN user (see its header).
   */
  import { runMutatingPipeline } from "../auth/pipeline";
  import { createVerificationToken, sendVerificationEmail } from "../auth/email-verify";
  import { enforceRateLimit } from "../auth/ratelimit";
  import { withClient } from "../db/client";
  import { errorResponse } from "../http/errors";

  /**
   * The origin verification links point at. ⚠️ NOT `new URL(request.url).origin`,
   * which derives from the client-supplied Host header — that would let an
   * attacker have a link to a host they control mailed from OUR confirmed sender.
   * Kept identical to src/routes/signup.ts's constant, deliberately: this is the
   * same decision, and both are audited by grepping for the literal.
   */
  const CANONICAL_ORIGIN = "https://thinkersjournal.com";

  export async function handleResendVerification(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Origin -> session -> CSRF -> epoch. Deliberately NOT `requireVerifiedEmail`:
    // this route is FOR the unverified, so the gate would reject exactly its users.
    const result = await runMutatingPipeline(request, env, ctx);
    if (result instanceof Response) return result;
    const { userId } = result.session;

    // ---- Rate limit — after auth, per the pipeline's rule -------------------
    // Keyed on the SESSION's user: the only identity that can trigger mail here,
    // and one an attacker cannot rotate the way they can an IP. This is a MAIL
    // SEND, so the ceiling is tighter than the auth routes' (3/60s).
    const limited = await enforceRateLimit(env.RESEND_LIMITER, `resend:${userId}`);
    if (limited !== null) return limited;

    // FRESH: a permission read, and a read-after-write against GET /verify-email.
    const user = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ email: string; email_verified_at: Date | null }>(
        "SELECT email, email_verified_at FROM users WHERE id = $1",
        [userId],
      );
      return rows[0] ?? null;
    });
    // A session for a user row that no longer exists: fail closed.
    if (user === null) return errorResponse("UNAUTHORIZED", 401);
    if (user.email_verified_at !== null) return errorResponse("ALREADY_VERIFIED", 409);

    const token = await createVerificationToken(env, userId);
    // NEVER throws (src/auth/email-verify.ts) — a Postmark outage must not 500 a
    // request whose whole purpose is to work around a Postmark outage.
    await sendVerificationEmail(env, user.email, `${CANONICAL_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`);

    // 202, not 200: the send is best-effort by construction, and claiming 200
    // would assert a delivery we deliberately do not verify.
    return new Response(null, { status: 202 });
  }
  ```

- [ ] **Step 5: Register + run → PASS.** In `apps/api/src/routes.ts`: `{ method: "POST", pattern: "/auth/resend-verification", handler: handleResendVerification },`. `pnpm --filter @thinkersjournal/api test` → all green (including `route-protection`'s automatic coverage of the new route).
- [ ] **Step 6: Surface it in the UI.** In `apps/web/src/pages/verify-email.astro`, add a form that POSTs back to the page; on POST, call `apiFetch("/auth/resend-verification", { method: "POST", request: Astro.request, origin: Astro.request.headers.get("Origin") ?? "", csrfToken })` — fetching `csrfToken` from `GET /auth/csrf` exactly as `new-post.astro` does, **including its "why a hidden input and not a cookie" reasoning**. Render "We've sent another link" on 202, "Your email is already verified" on `ALREADY_VERIFIED`, and the login link on 401.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(m1): session-scoped, rate-limited resend-verification"`

### Task 11: Signup — the atomic guarded upsert

> **M0 carry-over, named in that plan's deviation E as the known follow-up:** *"the dup-check→INSERT sequence is not atomic. Concurrent same-email signups roll back cleanly but surface a 500; the fix is an atomic guarded upsert."* It is a clean-rollback 500 rather than a security hole — but M0's own Global Constraint says **"transaction-mode pooler ⇒ all uniqueness/races via DB constraints + `INSERT … ON CONFLICT`"**, and this is the one place that rule is not followed.
>
> The upsert also collapses signup's **two** `withClient` calls (the dup check, then the transaction) into **one** — two Hyperdrive round-trips and two connection acquisitions per signup, on the hot path of the slowest route we have.

**Files:** Modify `apps/api/src/routes/signup.ts`, `apps/api/test/signup.test.ts`.

**Interfaces — Produces:** no signature changes. `POST /auth/signup`'s behaviour is **identical** on every path; only its atomicity and round-trip count change.

- [ ] **Step 1: Write the failing test.** Add to `apps/api/test/signup.test.ts`:

  ```ts
  describe("concurrent same-email signups (the M0 dup-check -> INSERT race)", () => {
    it("resolves to exactly one 201 and one 409/201 — never a 500", async () => {
      const email = `race-${crypto.randomUUID()}@example.com`;
      const body = JSON.stringify({ email, password: "correct-horse-battery-staple", turnstileToken: "d" });
      const make = () =>
        fetchWorker(
          new Request("https://api.test/auth/signup", {
            method: "POST",
            headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
            body,
          }),
        );

      const [a, b] = await Promise.all([make(), make()]);
      // ⚠️ THE ASSERTION IS "NO 500". Both may legitimately 201 (the second is a
      // re-signup over an unverified row — see deviation E); what must never
      // happen is the unique index surfacing as a server error.
      expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);

      // And exactly one row exists, with exactly one profile.
      const ctx = createExecutionContext();
      const { rows } = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        c.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [email]),
      );
      await waitOnExecutionContext(ctx);
      expect(rows[0]!.n).toBe(1);
    });

    it("a VERIFIED duplicate still 409s", async () => {
      const actor = await createVerifiedActor();
      const response = await fetchWorker(
        new Request("https://api.test/auth/signup", {
          method: "POST",
          headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: actor.email, password: "another-long-password", turnstileToken: "d" }),
        }),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("EMAIL_TAKEN");
    });
  });
  ```

  **Do not touch** the existing re-signup/epoch-bump/takeover assertions — they pin the account-takeover fix (deviations D+E), which this task must preserve exactly.

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test signup` → the race test is flaky-to-failing with a 500 from `users_email_key`.
- [ ] **Step 3: Implement the guarded upsert.** In `apps/api/src/routes/signup.ts`, replace steps 5–7 (the dup check `withClient`, and the transaction `withClient`) with a **single** `withClient`. Update the file header's step list to match:

  ```ts
    // ---- 5+7. ATOMIC GUARDED UPSERT (FRESH) ---------------------------------
    //
    // ⚠️ ONE STATEMENT, NOT check-then-act. M0 did a `SELECT … WHERE email = $1`
    // and then INSERTed. Under a TRANSACTION-MODE pooler that is a race by
    // construction: two concurrent signups for one address both see "no row" and
    // both INSERT, and the second dies on `users_email_key` as a 500. This is the
    // Global Constraint the rest of the Worker already follows — "all
    // uniqueness/races via DB constraints + INSERT … ON CONFLICT".
    //
    // HOW THE GUARD ENCODES THE POLICY:
    //   • no row              -> INSERT wins           -> `inserted = true`
    //   • row, UNVERIFIED     -> DO UPDATE fires       -> a re-signup (deviation E)
    //   • row, VERIFIED       -> the WHERE blocks it   -> ZERO ROWS returned
    // Zero rows is therefore UNAMBIGUOUSLY "a verified account owns this address"
    // — the 409 — and it is decided by the DATABASE, atomically, rather than by a
    // read that anything could have invalidated. `xmax = 0` is the standard way to
    // ask "did this row come from the INSERT or the UPDATE"; we need it because
    // the epoch bump below must fire ONLY on the takeover path.
    //
    // ⚠️ DOES NOT 409 THE UNVERIFIED PATH, DELIBERATELY. That would confirm the
    // address is registered to an enumerator. See deviation E.
    const upserted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      await c.query("BEGIN");
      try {
        const { rows } = await c.query<{ id: string; inserted: boolean }>(
          `INSERT INTO users (email, password_hash)
                VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE
                   SET password_hash = EXCLUDED.password_hash
                 WHERE users.email_verified_at IS NULL
             RETURNING id, (xmax = 0) AS inserted`,
          [email, passwordHash],
        );
        const row = rows[0] ?? null;
        if (row === null) {
          // A VERIFIED account owns this address. Nothing was written.
          await c.query("ROLLBACK");
          return null;
        }
        if (row.inserted) {
          await insertProfile(c, row.id, email);
        }
        await c.query("COMMIT");
        return row;
      } catch (err) {
        // The ROLLBACK gets its OWN try/catch so it cannot REPLACE the root error:
        // on a dead connection ROLLBACK throws too, and the caller would see
        // "connection terminated" instead of what actually failed the signup.
        try {
          await c.query("ROLLBACK");
        } catch (rollbackErr) {
          console.error("ROLLBACK after a failed signup transaction failed", rollbackErr);
        }
        throw err;
      }
    });

    if (upserted === null) {
      return errorResponse("EMAIL_TAKEN", 409);
    }
    const userId = upserted.id;
  ```

  ⚠️ **The epoch bump moves, and its ORDER note must move with it.** M0 bumped **before** the write ("revoke-then-mutate is the fail-safe direction"), which the upsert makes impossible — we no longer know it *is* a re-signup until the row comes back. Replace the old step 6 with, immediately after the block above:

  ```ts
    // ---- 6. Epoch bump — RE-SIGNUP ONLY -------------------------------------
    // ⚠️ LOAD-BEARING SECURITY STEP, and half of the account-takeover fix
    // documented at the top of src/routes/verify-email.ts. Taking over an
    // unverified account changes its password, so every session issued against the
    // OLD password must die. Bumping the epoch does that in O(1). WITHOUT it, the
    // previous claimant's surviving session satisfies that route's auth checks by
    // itself and their click on the old emailed link verifies an account holding
    // SOMEONE ELSE'S password. Do not remove; test/signup.test.ts pins this.
    //
    // ⚠️ ORDER CHANGED FROM M0, AND THE REASONING WITH IT. M0 bumped BEFORE the
    // write because revoke-then-mutate is the fail-safe direction. The atomic
    // upsert makes that impossible: we do not know a takeover HAPPENED until the
    // row returns. So the bump now runs AFTER the commit, and the window it opens
    // is: the transaction commits, this call throws, and the displaced party's old
    // session survives against the new password.
    //
    // That window is bounded to a harmless one by TWO existing properties:
    //   • the displaced account is UNVERIFIED, and an unverified session cannot
    //     mutate content at all (the soft gate, src/auth/pipeline.ts);
    //   • GET /verify-email ALSO checks the epoch, so the takeover chain that made
    //     this load-bearing still cannot complete — the surviving session's epoch
    //     is only stale if the bump SUCCEEDED, and if it did there is no window.
    // The residual is: an unverified session survives a bump that crashed. Step 9
    // reads the epoch back AFTER this, so the new session still carries the
    // post-bump value and does not invalidate itself.
    if (!upserted.inserted) {
      await env.USER_SECURITY.getByName(userId).bumpEpoch();
    }
  ```

  Delete the now-unreachable `ExistingUser` interface and the `existing` variable.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test signup` → all green, **including every pre-existing re-signup/takeover/epoch assertion**. Then the whole suite. ⚠️ If any takeover test now fails, **stop** — the epoch reordering above is the suspect, and the two halves of that fix must never be carried forward alone.
- [ ] **Step 5: Update the M0 plan's record.** In `docs/superpowers/plans/2026-07-13-m0-foundations.md`, under *As-built deviations (M0)* → **E**, append to "Known follow-up": `**RESOLVED in M1 Task 11** — the atomic guarded upsert landed; signup is now one \`withClient\` and one statement, and concurrent same-email signups can no longer 500.`
- [ ] **Step 6: Commit.** `git add -A && git commit -m "fix(m1): close signup's dup-check->INSERT race with an atomic guarded upsert"`

### Task 12: Workers Cache on `web`

> **Cloudflare shipped "Workers Cache" on 2026-07-06 — nine days before this plan.** It is an HTTP cache **in front of** the Worker, with `Cache-Tag` and purge built in, *"available today to every Worker on any plan"*, no separate SKU. It **obsoletes the `caches.default` framing entirely** — `caches.default`'s `cache.delete()` is **per-colo only**, so deleting in one colo leaves every other stale, which is not an invalidation story at all.
>
> **Why it wins:** cache hits **do not run the Worker** (no CPU, no Hyperdrive, no Postgres); tiered by default; **request collapsing** (a thundering herd on a cold viral post is **one** render); Instant Purge propagates globally; and it works on `workers.dev` **and** custom domains (Workers are zoneless), so it is **buildable and verifiable before DNS cutover**.
>
> **The cost lever survives and strengthens.** Long TTLs are now *correct* because purge gives precise invalidation: `maxAge 3600 + swr 86400` ⇒ a viral post at 1M views/day is **~24 renders/day (99.998%)** vs ~1440 (99.86%) at a 60s window. The design's >99.7% bar is cleared, and freshness on edit is *better* than designed (near-instant global purge, not waiting out a TTL).
>
> ⚠️ **Two things are experimental/nine-days-old. VERIFY, do not assume.** Step 1 is the verification; its findings, not this prose, are what the code follows.
>
> **Cost note (accepted):** enabling cache makes normally-free static-asset requests **billable** (~11 billed reqs/page view vs 1) ≈ **$0.30 per million page views** — trivially outweighed by eliminating 10–30ms of SSR CPU per view.

**Files:** Modify `apps/web/wrangler.jsonc`, `apps/web/astro.config.mjs`.

**Interfaces — Produces:** Workers Cache enabled on `web`; the Astro cache provider wired; the **verified** spelling of `Astro.cache.set(...)` and `context.cache.invalidate(...)`, recorded in `apps/web/src/lib/cache.ts`'s header (Task 13).

- [ ] **Step 1: VERIFY every shape against the INSTALLED versions.** Run all four; **record the actual output in the commit message** — the next task's code depends on it:

  ```bash
  # 1. Does the adapter export a cache provider, and under what name?
  cd apps/web && pnpm exec node -e "import('@astrojs/cloudflare/cache').then(m => console.log(Object.keys(m)))"
  #    EXPECT: an array containing `cacheCloudflare`.
  #    IF THE SUBPATH DOES NOT RESOLVE: the provider API is not in 14.1.3.
  #    Fall back to Step 5's documented manual-header path.

  # 2. Does astro@7.0.9's config schema accept a top-level `cache`?
  rg -n "cache" apps/web/node_modules/astro/dist/core/config/schemas/base.js | head -20

  # 3. What is the runtime shape — `Astro.cache.set` / `context.cache.invalidate`?
  rg -n "cache" apps/web/node_modules/astro/astro.d.ts | head -30
  rg -rn "invalidate|CacheProvider" apps/web/node_modules/astro/dist/types/public/*.d.ts | head -20

  # 4. Does wrangler 4.110.0 accept `"cache": { "enabled": true }`?
  rg -n "\"cache\"|cacheEnabled" apps/web/node_modules/wrangler/wrangler-dist/cli.js | head -10
  ```

  ⚠️ **The CONSTRAINTS are what is load-bearing, not the spelling.** If a name differs, adapt the call and keep: `max-age` never `s-maxage`; tags batched into one purge; no per-viewer state in a cacheable render. If the provider API is absent entirely, the fallback is to set the response headers by hand — ⚠️ **`Cloudflare-CDN-Cache-Control`, NOT the standard `Cache-Control`** (verified against the installed adapter: that is the name the real provider path writes, and it is what Workers Cache actually reads; the standard header is a browser-facing fallback, not the CDN's own signal) — plus `Cache-Tag`, and to purge via `ctx.cache.purge()` inside `web`'s entrypoint — **the same scope**, just spelled manually. Record which path was taken.
  ⚠️ **This step's own run is what surfaced the header-name correction above** — this plan's earlier drafts asserted `Cache-Control` throughout; every check below has been corrected to `Cloudflare-CDN-Cache-Control` for anything the PROVIDER emits. Headers this codebase sets BY HAND (e.g. `markPrivate`'s `private, no-store`) are unaffected — those are real, standard `Cache-Control`, deliberately.

- [ ] **Step 2: Enable the cache on the Worker.** In `apps/web/wrangler.jsonc`, after `compatibility_flags`:

  ```jsonc
    // ⚠️ WORKERS CACHE — an HTTP cache IN FRONT of this Worker (shipped 2026-07-06;
    // needs Wrangler 4.69.0+, we pin 4.110.0). A HIT DOES NOT RUN THIS WORKER at
    // all: no CPU, no Service-Binding hop to `api`, no Hyperdrive, no Postgres.
    // Tiered by default, with REQUEST COLLAPSING — a thundering herd on a cold
    // viral post costs ONE render.
    //
    // Available on any plan, and on workers.dev AS WELL AS a custom domain
    // (Workers are zoneless), so this is verifiable BEFORE DNS cutover.
    //
    // ⚠️ THE WORKER VERSION IS IN THE CACHE KEY by default: every deploy starts
    // cold, and a template change self-invalidates (no purge-on-deploy needed).
    // This is also WHY A `PIPELINE_VERSION` BUMP INVALIDATES EVERY CACHED RENDER:
    // packages/markdown is bundled INTO this Worker, so bumping it changes the
    // bundle, which changes THIS version, which is in every entry's key. It is
    // NOT because PIPELINE_VERSION is itself a cache-key input (it is a
    // Cache-Tag, a purge handle — Cloudflare's cache key is not user-composable
    // for eyeball traffic). ⚠️ Leave `cross_version_cache` at its default (unset,
    // i.e. off): setting it true would let a stale entry from a PRIOR version
    // keep serving under the new version's key, silently voiding this guarantee.
    // ⚠️ HOST IS NOT IN THE CACHE KEY: apex and www share entries (hence the
    // www->apex redirect), and `*.workers.dev` shares entries with the custom
    // domain at the same version (hence `workers_dev: false` at launch). Both are
    // deploy-gate items in README.md.
    // ⚠️ COOKIE IS NOT IN THE CACHE KEY AND DOES NOT BYPASS. See src/lib/cache.ts —
    // this line is what makes that file load-bearing rather than tidy.
    //
    // COST: this makes normally-free static-asset requests billable (~11 billed
    // requests per page view vs 1) ~= $0.30 per million page views. Accepted: it
    // buys the elimination of 10-30ms of SSR CPU per view.
    //
    // ⚠️ `enabled: true` HERE IS NOT THE OFF-SWITCH IN REVERSE. Verified against
    // the installed adapter: once astro.config.mjs wires `cache: { provider:
    // cacheCloudflare() }` (Step 3), the adapter re-asserts `{"enabled": true}`
    // in the generated config REGARDLESS of what this flag says — calling the
    // customizer with `enabled: false` and the provider both present still
    // produces `{"enabled": true}`. The ONLY real off-switch is not wiring the
    // provider into astro.config.mjs at all. Cloudflare's documented pattern of
    // using `env.production` to keep a staging environment uncached does NOT
    // work here — do not reach for it.
    "cache": { "enabled": true },
  ```

  `compatibility_date` stays **`"2026-07-13"`** — Workers Cache requires ≥ `2026-07-06`, and 07-13 is later. (Step 1's check 4 is what confirms wrangler agrees.)

- [ ] **Step 3: Wire the Astro provider.** In `apps/web/astro.config.mjs`, add `import { cacheCloudflare } from "@astrojs/cloudflare/cache";` and, inside `defineConfig({...})`:

  ```js
    // ⚠️ EXPERIMENTAL API, VERIFIED AGAINST THE INSTALLED astro@7.0.9 /
    // @astrojs/cloudflare@14.1.3 (M1 Task 12 Step 1) — not against a blog post.
    // Astro's CDN cache-provider API is flagged experimental and Workers Cache
    // itself shipped 2026-07-06. Re-run that verification on any bump of either.
    //
    // This is what lets a page call `Astro.cache.set({ maxAge, swr, tags })` and
    // have it become the `Cloudflare-CDN-Cache-Control` + `Cache-Tag` response
    // headers the Workers Cache in front of this Worker reads (see
    // wrangler.jsonc). ⚠️ NOT the standard `Cache-Control` — verified against the
    // installed adapter, and the correction that every cache check in this plan
    // now carries.
    //
    // ⚠️ NEVER `s-maxage`. `s-maxage`, `must-revalidate` and `proxy-revalidate`
    // SILENTLY DISABLE stale-while-revalidate (RFC 9111 §4.2.4): revalidation goes
    // FOREGROUND and the whole cost lever dies with no error anywhere. The helper
    // in src/lib/cache.ts is the only place TTLs are chosen, for exactly this
    // reason — do not set cache headers by hand in a page.
    // ⚠️ ALWAYS PASS an explicit maxAge/swr to cache.set(). A bare
    // `cache.set({ tags })` with no TTL emits a bare `public` directive, which
    // both falls back to Cloudflare's ~2h heuristic freshness and — because
    // `public` is the one directive that overrides "never cache a request
    // carrying Authorization" — can defeat Task 13's per-viewer cache-poisoning
    // guard. src/lib/cache.ts's helpers exist so no call site can omit this.
    //
    // ⚠️ THIS KEY STAYS TOP-LEVEL. `cache` (and any future `routeRules`) must
    // never move under `experimental` — Astro validates that object with a
    // z.strictObject, so an unrecognized key inside it is a hard config error.
    cache: { provider: cacheCloudflare() },
  ```

- [ ] **Step 4: Verify the build still emits a runnable config.** `pnpm --filter @thinkersjournal/web build` → succeeds; then `rg -n '"cache"' apps/web/dist/server/wrangler.json` → the generated config carries `"cache": { "enabled": true }`. ⚠️ Also `rg -n 'cross_version_cache' apps/web/dist/server/wrangler.json apps/web/wrangler.jsonc` → **no match** — its absence is what keeps the `PIPELINE_VERSION`/worker-version invalidation guarantee true; a match here means someone set it and silently broke that guarantee. (⚠️ Never run this while a `wrangler dev` is alive — see the Global Constraints.) `pnpm --filter @thinkersjournal/web typecheck` (`astro check`) → exit 0.
- [ ] **Step 5: Record the outcome.** Add a line to `apps/web/astro.config.mjs`'s version-notes block stating which path Step 1 selected (provider API, or manual headers) and the exact verified call shape. **This block is the record for the next reader; the plan's prose is not.**
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(m1): enable Workers Cache on web + wire the Astro cache provider"` — and put Step 1's verified output in the commit body.

### Task 13: The per-viewer cache-poisoning guard

> ⚠️ **CRITICAL — this is the single highest-severity item in M1.**
>
> **`Cookie` is NOT in the Workers Cache key and does NOT trigger bypass.** A logged-in SSR render that does not happen to set a cookie **will be cached and served to everyone** — a mass session leak, from an ordinary-looking page that renders "Welcome back, Alice". `Set-Cookie` on the response *does* force bypass, but **do not rely on it**: it makes correctness depend on a side effect the page has no reason to produce.
>
> **The defense is architectural, not a flag:** public pages render **fully anonymous** — they never forward the browser's `Cookie` to the api, so there is nothing viewer-specific in the render to leak — and viewer state (the "Edit" link, the reaction state) hydrates **client-side**. `cache.set(false)` when a session cookie is present is **belt-and-braces**, not the defense.
>
> Its cost is real and accepted: a logged-in viewer forces a render on every public page view. Logged-in traffic is a small fraction of SEO traffic, and the alternative is a session leak.

**Files:** Create `apps/web/src/lib/cache.ts`, `apps/web/test/cache.test.ts`, `apps/web/test/page-cache-inventory.test.ts`. Modify `apps/web/src/pages/{index,login,signup,verify-email,new-post}.astro`.

**Interfaces — Produces:**
- `PUBLIC_MAX_AGE = 3600`, `PUBLIC_SWR = 86400`, `FEED_MAX_AGE = 60`, `FEED_SWR = 600`
- `markPublicCacheable(context: CacheContext, tags: string[]): boolean`
- `markFeedCacheable(context: CacheContext): boolean` (untagged, TTL-only — sitemap/RSS)
- `markPrivate(context: CacheContext): void`
- `hasViewerState(context: CacheContext): boolean`

- [ ] **Step 1: Write the failing unit test** (`apps/web/test/cache.test.ts`):

  ```ts
  import { SESSION_COOKIE_NAME } from "@thinkersjournal/shared";
  import { describe, expect, it, vi } from "vitest";

  import { hasViewerState, markFeedCacheable, markPrivate, markPublicCacheable, PUBLIC_MAX_AGE, PUBLIC_SWR } from "../src/lib/cache";

  import type { CacheContext } from "../src/lib/cache";

  function context(cookie?: string): CacheContext & { cache: { set: ReturnType<typeof vi.fn> } } {
    return {
      request: new Request("https://thinkersjournal.com/@a/b", {
        headers: cookie === undefined ? {} : { Cookie: cookie },
      }),
      response: { headers: new Headers() },
      cache: { set: vi.fn() },
    } as never;
  }

  describe("hasViewerState", () => {
    it("is true when the session cookie is present", () => {
      expect(hasViewerState(context(`${SESSION_COOKIE_NAME}=abc`))).toBe(true);
    });

    it("finds the cookie among others, in any position", () => {
      expect(hasViewerState(context(`other=1; ${SESSION_COOKIE_NAME}=abc; more=2`))).toBe(true);
    });

    it("is false for no cookie header at all", () => {
      expect(hasViewerState(context())).toBe(false);
    });

    it("is false for unrelated cookies", () => {
      expect(hasViewerState(context("theme=dark; cf_clearance=x"))).toBe(false);
    });

    it("does NOT false-positive on a cookie whose name merely CONTAINS ours", () => {
      // `not_tj_session=x` must not read as a session, or every visitor with such
      // a cookie silently loses caching.
      expect(hasViewerState(context("not_tj_session=x"))).toBe(false);
    });
  });

  describe("markPublicCacheable", () => {
    it("marks an ANONYMOUS render cacheable with the right TTLs and tags", () => {
      const ctx = context();
      expect(markPublicCacheable(ctx, ["post:1", "author:2", "listing"])).toBe(true);
      expect(ctx.cache.set).toHaveBeenCalledWith({
        maxAge: PUBLIC_MAX_AGE,
        swr: PUBLIC_SWR,
        tags: ["post:1", "author:2", "listing"],
      });
    });

    it("⚠️ REFUSES to cache a render carrying a session cookie", () => {
      // ⚠️ THE REGRESSION THIS FILE EXISTS FOR. Cookie is NOT in the cache key and
      // does NOT bypass: a cacheable authed render is served to EVERYONE.
      const ctx = context(`${SESSION_COOKIE_NAME}=abc`);
      expect(markPublicCacheable(ctx, ["post:1"])).toBe(false);
      expect(ctx.cache.set).toHaveBeenCalledWith(false);
      expect(ctx.cache.set).not.toHaveBeenCalledWith(expect.objectContaining({ maxAge: expect.anything() }));
    });

    it("passes ONLY maxAge/swr/tags into cache.set() — never an s-maxage-shaped key", () => {
      // ⚠️ THIS TEST CANNOT READ THE REAL RESPONSE HEADER. `ctx.cache.set` here is
      // a bare `vi.fn()` spy with no implementation, so `ctx.response.headers` is
      // NEVER mutated by it — reading `ctx.response.headers.get(...)` after this
      // call is always empty, regardless of header name, because the Astro
      // Cloudflare adapter's real header translation (which writes
      // `Cloudflare-CDN-Cache-Control`, NOT `Cache-Control` — verified against the
      // installed astro@7.0.9 / @astrojs/cloudflare@14.1.3, Task 12) happens
      // inside the adapter's render pipeline, outside this mock's reach. All this
      // unit test can pin is the CALL SHAPE we control. The real response header
      // — including that it never carries `s-maxage` — is asserted end-to-end by
      // Task 19's E2E and re-verified at the Task 20 deploy gate; that is the
      // only place this promise is actually provable.
      const ctx = context();
      markPublicCacheable(ctx, ["x"]);
      expect(ctx.cache.set).toHaveBeenCalledWith({
        maxAge: expect.any(Number),
        swr: expect.any(Number),
        tags: expect.any(Array),
      });
    });
  });

  describe("markFeedCacheable (untagged, TTL-only)", () => {
    it("uses the SHORT window and NO tags", () => {
      const ctx = context();
      expect(markFeedCacheable(ctx)).toBe(true);
      // ⚠️ No tags is deliberate: this is the one shape that may read through
      // HYPERDRIVE_CACHED, and that is only sound while nothing purges it.
      expect(ctx.cache.set).toHaveBeenCalledWith({ maxAge: 60, swr: 600, tags: [] });
    });

    it("still refuses an authed render", () => {
      const ctx = context(`${SESSION_COOKIE_NAME}=abc`);
      expect(markFeedCacheable(ctx)).toBe(false);
    });
  });

  describe("markPrivate", () => {
    it("disables caching and says so in the header", () => {
      const ctx = context();
      markPrivate(ctx);
      expect(ctx.cache.set).toHaveBeenCalledWith(false);
      expect(ctx.response.headers.get("cache-control")).toBe("private, no-store");
    });
  });
  ```

- [ ] **Step 2: Write the failing INVENTORY test** (`apps/web/test/page-cache-inventory.test.ts`) — the structural half, in `route-protection.test.ts`'s idiom:

  ```ts
  import { readdirSync, readFileSync, statSync } from "node:fs";
  import { join } from "node:path";

  import { describe, expect, it } from "vitest";

  /**
   * THE PAGE CACHEABILITY INVENTORY — a DEFAULT-DENY BACKSTOP for every page.
   *
   * ⚠️ WHY THIS FILE EXISTS. Cookie is NOT in the Workers Cache key and does NOT
   * trigger bypass. A page that renders anything viewer-specific and does not
   * declare itself uncacheable WILL be cached and served to every visitor — a mass
   * session leak, from a page whose code looks entirely ordinary. Nothing about
   * that failure is loud: it passes typecheck, it passes every unit test, and in
   * local dev (where there is no edge cache) it is completely invisible.
   *
   * So no page is allowed to be SILENT about its cacheability. Every page must
   * call exactly one of the three helpers in src/lib/cache.ts, and this file reads
   * the pages' source to enforce it. A NEW page is covered the moment it exists.
   *
   * ⚠️ If you are here because you added a page: the answer is to call
   * markPublicCacheable / markFeedCacheable / markPrivate — not to add an
   * exemption. There is deliberately no exemption list.
   */
  const PAGES_DIR = join(import.meta.dirname, "../src/pages");

  /** Every page/endpoint file, recursively. */
  function pageFiles(dir: string = PAGES_DIR): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return pageFiles(full);
      return /\.(astro|ts)$/.test(entry) ? [full] : [];
    });
  }

  const HELPERS = ["markPublicCacheable", "markFeedCacheable", "markPrivate"] as const;

  /**
   * The one file that legitimately declares nothing: the internal purge endpoint
   * is a POST, and POST bypasses cache unconditionally — which is precisely why
   * the purge hop uses one (src/pages/__internal/purge.ts).
   */
  const NOT_A_RENDERED_PAGE = ["__internal/purge.ts"];

  const FILES = pageFiles().filter((f) => !NOT_A_RENDERED_PAGE.some((n) => f.replace(/\\/g, "/").endsWith(n)));

  describe("every page declares its cacheability", () => {
    it("found pages to check (tripwire — a moved src/pages would pass vacuously)", () => {
      expect(FILES.length).toBeGreaterThan(3);
    });

    it.each(FILES.map((f) => [f.replace(/\\/g, "/").split("/src/pages/")[1]!, f]))(
      "%s calls exactly one cache helper",
      (name, file) => {
        const source = readFileSync(file, "utf8");
        const used = HELPERS.filter((h) => source.includes(`${h}(`));
        expect(
          used,
          `${name} does not declare its cacheability. Call markPublicCacheable(Astro, tags) for an ANONYMOUS public render, markFeedCacheable(Astro) for an untagged short-TTL feed, or markPrivate(Astro) for anything per-viewer. ⚠️ Cookie is NOT in the cache key and does NOT bypass — a page that says nothing and renders viewer state is served to EVERYONE. See src/lib/cache.ts.`,
        ).toHaveLength(1);
      },
    );

    it.each(FILES.map((f) => [f.replace(/\\/g, "/").split("/src/pages/")[1]!, f]))(
      "%s does not set cache headers or call cache.set() directly",
      (name, file) => {
        const source = readFileSync(file, "utf8");
        // Bypassing the helpers is how `s-maxage` (which SILENTLY disables SWR) and
        // an unguarded authed render both get in. One place chooses TTLs.
        expect(source, `${name} calls cache.set() directly — use a helper from src/lib/cache.ts.`).not.toMatch(
          /\bcache\.set\(/,
        );
        // ⚠️ Catches BOTH the standard header AND the real one the Astro provider
        // reads (`Cloudflare-CDN-Cache-Control`, verified in Task 12) — a page
        // hand-setting either is bypassing src/lib/cache.ts.
        expect(source, `${name} sets a cache-control header by hand — use a helper from src/lib/cache.ts.`).not.toMatch(
          /headers\.set\(\s*["'](cache-control|cloudflare-cdn-cache-control)["']/i,
        );
      },
    );
  });
  ```

- [ ] **Step 3: Run → FAIL.** `pnpm --filter @thinkersjournal/web test` → `Cannot find module '../src/lib/cache'`, and the inventory fails for all five existing pages.
- [ ] **Step 4: Implement** (`apps/web/src/lib/cache.ts`):

  ```ts
  /**
   * CACHEABILITY — the ONE place this app decides what the edge may hold.
   *
   * ⚠️⚠️ COOKIE IS NOT IN THE WORKERS CACHE KEY AND DOES NOT TRIGGER BYPASS. ⚠️⚠️
   *
   * That single fact is why this file exists. A logged-in SSR render that does not
   * happen to set a cookie WILL BE CACHED AND SERVED TO EVERYONE — a mass session
   * leak out of a page whose code looks completely ordinary. `Set-Cookie` on the
   * response DOES force a bypass, but relying on that makes correctness depend on
   * a side effect a page has no reason to produce.
   *
   * ⚠️ THE REAL DEFENSE IS ARCHITECTURAL, NOT THIS FILE. Public pages render FULLY
   * ANONYMOUS: they call the api WITHOUT forwarding the browser's Cookie (see
   * src/lib/api.ts's `request` option — omitting it is what makes a call
   * anonymous), so there is no viewer-specific value in the render to leak in the
   * first place. Viewer state (the Edit link, reactions) hydrates CLIENT-SIDE.
   * `markPublicCacheable` refusing to cache a cookie-bearing request is
   * BELT-AND-BRACES for the day someone forgets — not the defense.
   *
   * Its cost is real and accepted: a logged-in viewer forces a render on every
   * public page view. Logged-in traffic is a small fraction of SEO traffic, and
   * the alternative is a session leak.
   *
   * ⚠️ NEVER `s-maxage`. `s-maxage`, `must-revalidate` and `proxy-revalidate`
   * SILENTLY DISABLE stale-while-revalidate (RFC 9111 §4.2.4) — revalidation goes
   * foreground and the cost lever dies with no error anywhere. TTLs are chosen
   * HERE and nowhere else; test/page-cache-inventory.test.ts enforces that.
   *
   * ⚠️ NO NONCES. Every viewer of a cached render receives the SAME nonce, so a
   * nonce-based CSP is theatre here. See src/lib/csp.ts.
   */
  import { PIPELINE_VERSION } from "@thinkersjournal/markdown";
  import { SESSION_COOKIE_NAME } from "@thinkersjournal/shared";

  /**
   * The subset of `APIContext` / the `Astro` global these helpers need. Structural
   * rather than importing Astro's type, so the unit tests can build one without a
   * renderer — and so this module states exactly what it touches.
   */
  export interface CacheContext {
    request: Request;
    response: { headers: Headers };
    cache: { set: (value: false | { maxAge: number; swr: number; tags: string[] }) => void };
  }

  /**
   * PURGE-INVALIDATED pages (post, profile). Long is CORRECT here precisely
   * because purge exists: a viral post at 1M views/day costs ~24 renders/day
   * (99.998%) instead of ~1440 at a 60s window, and an edit is reflected by a
   * near-instant global purge rather than by waiting out the TTL.
   */
  export const PUBLIC_MAX_AGE = 3600;
  export const PUBLIC_SWR = 86400;

  /**
   * UNTAGGED, TTL-only pages (sitemap.xml, rss.xml) — the spec's decision #20
   * values. ⚠️ These are the ONLY renders whose api reads may use
   * HYPERDRIVE_CACHED, and the reason is exactly that nothing purges them: a 60s
   * Hyperdrive window is a subset of the 60s staleness already accepted here. Tag
   * one of these pages and that stops being true. See apps/api/src/routes/public.ts.
   */
  export const FEED_MAX_AGE = 60;
  export const FEED_SWR = 600;

  /**
   * Whether this request carries per-viewer identity.
   *
   * Deliberately a COOKIE-PRESENCE check, not a session lookup: it must be free,
   * it must not add a Service-Binding hop to every public render, and "might be
   * logged in" is exactly the right question — the safe answer to a maybe is
   * don't cache.
   */
  export function hasViewerState(context: CacheContext): boolean {
    const cookie = context.request.headers.get("Cookie");
    if (cookie === null) return false;
    // Name-boundary aware: a bare `includes("tj_session=")` would also match
    // `not_tj_session=x` and silently disable caching for anyone who has one.
    return cookie.split(/;\s*/).some((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`));
  }

  function refuse(context: CacheContext): void {
    context.cache.set(false);
    context.response.headers.set("cache-control", "private, no-store");
  }

  /**
   * Mark an ANONYMOUS public render cacheable under `tags`. Returns whether it was
   * actually marked — false means a session cookie was present and the render was
   * refused (see the header).
   *
   * ⚠️ PIPELINE_VERSION is folded into the tags. Bumping it in
   * packages/markdown/src/render.ts therefore invalidates every cached render on
   * the next deploy — which is what makes read-time rendering's promise real: a
   * sanitizer fix is a DEPLOY, not a backfill of every row.
   */
  export function markPublicCacheable(context: CacheContext, tags: string[]): boolean {
    if (hasViewerState(context)) {
      refuse(context);
      return false;
    }
    context.cache.set({ maxAge: PUBLIC_MAX_AGE, swr: PUBLIC_SWR, tags: [...tags, `pipeline:${PIPELINE_VERSION}`] });
    return true;
  }

  /** Mark an UNTAGGED, short-TTL public render cacheable (sitemap.xml, rss.xml). */
  export function markFeedCacheable(context: CacheContext): boolean {
    if (hasViewerState(context)) {
      refuse(context);
      return false;
    }
    context.cache.set({ maxAge: FEED_MAX_AGE, swr: FEED_SWR, tags: [] });
    return true;
  }

  /** Declare a page per-viewer and uncacheable. Every authed page calls this. */
  export function markPrivate(context: CacheContext): void {
    refuse(context);
  }
  ```

  ⚠️ **Reconcile the unit test with `PIPELINE_VERSION`**: update `cache.test.ts`'s tag assertion to `tags: ["post:1", "author:2", "listing", "pipeline:v1"]` and add a case asserting the `pipeline:` tag is always appended — *"bumping PIPELINE_VERSION must invalidate every cached render; without this tag that promise is false."* Add `"@thinkersjournal/markdown": "workspace:*"` to `apps/web/package.json` and `pnpm install`.

- [ ] **Step 5: Declare the existing pages.** In each of `apps/web/src/pages/{index,login,signup,verify-email,new-post}.astro`, add to the frontmatter:

  ```ts
  import { markPrivate } from "../lib/cache";

  // ⚠️ Per-viewer: this page reads the session cookie and/or renders a per-session
  // CSRF token. Cookie is NOT in the cache key, so a cacheable render here would
  // be served to everyone. See src/lib/cache.ts.
  markPrivate(Astro);
  ```

  and **remove** the now-duplicated `Astro.response.headers.set("cache-control", "no-store")` from `new-post.astro` (its comment's reasoning moves into the call above; `markPrivate` sets `private, no-store`, which is strictly stronger). ⚠️ `index.astro` is `markPrivate` **for now** — making the logged-out home cacheable needs the anonymous-render treatment and belongs with M2's feed work; note that inline.

- [ ] **Step 6: Run → PASS.** `pnpm --filter @thinkersjournal/web test` → 38 + cache + inventory, all green. `pnpm --filter @thinkersjournal/web typecheck` → exit 0. ⚠️ If `markPrivate(Astro)` does not type-check against `CacheContext`, **fix `CacheContext` to match Astro's real shape** (Task 12 Step 1's check 3 is the source) — do not cast at the call site, or the guard is typed against a fiction.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(m1): cacheability helpers + a default-deny page inventory (cookie is not in the cache key)"`

### Task 14: The cross-Worker purge hop

> ⚠️ **`api` CANNOT purge `web`'s cache.** Purge is scoped to the Worker+entrypoint that **owns** the cache: *"a Worker cannot reach into another Worker's cache."* Edits land in `api`; the HTML lives in `web`'s cache. **The design does not account for this** — the research names it as M1's new task #1.
>
> The hop: a Service Binding `api → web` + an internal purge route on `web` (a **POST**, which bypasses cache unconditionally, so it always executes), guarded by a shared secret; `web` calls `context.cache.invalidate({ tags })` **inside its own entrypoint**, which is the correct scope.
>
> ⚠️ **This makes the Service Bindings CIRCULAR** (`web → api` for everything, `api → web` for purge). That is fine at runtime but creates a **first-deploy chicken-and-egg** — see the Prerequisites table.
>
> **Why not have `web` purge from its own POST handler?** It could — `web` is where every edit passes today. But it would make purge correctness a *convention* every future call site must remember, exactly the shape M0's `route-protection.test.ts` exists to prevent; and M3's cron/queue refresh sweep and M4's moderation auto-hide both fire **inside `api`**, with no `web` request anywhere. The Worker that owns the data owns the invalidation.

**Files:** Create `packages/shared/src/timing-safe.ts`, `apps/api/src/cache/purge.ts`, `apps/web/src/pages/__internal/purge.ts`, `apps/web/.dev.vars`, `apps/api/test/{purge.test.ts,purge-wiring.test.ts}`. Modify `packages/shared/src/index.ts`, `apps/api/src/auth/csrf.ts`, **`apps/api/src/routes/posts.ts`** (Task 9's handlers — this is where purge-on-edit is wired in), `apps/api/wrangler.jsonc`, `apps/api/vitest.config.ts`, `apps/api/.dev.vars`, `apps/api/src/worker-configuration.d.ts` + `apps/web/worker-configuration.d.ts` (generated), `playwright.config.ts`.

**Interfaces — Consumes:** Task 9's `handleCreatePost` + `handleUpdatePost` (`apps/api/src/routes/posts.ts`) — this task adds the two purge call sites they were written to receive; Task 12's Workers Cache and Task 13's cache tags (`post:<id>`, `author:<id>`, `listing`) — **the tags this purges are the tags those tasks set**, which is exactly why the wiring lives here and not in Task 9.

**Interfaces — Produces:**
- `timingSafeEqual(a: string, b: string): boolean` from `@thinkersjournal/shared`.
- `purgeTags(env: Env, tags: readonly string[]): Promise<void>` — **never throws**, **one call per edit**.
- `POST /__internal/purge` on `web` → `200 {"purged": n}`.
- Bindings: `WEB` (Service Binding on `api`), secret `PURGE_SECRET` on **both**.
- `POST /posts` and `PATCH /posts/:id` purge their tags on the publish/edit paths.

- [ ] **Step 1: Give `timingSafeEqual` one home.** Create `packages/shared/src/timing-safe.ts`, moving M0's implementation **and its entire doc-comment** out of `apps/api/src/auth/csrf.ts`:

  ```ts
  /**
   * Constant-time string comparison: accumulates XOR differences over the FULL
   * length of both strings (no early return on the first mismatch), so the time
   * taken does not leak how many leading characters matched. Callers are expected
   * to pass fixed-length strings (64-char hex digests); a length mismatch is
   * reported immediately (its own length check does not leak useful timing
   * information about digest content) but no character comparison short-circuits.
   *
   * ⚠️ SHARED BECAUSE BOTH WORKERS NEED IT AND A SECOND COPY WOULD DRIFT — the
   * same reasoning as apps/api/src/auth/encoding.ts. `api` compares CSRF tokens
   * with it (src/auth/csrf.ts); `web` compares the purge shared secret with it
   * (src/pages/__internal/purge.ts). A "cleanup" that early-returns on the first
   * differing character would silently turn either into a timing oracle while
   * every test stayed green — which is exactly why there must be one definition
   * and not two.
   */
  export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
  ```

  Re-export from `packages/shared/src/index.ts`. In `apps/api/src/auth/csrf.ts`, delete the local function and `import { timingSafeEqual } from "@thinkersjournal/shared";`. `pnpm --filter @thinkersjournal/api test csrf` must stay green — **unchanged behaviour is the point**.

- [ ] **Step 2: Add the binding + secret.** In `apps/api/wrangler.jsonc`:

  ```jsonc
    // ⚠️ THE PURGE HOP — api CANNOT purge web's cache directly.
    // Workers Cache purge is scoped to the Worker+entrypoint that OWNS the cache:
    // "a Worker cannot reach into another Worker's cache." Edits land HERE; the
    // rendered HTML lives in `web`'s cache. So this Worker asks `web` to purge, and
    // `web` calls context.cache.invalidate() inside its own entrypoint — the only
    // scope in which that call means anything.
    //
    // ⚠️ THIS MAKES THE SERVICE BINDINGS CIRCULAR (web -> api for everything, api
    // -> web for purge). Fine at runtime; a FIRST-DEPLOY chicken-and-egg, because
    // `wrangler deploy` resolves the target service by name and neither exists yet.
    // Order: deploy api WITHOUT this block -> deploy web -> add this block ->
    // redeploy api. Every later deploy is order-independent. See README.md's gate.
    "services": [{ "binding": "WEB", "service": "thinkersjournal-web" }],
  ```

  Append `PURGE_SECRET=dev-purge-secret-not-for-production` to `apps/api/.dev.vars` and create `apps/web/.dev.vars` with the **same value** (documented in the README, Task 20). Add to `apps/api/vitest.config.ts`'s `miniflare.bindings`:

  ```ts
                  // A SECRET (src/cache/purge.ts). Supplied here so the suite is
                  // CI-safe without .dev.vars. Must match apps/web/.dev.vars for
                  // the E2E's cross-process purge hop to authenticate.
                  PURGE_SECRET: "dev-purge-secret-not-for-production",
  ```

  Run `wrangler types` in **both** apps and commit both regenerated files.

- [ ] **Step 3: Write the failing test** (`apps/api/test/purge.test.ts`) — for the api half; `web`'s half is covered end-to-end in Task 19:

  ```ts
  import { env } from "cloudflare:test";
  import { afterEach, describe, expect, it, vi } from "vitest";

  import { purgeTags } from "../src/cache/purge";

  /**
   * The api half of the purge hop. The `WEB` Service Binding is stubbed here — the
   * REAL cross-Worker dispatch (and the secret check on web's side) is proven by
   * e2e/publish.spec.ts, which runs both Workers. What this file pins is the
   * CONTRACT api must honour: one batched call, and never throwing.
   */
  function stubWeb(response: Response): { fetch: ReturnType<typeof vi.fn> } {
    const fetch = vi.fn(async () => response);
    return { fetch };
  }

  afterEach(() => vi.restoreAllMocks());

  describe("purgeTags", () => {
    it("sends ONE request carrying ALL tags", async () => {
      const web = stubWeb(new Response(JSON.stringify({ purged: 3 }), { status: 200 }));
      await purgeTags({ ...env, WEB: web } as never, ["post:1", "author:2", "listing"]);

      // ⚠️ ONE call, not three. The Free-zone purge limit is 5 requests per MINUTE
      // (burst 25, 100 ops/request) — a call per tag would spend an author's whole
      // budget in under two edits.
      expect(web.fetch).toHaveBeenCalledTimes(1);
      const [, init] = web.fetch.mock.calls[0]!;
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        tags: ["post:1", "author:2", "listing"],
      });
    });

    it("POSTs (POST bypasses cache, so the purge always executes)", async () => {
      const web = stubWeb(new Response("{}", { status: 200 }));
      await purgeTags({ ...env, WEB: web } as never, ["x"]);
      expect((web.fetch.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    });

    it("sends the shared secret", async () => {
      const web = stubWeb(new Response("{}", { status: 200 }));
      await purgeTags({ ...env, WEB: web, PURGE_SECRET: "s3cret" } as never, ["x"]);
      const headers = new Headers((web.fetch.mock.calls[0]![1] as RequestInit).headers);
      expect(headers.get("X-Purge-Secret")).toBe("s3cret");
    });

    it("deduplicates tags", async () => {
      const web = stubWeb(new Response("{}", { status: 200 }));
      await purgeTags({ ...env, WEB: web } as never, ["listing", "listing", "post:1"]);
      expect(JSON.parse((web.fetch.mock.calls[0]![1] as RequestInit).body as string).tags).toEqual([
        "listing", "post:1",
      ]);
    });

    it("does nothing for an empty tag list", async () => {
      const web = stubWeb(new Response("{}", { status: 200 }));
      await purgeTags({ ...env, WEB: web } as never, []);
      expect(web.fetch).not.toHaveBeenCalled();
    });

    it("NEVER THROWS on a non-2xx — and logs it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const web = stubWeb(new Response("nope", { status: 403 }));
      // ⚠️ A failed purge must never fail the EDIT. The post is already saved.
      await expect(purgeTags({ ...env, WEB: web } as never, ["x"])).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    });

    it("NEVER THROWS when the binding itself throws — and logs it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const web = { fetch: vi.fn(async () => { throw new Error("Network connection lost"); }) };
      await expect(purgeTags({ ...env, WEB: web } as never, ["x"])).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 4: Run → FAIL.** `pnpm --filter @thinkersjournal/api test purge` → `Cannot find module '../src/cache/purge'`.
- [ ] **Step 5: Implement the api half** (`apps/api/src/cache/purge.ts`):

  ```ts
  /**
   * THE CROSS-WORKER PURGE HOP.
   *
   * ⚠️ THIS WORKER CANNOT PURGE `web`'s CACHE. Workers Cache purge is scoped to the
   * Worker+entrypoint that OWNS the cache — "a Worker cannot reach into another
   * Worker's cache." Edits land here; the rendered HTML lives in `web`'s cache. So
   * we ASK `web`, over the `WEB` Service Binding, and `web` calls
   * context.cache.invalidate() inside its own entrypoint (src/pages/__internal/purge.ts).
   *
   * ⚠️ ONE CALL PER EDIT, ALL TAGS BATCHED. The Free-zone purge limit is 5 requests
   * per MINUTE (burst 25, 100 operations per request). A call per tag would spend an
   * author's entire budget in under two edits and start silently dropping purges —
   * whose symptom is content that is stale for up to 25 hours.
   *
   * ⚠️ NEVER THROWS — the same contract as src/auth/email-verify.ts's
   * sendVerificationEmail, for the same reason: the post is ALREADY SAVED by the
   * time this runs, so a purge failure must not turn a successful edit into a 500.
   * ⚠️ AND THAT MEANS FAILURES ARE SILENT TO USERS. The only signal is the log
   * lines below, and the cost of missing them is content stale for a full
   * maxAge+swr window (25h). Alerting on `cache purge` is a DEPLOY-GATE item.
   *
   * ⚠️ AWAITED BY CALLERS, not fired into ctx.waitUntil(). The editor redirects to
   * the post page immediately after an edit; purging behind the response races that
   * redirect and can show the author their own stale post. Purge is ~10-50ms and
   * edits are rare.
   */

  /**
   * The URL host for the Service-Binding dispatch. A Service Binding dispatches on
   * the BINDING, not on DNS, so this is never resolved — but `fetch` still demands
   * a well-formed absolute URL. Deliberately not a real domain. (Mirrors
   * apps/web/src/lib/api.ts's SERVICE_ORIGIN.)
   */
  const SERVICE_ORIGIN = "https://web.internal";
  const PURGE_PATH = "/__internal/purge";

  export async function purgeTags(env: Env, tags: readonly string[]): Promise<void> {
    const unique = [...new Set(tags)];
    if (unique.length === 0) return;

    try {
      const response = await env.WEB.fetch(`${SERVICE_ORIGIN}${PURGE_PATH}`, {
        // ⚠️ POST, and that is load-bearing: POST bypasses the cache
        // unconditionally, so this request always reaches the Worker and always
        // executes. A GET could be served from cache and purge nothing.
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The whole authorization story for that route — `web` is PUBLIC, so
          // `/__internal/purge` is reachable from the internet and there is no way
          // to prove a request arrived over the binding. See its header.
          "X-Purge-Secret": env.PURGE_SECRET,
        },
        body: JSON.stringify({ tags: unique }),
      });

      if (!response.ok) {
        // Status only — the tags are not secret, but there is nothing to learn from
        // them either, and a log line per tag is a log line per edit.
        console.error("cache purge rejected", { status: response.status, tagCount: unique.length });
      }
    } catch (err) {
      // A dev-registry blip or a `web` that is not deployed yet must not 500 an
      // edit. ("Network connection lost" is the shape this takes locally when
      // `astro build` ran while a wrangler dev was alive — see the README.)
      console.error("cache purge threw", err);
    }
  }
  ```

- [ ] **Step 6: Implement the web half** (`apps/web/src/pages/__internal/purge.ts`):

  ```ts
  /**
   * `POST /__internal/purge` — the ONLY place cached renders are invalidated.
   *
   * ⚠️ WHY THIS EXISTS ON `web` AND NOT ON `api`. Workers Cache purge is scoped to
   * the Worker that OWNS the cache: `api` cannot reach into this Worker's cache, no
   * matter what it calls. So `api` (which knows an edit happened) asks THIS Worker
   * (which owns the cache) to purge — see apps/api/src/cache/purge.ts.
   *
   * ⚠️ THIS ROUTE IS PUBLICLY REACHABLE, AND THE SECRET IS ITS ONLY GUARD.
   * `web` is the public Worker: https://thinkersjournal.com/__internal/purge is a
   * real, routable URL. There is NO way to prove a request arrived over the Service
   * Binding — no header a caller cannot forge, no address to check. So the shared
   * secret IS the authorization, it is compared in constant time, and it must be a
   * real high-entropy value set as a secret on BOTH Workers (README's deploy gate).
   * Do not add a "came from the binding" check that only looks like one.
   *
   * ⚠️ POST is load-bearing: POST bypasses the cache unconditionally, so this
   * always executes rather than being answered from cache.
   *
   * ⚠️ WORST CASE IF THE SECRET LEAKS: an attacker can purge our cache, i.e. force
   * re-renders. That is a cost/DoS lever, not a data leak — this route reads
   * nothing and writes nothing. Rotate the secret; do not panic.
   */
  import { timingSafeEqual } from "@thinkersjournal/shared";
  import { env } from "cloudflare:workers";

  import type { APIRoute } from "astro";

  export const prerender = false;

  function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  export const POST: APIRoute = async (context) => {
    const submitted = context.request.headers.get("X-Purge-Secret");
    // Fails CLOSED on a missing header and on a missing/empty binding: an empty
    // PURGE_SECRET must never make every caller authorized.
    if (submitted === null || env.PURGE_SECRET === undefined || env.PURGE_SECRET === "") {
      return json({ code: "FORBIDDEN" }, 403);
    }
    if (!timingSafeEqual(submitted, env.PURGE_SECRET)) {
      return json({ code: "FORBIDDEN" }, 403);
    }

    let body: unknown;
    try {
      body = await context.request.json();
    } catch {
      return json({ code: "INVALID_JSON" }, 400);
    }

    const tags = Array.isArray((body as { tags?: unknown }).tags)
      ? ((body as { tags: unknown[] }).tags.filter((t): t is string => typeof t === "string" && t !== ""))
      : [];
    if (tags.length === 0) return json({ code: "INVALID_INPUT", fields: ["tags"] }, 400);

    // ⚠️ INSIDE THIS WORKER'S ENTRYPOINT — the only scope where this call reaches
    // the cache holding our rendered HTML. One call, every tag: the Free-zone purge
    // limit is 5 requests/minute (100 operations per request).
    await context.cache.invalidate({ tags });

    return json({ purged: tags.length }, 200);
  };
  ```

  ⚠️ **Verify `context.cache.invalidate({ tags })` against the installed adapter** (Task 12 Step 1's check 3). If the method is named differently, fix it here and record the real name in `astro.config.mjs`'s notes block.

- [ ] **Step 7: Write the failing WIRING test** (`apps/api/test/purge-wiring.test.ts`). `purge.test.ts` (Step 3) pins what `purgeTags` *does*; this pins that the **handlers actually call it** — the two are different failures, and the second is the silent one:

  ```ts
  import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
  import { beforeAll, describe, expect, it, vi } from "vitest";

  import worker from "../src";
  import { createVerifiedActor, type Actor } from "./actor";

  /**
   * ⚠️ THE HANDLERS MUST ACTUALLY PURGE. test/purge.test.ts proves purgeTags sends
   * the right request; NOTHING there proves a handler ever calls it. That gap is
   * the silent one: a create/edit that skips the purge passes every posts test,
   * every type check, and every local run (where there may be no edge cache at
   * all) — and ships content that is stale for a full maxAge+swr window (25h).
   *
   * The `WEB` Service Binding is stubbed so the call is observable; the real
   * cross-Worker dispatch is proven end-to-end by e2e/publish.spec.ts.
   */
  let actor: Actor;

  /** Drive the Worker with a stubbed WEB binding, capturing every purge call. */
  async function fetchCapturingPurges(request: Request): Promise<{ response: Response; purges: string[][] }> {
    const purges: string[][] = [];
    const web = {
      fetch: async (_url: string, init: RequestInit) => {
        purges.push((JSON.parse(init.body as string) as { tags: string[] }).tags);
        return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
      },
    };
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, WEB: web } as never, ctx);
    await waitOnExecutionContext(ctx);
    return { response, purges };
  }

  beforeAll(async () => {
    actor = await createVerifiedActor();
  });

  describe("POST /posts purges on publish", () => {
    it("publishing purges author + listing in ONE call", async () => {
      const { response, purges } = await fetchCapturingPurges(createPostRequest(actor, "published"));
      expect(response.status).toBe(201);

      // ⚠️ ONE call, not one per tag. The Free-zone purge limit is 5 requests per
      // MINUTE — a call per tag spends an author's whole budget in under two edits.
      expect(purges).toHaveLength(1);
      // No `post:` tag: nothing has ever been cached for a post that did not exist
      // until now.
      expect(purges[0]).toEqual([`author:${actor.userId}`, "listing"]);
    });

    it("saving a DRAFT purges NOTHING", async () => {
      // A draft is not in any cached listing, so purging would spend a scarce
      // quota to invalidate nothing.
      const { response, purges } = await fetchCapturingPurges(createPostRequest(actor, "draft"));
      expect(response.status).toBe(201);
      expect(purges).toHaveLength(0);
    });
  });

  describe("PATCH /posts/:id purges on edit", () => {
    it("editing purges post + author + listing in ONE call", async () => {
      const id = await createPublished(actor);
      const { response, purges } = await fetchCapturingPurges(patchPostRequest(actor, id, "published"));
      expect(response.status).toBe(200);
      expect(purges).toHaveLength(1);
      expect(purges[0]).toEqual([`post:${id}`, `author:${actor.userId}`, "listing"]);
    });

    it("a 404 edit (another author's post) purges NOTHING", async () => {
      // The purge must sit AFTER the ownership check, or any caller could burn the
      // purge budget for a post they cannot touch.
      const id = await createPublished(actor);
      const attacker = await createVerifiedActor();
      const { response, purges } = await fetchCapturingPurges(patchPostRequest(attacker, id, "published"));
      expect(response.status).toBe(404);
      expect(purges).toHaveLength(0);
    });
  });

  describe("a purge failure NEVER fails the write", () => {
    it("still 200s when the purge hop rejects", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const id = await createPublished(actor);
      const web = { fetch: async () => new Response("nope", { status: 403 }) };
      const ctx = createExecutionContext();
      const response = await worker.fetch(patchPostRequest(actor, id, "published"), { ...env, WEB: web } as never, ctx);
      await waitOnExecutionContext(ctx);

      // ⚠️ THE POST IS ALREADY COMMITTED by the time the purge runs. Turning a
      // saved edit into a 500 because an invalidation failed would lose the user's
      // work over a cache. The cost is that the failure is SILENT to the user —
      // which is why alerting on `cache purge` is a deploy-gate item.
      expect(response.status).toBe(200);
      expect(error).toHaveBeenCalled();
    });
  });
  ```

  Add `createPostRequest`, `patchPostRequest` and `createPublished` to `apps/api/test/actor.ts` alongside `createVerifiedActor` (Task 9 Step 2 already extracted that file) — they are the same request builders `posts.test.ts` uses.

- [ ] **Step 8: Run → FAIL, then wire it.** `pnpm --filter @thinkersjournal/api test purge-wiring` → every `purges` assertion fails with `[]`: the handlers do not call it yet. Now add the two call sites to `apps/api/src/routes/posts.ts` — `import { purgeTags } from "../cache/purge";`, and replace the two Task-9 placeholder comments:

  In `handleCreatePost`, after `if (inserted === null) return errorResponse("SLUG_TAKEN", 409);`:

  ```ts
    // Publishing changes what a LISTING shows. There is no `post:` tag to purge —
    // nothing has ever been cached for a post that did not exist until now. A draft
    // purges NOTHING: it is in no cached listing, and purge quota is scarce.
    if (status === "published") {
      await purgeTags(env, [`author:${authorId}`, "listing"]);
    }
  ```

  In `handleUpdatePost`, after `if (updated === null) return notFound();` — ⚠️ **after** it, so a 404 cannot burn purge quota for a post the caller does not own:

  ```ts
    // ⚠️ ONE call, ALL tags. The Free-zone purge limit is 5 requests/MINUTE; a call
    // per tag would spend an author's whole budget in under two edits.
    // ⚠️ AWAITED, not fired into ctx.waitUntil(): the editor redirects to the post
    // page straight after this, and purging behind the response races that
    // redirect — showing the author their own stale post. Purge is ~10-50ms and
    // edits are rare. It NEVER throws (see src/cache/purge.ts): the post is already
    // committed, so a failed invalidation must not lose the user's work.
    await purgeTags(env, [`post:${updated.id}`, `author:${authorId}`, "listing"]);
  ```

  Also delete the "⚠️ NO CACHE PURGE HERE YET — Task 14 wires it in" paragraph from the file header (it is now false) and replace it with:

  ```ts
   * ⚠️ PURGE-ON-EDIT IS PART OF THE WRITE, not an afterthought. The tags here are
   * exactly the ones apps/web/src/lib/cache.ts sets on the public renders; a write
   * that skips the purge leaves that content stale for a full maxAge+swr window
   * (25 HOURS). test/purge-wiring.test.ts pins every call site.
  ```

- [ ] **Step 9: Run → PASS.** `pnpm --filter @thinkersjournal/api test` → all green, `posts.test.ts` included (⚠️ its assertions must be **untouched** — the purge is additive; if a posts test now fails, the wiring changed behaviour it should not have).
- [ ] **Step 10: Make the E2E's two-process topology carry the secret.** In `playwright.config.ts`, add `--var PURGE_SECRET:dev-purge-secret-not-for-production` to **both** `wrangler dev` commands (web and api), next to the existing `TEST_ROUTES` / Turnstile vars — the api→web hop must authenticate across processes exactly as it will in production. Add a note there: *"the purge hop is the one api→web direction; it works across the dev registry the same way web→api does."*
- [ ] **Step 11: Full sweep → PASS.** `pnpm --filter @thinkersjournal/api test` → green; `pnpm --filter @thinkersjournal/web typecheck` → exit 0; `pnpm --filter @thinkersjournal/web test` → the page inventory correctly **skips** `__internal/purge.ts` via `NOT_A_RENDERED_PAGE`; `pnpm typecheck` → exit 0.
- [ ] **Step 12: Commit.** `git add -A && git commit -m "feat(m1): cross-Worker purge hop (api -> web) + purge-on-edit wiring"`

### Task 15: SSR public post page `/@user/slug`

> The SEO/unfurl-critical page: read-time Markdown render, OG + JSON-LD, `Cache-Tag`s, `maxAge: 3600, swr: 86400`, and a CSP.
>
> ⚠️ **The routing shape.** Astro's file-based router is used as `src/pages/[handle]/[slug].astro`, **not** `src/pages/@[username]/[slug].astro`. A literal `@` in a directory name is unverified territory in Astro 7 on Windows; `[handle]` + an explicit `handle.startsWith("@")` check is unambiguous, works for certain, and gives us an explicit 404 for `/foo/bar`. Astro prioritises **static** segments over dynamic ones, so `/login`, `/new-post` and `/__internal/purge` still win.

**Files:** Create `apps/web/src/lib/{csp,json-ld,canonical}.ts`, `apps/web/src/pages/[handle]/[slug].astro`, `apps/web/test/json-ld.test.ts`.

**Interfaces — Produces:** `CANONICAL_ORIGIN`, `postUrl(username, slug)`, `profileUrl(username)` (`canonical.ts`); `setPublicPageCsp(context)` (`csp.ts`); `jsonLdScript(data: unknown): string` (`json-ld.ts`); the route `GET /@user/slug`.

- [ ] **Step 1: Write the failing test** (`apps/web/test/json-ld.test.ts`) — a real XSS vector, not a formality:

  ```ts
  import { describe, expect, it } from "vitest";

  import { jsonLdScript } from "../src/lib/json-ld";

  describe("jsonLdScript", () => {
    it("⚠️ escapes `<` so a title cannot break out of the <script> block", () => {
      // JSON.stringify does NOT escape `<` or `/`. A post titled
      // `</script><img src=x onerror=alert(1)>` would otherwise CLOSE the data
      // block and inject live markup — a stored XSS that bypasses the Markdown
      // sanitizer entirely, because the TITLE never goes through it.
      const out = jsonLdScript({ headline: "</script><img src=x onerror=alert(1)>" });
      expect(out).not.toContain("</script>");
      expect(out).toContain("\\u003c");
    });

    it("stays valid JSON after escaping", () => {
      const data = { headline: "a </script> b", url: "https://e.com/x" };
      expect(JSON.parse(jsonLdScript(data))).toEqual(data);
    });

    it("escapes every `<`, not just the first", () => {
      expect(jsonLdScript({ a: "<<<" })).not.toContain("<");
    });
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/web test json-ld` → module missing.
- [ ] **Step 3: Implement the three helpers.** `apps/web/src/lib/canonical.ts`:

  ```ts
  /**
   * The canonical public origin.
   *
   * ⚠️ NEVER derived from `Astro.url` / the request's Host header. Host is
   * client-supplied AND — critically — HOST IS NOT IN THE WORKERS CACHE KEY, so a
   * render is shared across apex, www, and *.workers.dev. A canonical/OG URL built
   * from the request would be cached with WHICHEVER host happened to fill the entry
   * first and then served under all of them. A constant is the only correct answer.
   * (Same reasoning as apps/api/src/routes/signup.ts's CANONICAL_ORIGIN.)
   */
  export const CANONICAL_ORIGIN = "https://thinkersjournal.com";

  export function profileUrl(username: string): string {
    return `${CANONICAL_ORIGIN}/@${encodeURIComponent(username)}`;
  }

  export function postUrl(username: string, slug: string): string {
    return `${profileUrl(username)}/${encodeURIComponent(slug)}`;
  }
  ```

  `apps/web/src/lib/json-ld.ts`:

  ```ts
  /**
   * Serialize data for a `<script type="application/ld+json">` block.
   *
   * ⚠️ THE ESCAPE IS A REAL XSS DEFENSE, NOT TIDINESS. JSON.stringify does not
   * escape `<`, so a post titled `</script><img src=x onerror=alert(1)>` would
   * close the data block and inject live markup. That path bypasses the Markdown
   * sanitizer completely — the TITLE never goes through packages/markdown — so this
   * function is the only thing standing in front of it. `<` is valid JSON and
   * parses back to `<`, so nothing is lost. test/json-ld.test.ts pins it.
   *
   * ⚠️ A ld+json BLOCK IS NOT SUBJECT TO `script-src`. CSP governs scripts that are
   * EXECUTED; a `<script>` with a non-JS type is an inert data block. So `script-src
   * 'self'` (src/lib/csp.ts) does NOT block this — and equally does not protect it.
   */
  export function jsonLdScript(data: unknown): string {
    return JSON.stringify(data).replace(/</g, "\\u003c");
  }
  ```

  `apps/web/src/lib/csp.ts`:

  ```ts
  /**
   * The Content-Security-Policy for public, CACHED pages.
   *
   * ⚠️ NO NONCES, AND THE REASON IS THE CACHE. Every viewer of a cached render
   * receives the SAME nonce, so a nonce-based CSP on this page is pure theatre —
   * an attacker reads the nonce out of the cached HTML like anyone else. Cached
   * pages get an ALLOWLIST policy or nothing.
   *
   * ⚠️ `script-src 'self'` — NO 'unsafe-inline'. This is the directive the whole
   * policy exists for, and the layer that still holds if rehype-sanitize ever
   * fails. Astro bundles `<script>` into external modules by default, so nothing
   * here needs inline script. Never add 'unsafe-inline' to this directive.
   *
   * ⚠️ `style-src` DOES carry 'unsafe-inline', deliberately. Shiki emits an inline
   * `style` attribute on every token span, and CSP has NO hash/nonce mechanism for
   * style ATTRIBUTES (CSP3's 'unsafe-hashes' would mean enumerating every token
   * colour). This is safe ONLY because of a property of the sanitizer: defaultSchema
   * has no `style` in `attributes`, so USER CONTENT CAN NEVER CARRY ONE — every
   * inline style on the page is app-generated, after sanitize. If that ever changes,
   * this line becomes wrong. Eliminating it (via @shikijs/transformers'
   * transformerStyleToClass + a static stylesheet) is recorded in the plan's
   * Deferred section.
   */
  import type { APIContext } from "astro";

  const PUBLIC_PAGE_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Post images come from the R2 custom domain and nowhere else. No `data:`:
    // packages/markdown's schema blocks data: URLs in `src` outright, so allowing
    // them here would only widen what a sanitizer failure could reach.
    "img-src 'self' https://cdn.thinkersjournal.com",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");

  /** Apply the public-page security headers. Every SSR public page calls this. */
  export function setPublicPageCsp(context: APIContext): void {
    context.response.headers.set("content-security-policy", PUBLIC_PAGE_CSP);
    // Belt-and-braces for the media path too: never let a browser sniff a served
    // byte stream into something executable.
    context.response.headers.set("x-content-type-options", "nosniff");
    context.response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  ```

- [ ] **Step 4: Implement the page** (`apps/web/src/pages/[handle]/[slug].astro`):

  ```astro
  ---
  /**
   * `/@user/slug` — the public post page. The SEO/unfurl-critical render, and the
   * one M1 page whose output is edge-cached for hours.
   *
   * ⚠️ THIS RENDER IS FULLY ANONYMOUS, BY CONSTRUCTION. The api call below omits
   * `request`, so src/lib/api.ts does NOT forward the browser's Cookie — the api
   * cannot resolve a session, and there is therefore no viewer-specific value in
   * this render to leak. That is the DEFENSE. Cookie is not in the Workers Cache
   * key and does not trigger bypass, so a cacheable render carrying viewer state is
   * served to EVERYONE. markPublicCacheable's cookie check is belt-and-braces.
   * ⚠️ DO NOT add `request: Astro.request` to that call to "personalize" anything.
   * Viewer state (an Edit link, reactions) hydrates CLIENT-SIDE.
   *
   * ⚠️ ROUTING: `[handle]`, not a literal `@[username]` directory. `@` in a folder
   * name is unverified territory in Astro 7; an explicit startsWith("@") check is
   * unambiguous and gives a real 404 for `/foo/bar`. Static routes (/login,
   * /new-post, /__internal/purge) still win — Astro prioritizes static segments.
   */
  import { markdownExcerpt, renderMarkdown } from "@thinkersjournal/markdown";
  import type { PublicPost } from "@thinkersjournal/shared";

  import { apiFetch } from "../../lib/api";
  import { markPublicCacheable } from "../../lib/cache";
  import { postUrl, profileUrl } from "../../lib/canonical";
  import { setPublicPageCsp } from "../../lib/csp";
  import { jsonLdScript } from "../../lib/json-ld";

  const { handle, slug } = Astro.params;
  if (handle === undefined || slug === undefined || !handle.startsWith("@")) {
    return new Response(null, { status: 404 });
  }
  const username = handle.slice(1);
  if (username === "") return new Response(null, { status: 404 });

  // ⚠️ ANONYMOUS — no `request`, so no Cookie is forwarded. See the header.
  const response = await apiFetch<PublicPost>(
    `/public/posts?username=${encodeURIComponent(username)}&slug=${encodeURIComponent(slug)}`,
  );
  if (response.status !== 200 || response.data === null) {
    // A draft and a nonexistent post are the same answer here because the api
    // makes them the same answer (apps/api/src/routes/public.ts).
    return new Response(null, { status: 404 });
  }
  const post = response.data;

  // READ-TIME RENDER. markdown_source is the single source of truth; no HTML is
  // ever stored. This is what makes a sanitizer fix a DEPLOY (plus a
  // PIPELINE_VERSION bump) rather than a backfill of every row.
  const html = await renderMarkdown(post.markdownSource);
  const description = markdownExcerpt(post.markdownSource);
  const canonical = postUrl(post.username, post.slug);

  markPublicCacheable(Astro, [
    // `post:<id>`   — this page. Purged on every edit of this post.
    // `author:<id>` — every page listing this author. Purged on any of their edits.
    // `listing`     — sitemap/RSS/site-wide listings.
    // apps/api/src/routes/posts.ts purges all three in ONE batched call.
    `post:${post.id}`,
    `author:${post.authorId}`,
    "listing",
  ]);
  setPublicPageCsp(Astro);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    author: { "@type": "Person", name: post.displayName ?? post.username, url: profileUrl(post.username) },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
  };
  ---

  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{post.title}</title>
      <meta name="description" content={description} />
      {/* ⚠️ Built from a CONSTANT origin, never Astro.url — HOST IS NOT IN THE
          CACHE KEY, so a host-derived canonical would be cached under whichever
          host filled the entry and served under all of them. */}
      <link rel="canonical" href={canonical} />

      <meta property="og:type" content="article" />
      <meta property="og:title" content={post.title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="article:published_time" content={post.publishedAt} />
      <meta property="article:modified_time" content={post.updatedAt} />
      <meta property="article:author" content={post.displayName ?? post.username} />
      <meta name="twitter:card" content="summary_large_image" />

      {/* ⚠️ jsonLdScript, NEVER a bare JSON.stringify: it does not escape `<`, so a
          title containing `</script>` would close this block and inject markup —
          a path that bypasses the Markdown sanitizer entirely. A ld+json block is
          NOT subject to script-src (it is inert data, never executed), so the CSP
          neither blocks it nor protects it. See src/lib/json-ld.ts. */}
      <script type="application/ld+json" set:html={jsonLdScript(jsonLd)} />
    </head>
    <body>
      <article>
        <h1>{post.title}</h1>
        <p>
          <a href={`/@${post.username}`}>{post.displayName ?? post.username}</a>
          <time datetime={post.publishedAt}>{new Date(post.publishedAt).toISOString().slice(0, 10)}</time>
        </p>
        {/* ⚠️ THE ONE PLACE THIS APP EMITS UNESCAPED HTML. It is safe for exactly
            one reason: `html` came out of packages/markdown, whose LAST UNSAFE
            THING is rehype-sanitize. Never `set:html` anything else here, and never
            interpolate a user value into this element. */}
        <div id="post-body" set:html={html} />
      </article>
    </body>
  </html>
  ```

- [ ] **Step 5: Run → PASS + verify the whole contract by hand.** `pnpm --filter @thinkersjournal/web test` (json-ld + the cache inventory, which now covers the new page) and `typecheck` → exit 0. Then, with Docker up and **no `wrangler dev` running**:

  ```bash
  pnpm --filter @thinkersjournal/web build
  # api on :8788 (its own primary — DEV ONLY), web on :8787. See playwright.config.ts.
  # Publish a post through the api, then:
  curl -is http://127.0.0.1:8787/@<username>/<slug> | head -30
  ```

  **Assert by eye, then encode in Task 19:**
  - `cloudflare-cdn-cache-control: public, max-age=3600, stale-while-revalidate=86400` — ⚠️ **NOT `cache-control`** (that is the standard header; the Astro Cloudflare provider writes the CDN-specific one — verified against the installed adapter in Task 12) — **and NO `s-maxage`, no `must-revalidate`** (either silently kills SWR).
  - `cache-tag:` contains `post:…`, `author:…`, `listing`, `pipeline:v1`. ⚠️ **LOCAL-DEV-ONLY.** There is no real Cloudflare edge in front of `wrangler dev`, so the header passes straight through unstripped here — this is a legitimate way to pin what OUR code emits, but it is NOT reproducible against a real deployed page: Cloudflare's edge consumes `Cache-Tag` for its purge index and strips it before the response reaches any client. The deploy-gate's client-visible proof that caching is real is `Cf-Cache-Status` (`MISS` then `HIT`), not this header — see Task 20.
  - `content-security-policy:` present, `script-src 'self'` with no `unsafe-inline`.
  - Re-run **with** `-H "Cookie: tj_session=anything"` → `cache-control: private, no-store` (this one IS the standard header — `markPrivate` sets it by hand, deliberately, unaffected by the provider naming above) and **no `cache-tag`**. ⚠️ If the authed render is still cacheable, **stop** — that is the mass-session-leak condition, and nothing else in M1 matters until it is fixed.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(m1): SSR public post page with OG, JSON-LD, cache tags and a CSP"`

### Task 16: SSR public profile page `/@user`

**Files:** Create `apps/web/src/pages/[handle]/index.astro`.

**Interfaces — Consumes:** `GET /public/profile?username=&cursor=`, `markPublicCacheable`, `setPublicPageCsp`, `markdownExcerpt`, `profileUrl`. **Produces:** the route `GET /@user`.

- [ ] **Step 1: Implement** (`apps/web/src/pages/[handle]/index.astro`):

  ```astro
  ---
  /**
   * `/@user` — the public profile: a keyset-paginated listing of published posts.
   *
   * ⚠️ ANONYMOUS BY CONSTRUCTION, exactly as [slug].astro. No `request` on the api
   * call ⇒ no Cookie forwarded ⇒ nothing viewer-specific in the render. See
   * src/lib/cache.ts.
   *
   * ⚠️ KEYSET, NOT OFFSET. `?cursor=<last-seen-id>` with `ORDER BY id DESC`: v7 ids
   * are time-ordered, so that IS newest-first, and it needs no created_at index
   * (that is the whole payoff of the v7 decision). Offset pagination would also
   * SKIP or DUPLICATE rows whenever a post is published mid-scroll, and would get
   * linearly slower with depth.
   *
   * ⚠️ EACH CURSOR PAGE IS ITS OWN CACHE ENTRY — the query string IS in the cache
   * key. They all carry `author:<id>`, so one purge drops every page of this
   * author's listing at once.
   */
  import { markdownExcerpt } from "@thinkersjournal/markdown";
  import type { PublicProfile } from "@thinkersjournal/shared";

  import { apiFetch } from "../../lib/api";
  import { markPublicCacheable } from "../../lib/cache";
  import { profileUrl } from "../../lib/canonical";
  import { setPublicPageCsp } from "../../lib/csp";

  const { handle } = Astro.params;
  if (handle === undefined || !handle.startsWith("@")) {
    return new Response(null, { status: 404 });
  }
  const username = handle.slice(1);
  if (username === "") return new Response(null, { status: 404 });

  const cursor = Astro.url.searchParams.get("cursor");
  const query = new URLSearchParams({ username });
  if (cursor !== null) query.set("cursor", cursor);

  // ⚠️ ANONYMOUS — no `request`. See the header.
  const response = await apiFetch<PublicProfile>(`/public/profile?${query.toString()}`);
  if (response.status !== 200 || response.data === null) {
    // Includes the api's 400 on a malformed cursor: a hand-edited URL is a 404 to
    // a reader, not an error page.
    return new Response(null, { status: 404 });
  }
  const profile = response.data;

  markPublicCacheable(Astro, [`author:${profile.userId}`, "listing"]);
  setPublicPageCsp(Astro);

  const canonical = profileUrl(profile.username);
  const displayName = profile.displayName ?? profile.username;
  const description = profile.bio ?? `Posts by ${displayName} on Thinker's Journal.`;
  const nextHref =
    profile.nextCursor === null ? null : `/@${profile.username}?cursor=${encodeURIComponent(profile.nextCursor)}`;
  ---

  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{displayName}</title>
      <meta name="description" content={description} />
      {/* Always the FIRST page's URL: a cursor page is the same collection, and
          pointing each at itself would split the profile's ranking across pages. */}
      <link rel="canonical" href={canonical} />
      {/* Cursor pages are pagination, not content — keep them out of the index
          while still letting a crawler follow through to the posts. */}
      {cursor !== null && <meta name="robots" content="noindex, follow" />}
      <meta property="og:type" content="profile" />
      <meta property="og:title" content={displayName} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
    </head>
    <body>
      <h1>{displayName}</h1>
      {profile.bio !== null && <p>{profile.bio}</p>}

      {
        profile.posts.length === 0 ? (
          <p id="no-posts">No posts yet.</p>
        ) : (
          <ul>
            {profile.posts.map((post) => (
              <li>
                <a href={`/@${profile.username}/${post.slug}`}>{post.title}</a>
                {/* markdownExcerpt returns TEXT; Astro escapes it into the element.
                    Never set:html here — this is untrusted source, unsanitized. */}
                <p>{markdownExcerpt(post.excerptSource)}</p>
                <time datetime={post.publishedAt}>{new Date(post.publishedAt).toISOString().slice(0, 10)}</time>
              </li>
            ))}
          </ul>
        )
      }

      {nextHref !== null && <a id="next-page" rel="next" href={nextHref}>Older posts</a>}
    </body>
  </html>
  ```

- [ ] **Step 2: Run → PASS.** `pnpm --filter @thinkersjournal/web test` → the cache inventory covers the new page automatically. `pnpm --filter @thinkersjournal/web typecheck` → exit 0.
- [ ] **Step 3: Verify by hand.** Build + run both Workers; publish 25 posts for one author, then:

  ```bash
  curl -s http://127.0.0.1:8787/@<username> | rg -c '<li>'          # EXPECT: 20
  curl -is http://127.0.0.1:8787/@<username> | rg 'cache-tag|cloudflare-cdn-cache-control'
  #   EXPECT: cache-tag: author:…, listing, pipeline:v1  (NO post: tag)
  #   (plus Astro core's own astro-path:/@<username> — unconditional on every
  #   cacheable response, and something our purge flow never targets, so harmless.)
  #   ⚠️ LOCAL-DEV-ONLY — no real edge to strip it here; not observable against a
  #   real deploy (Cf-Cache-Status is the deploy-gate proof, see Task 20).
  #   EXPECT: cloudflare-cdn-cache-control: public, max-age=3600, stale-while-revalidate=86400
  #   ⚠️ NOT `cache-control` — that is the standard header name, not what the
  #   Astro Cloudflare provider writes (verified against the installed adapter,
  #   Task 12).
  curl -s "http://127.0.0.1:8787/@<username>?cursor=<nextCursor>" | rg -c '<li>'   # EXPECT: 5
  curl -s http://127.0.0.1:8787/@nobody -o /dev/null -w '%{http_code}'             # EXPECT: 404
  curl -s http://127.0.0.1:8787/notahandle -o /dev/null -w '%{http_code}'          # EXPECT: 404
  ```

- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(m1): SSR public profile page with v7 keyset pagination"`

### Task 17: The editor

> **"Keep it minimal; no heavy framework."** So: **no framework at all.** The page is a plain form that POSTs back to itself; **preview is server-side**, through the *same* `renderMarkdown` the public page uses — which means the preview is not an approximation of the post, it is byte-identical to it, with zero extra JS and no second renderer to drift.
>
> The **one** thing that genuinely needs client JS is media upload (a file must reach the server without a full page navigation). That is the island: ~40 lines of vanilla JS in an Astro `<script>`, which Astro bundles into an external module — so `script-src 'self'` holds with no inline script.
>
> One page serves create **and** edit (`?post=<id>`): two pages would be two copies of the same form and the same submit logic.

**Files:** Rewrite `apps/web/src/pages/new-post.astro`. Create `apps/web/src/pages/media-upload.ts`. Modify `apps/web/src/lib/api.ts` (add `rawBody`), **`apps/api/src/routes/posts.ts` + `apps/api/test/posts.test.ts`** (Step 3's ⚠️: the create/edit responses gain `username`, which the publish redirect needs).

**Interfaces — Produces:** `GET/POST /new-post`, `GET /new-post?post=<id>`, `POST /media-upload` (a same-origin proxy to the api's `POST /media`). `ApiFetchOptions.rawBody?: BodyInit`.

- [ ] **Step 1: Teach `apiFetch` about raw bodies.** In `apps/web/src/lib/api.ts`, add to `ApiFetchOptions`:

  ```ts
    /**
     * A raw body, forwarded UNTOUCHED — no JSON serialization, no content-type.
     *
     * For binary passthrough (POST /media takes raw image bytes; see that route's
     * header for why it is not multipart). Mutually exclusive with `body`: setting
     * both would serialize one and drop the other silently.
     *
     * ⚠️ Pass a ReadableStream (`Astro.request.body`) rather than buffering: a 15MB
     * upload buffered here would be a 15MB allocation in a 128MB Worker, on top of
     * the one the api makes.
     */
    rawBody?: BodyInit;
  ```

  and in `apiFetch`, destructure `rawBody` and replace the body spread with:

  ```ts
    // `body` (JSON) and `rawBody` (passthrough) are mutually exclusive; rawBody
    // wins if both are somehow set, and the type comment says not to.
    const outgoingBody: BodyInit | undefined =
      rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;

    const response = await env.API.fetch(`${SERVICE_ORIGIN}${path}`, {
      method,
      headers,
      ...(outgoingBody !== undefined && { body: outgoingBody }),
    });
  ```

  ⚠️ Keep `if (body !== undefined) headers.set("content-type", "application/json");` **exactly as is** — `rawBody` must *not* set a content-type. The api ignores it and sniffs the bytes; sending one would only invite someone to trust it.

- [ ] **Step 2: Write the upload proxy** (`apps/web/src/pages/media-upload.ts`):

  ```ts
  /**
   * `POST /media-upload` — the same-origin proxy the editor uploads through.
   *
   * ⚠️ WHY A PROXY AND NOT A DIRECT CALL. The api has NO public route (and gets
   * `workers_dev: false` at launch): the browser can only ever talk to `web`. That
   * is the topology's whole security property — every mutating request is
   * same-origin by construction, which is what makes the api's Origin allowlist
   * meaningful. So the bytes come here and go on over the Service Binding.
   *
   * ⚠️ THE BODY IS STREAMED, NOT BUFFERED. `Astro.request.body` is passed straight
   * through: buffering a 15MB upload here would be a 15MB allocation in a
   * 128MB Worker, on top of the one the api makes. The api enforces the cap (it is
   * the one that must — this Worker's checks are convenience, not defense).
   *
   * ⚠️ NOTHING IS VALIDATED HERE. The sniff, the size cap, the quota and the
   * transform ALL live in the api (apps/api/src/routes/media.ts). Duplicating any
   * of them here would create a second copy to drift, and this Worker is not the
   * trust boundary.
   */
  import { markPrivate } from "../lib/cache";
  import { apiFetch, applyCookies } from "../lib/api";

  import type { APIRoute } from "astro";

  export const prerender = false;

  export const POST: APIRoute = async (context) => {
    // Per-viewer by definition — an upload is an authenticated act.
    markPrivate(context);

    const response = await apiFetch<unknown>("/media", {
      method: "POST",
      // Forwards the session cookie — the api resolves the uploader from it.
      request: context.request,
      // ⚠️ The BROWSER's Origin, verbatim. NEVER Astro.url.origin, which would
      // launder a cross-site request into an allowlisted one. See src/lib/api.ts.
      origin: context.request.headers.get("Origin") ?? "",
      csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
      rawBody: context.request.body ?? undefined,
    });

    // The api can clear the cookie on a revoked session (pipeline step 4).
    applyCookies(context.response.headers, response.setCookies);

    return new Response(response.text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  ```

  ⚠️ **`rawBody` + `duplex`**: if workerd rejects a streamed request body without `duplex: "half"`, add it to the `env.API.fetch` init in `apiFetch` **with a comment naming the error it fixes**. Verify with the Step 6 hand-test before assuming either way.

- [ ] **Step 3: Rewrite the editor** (`apps/web/src/pages/new-post.astro`) — **keep the M0 file's entire CSRF explanation**; it is still exactly why the form works this way:

  ```astro
  ---
  /**
   * The Markdown editor — create (`/new-post`) and edit (`/new-post?post=<id>`).
   *
   * ONE page for both: two pages would be two copies of the same form and the same
   * submit logic, drifting from the day the second was written.
   *
   * ⚠️ PREVIEW IS SERVER-SIDE, through the SAME renderMarkdown the public page
   * uses. That is not a shortcut — it is the point: the preview is not an
   * approximation of the post, it IS the post, with zero extra JS shipped and no
   * second renderer to drift out of sync with the sanitizer.
   *
   * ⚠️ HOW THE CSRF TOKEN GETS HERE (unchanged from M0 — do not simplify). The api
   * requires `X-CSRF-Token` = sha256Hex(session.csrfSecret) on every mutating
   * request. `csrfSecret` lives only in the api's KV session record, so THIS Worker
   * cannot compute it — it fetches it from `GET /auth/csrf` over the Service
   * Binding, forwarding the browser's session cookie, and embeds it below as a
   * hidden input.
   *
   * ⚠️ WHY A HIDDEN INPUT AND NOT A COOKIE. A non-HttpOnly cookie would be readable
   * by any injected script AND would ride along on cross-site requests
   * automatically — precisely the property the double-submit exists to deny.
   * Rendered into the page body, the token is reachable only by someone who could
   * already read an authenticated response from this origin.
   *
   * ⚠️ WHY THE FORM POSTS TO THIS PAGE RATHER THAN TO THE API. An HTML form cannot
   * set a request HEADER — there is no markup for it — so a form could never
   * satisfy `X-CSRF-Token`, and the api accepts the token in NO other place (by
   * design: a header is exactly what a cross-site form cannot forge). So the form
   * posts back here same-origin, and this component promotes the hidden field to a
   * real header on the Service-Binding call.
   */
  import { renderMarkdown } from "@thinkersjournal/markdown";
  import type { AuthoredPost } from "@thinkersjournal/shared";

  import { apiErrorCode, apiFetch, applyCookies } from "../lib/api";
  import { markPrivate } from "../lib/cache";

  // ⚠️ Per-session secrets (the CSRF token below) and unpublished text are rendered
  // here — never let a shared cache hold this. Cookie is NOT in the cache key.
  markPrivate(Astro);

  type Outcome = "saved" | "published" | "unauthenticated" | "unverified" | "error" | null;
  let outcome: Outcome = null;
  let message = "";
  let previewHtml: string | null = null;

  const origin = Astro.request.headers.get("Origin") ?? "";

  /** Fetch the CSRF token for the caller's session on EVERY render — GET and the
   * re-render after a POST alike — so the freshly-rendered form always carries a
   * token matching the CURRENT session (after logout-all + re-login, a stale one
   * would 403). 401 here simply means "not logged in": a normal state, not a
   * failure. */
  const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: Astro.request });
  const csrfToken = csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null;

  let postId = Astro.url.searchParams.get("post");
  let title = "";
  let markdownSource = "";

  if (Astro.request.method === "POST") {
    const form = await Astro.request.formData();
    const intent = String(form.get("intent") ?? "draft");
    title = String(form.get("title") ?? "");
    markdownSource = String(form.get("markdownSource") ?? "");
    postId = String(form.get("postId") ?? "") || null;
    const submittedToken = String(form.get("csrfToken") ?? "");

    if (intent === "preview") {
      // Pure render — no api call, no mutation, no auth needed beyond being here.
      previewHtml = await renderMarkdown(markdownSource);
    } else {
      const status = intent === "publish" ? "published" : "draft";
      const response =
        postId === null
          ? await apiFetch<{ id: string; slug: string }>("/posts", {
              method: "POST",
              body: { title, markdownSource, status },
              request: Astro.request,
              // ⚠️ The BROWSER's Origin, forwarded verbatim — never this app's own,
              // which would launder a cross-site request into an allowlisted one.
              origin,
              csrfToken: submittedToken,
            })
          : await apiFetch<{ id: string; slug: string }>(`/posts/${encodeURIComponent(postId)}`, {
              method: "PATCH",
              body: { title, markdownSource, status },
              request: Astro.request,
              origin,
              csrfToken: submittedToken,
            });

      // ⚠️ Load-bearing on the 401 path: the api answers a REVOKED session with 401
      // PLUS a cleared cookie (pipeline step 4). Dropping that header leaves the
      // dead cookie in the browser, so the user is stuck re-sending a session that
      // can only ever 401 again instead of being cleanly logged out.
      applyCookies(Astro.response.headers, response.setCookies);

      if (response.status === 201 || response.status === 200) {
        postId = response.data?.id ?? postId;
        outcome = status === "published" ? "published" : "saved";
        if (status === "published" && response.data !== null) {
          // The api has already purged the edge tags (awaited, not fired behind the
          // response — see apps/api/src/routes/posts.ts), so this redirect lands on
          // a freshly-rendered page rather than racing the purge.
          return Astro.redirect(`/@${username}/${response.data.slug}`);
        }
      } else if (response.status === 401) {
        outcome = "unauthenticated";
      } else if (apiErrorCode(response) === "EMAIL_NOT_VERIFIED") {
        // The soft gate: authenticated, but content mutation needs a verified
        // address. Distinct from a CSRF/origin 403, which shares the status.
        outcome = "unverified";
      } else {
        outcome = "error";
        message = `Could not save (status ${response.status}).`;
      }
    }
  }

  // Load an existing post for editing. AFTER the POST branch so a just-created
  // post's id is honoured, and only for a GET — a POST already has the text.
  if (postId !== null && Astro.request.method === "GET") {
    const existing = await apiFetch<AuthoredPost>(`/posts/${encodeURIComponent(postId)}`, {
      request: Astro.request,
    });
    if (existing.status === 200 && existing.data !== null) {
      title = existing.data.title;
      markdownSource = existing.data.markdownSource;
    } else {
      // 404 covers "not yours" too — the api never distinguishes them.
      return new Response(null, { status: 404 });
    }
  }

  const loginHref = `/login?next=${encodeURIComponent(Astro.url.pathname + Astro.url.search)}`;
  ---

  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>{postId === null ? "New post" : "Edit post"}</title>
    </head>
    <body>
      <h1>{postId === null ? "New post" : "Edit post"}</h1>

      {outcome === "saved" && <p id="saved">Draft saved.</p>}
      {outcome === "published" && <p id="published">Published.</p>}
      {outcome === "unverified" && <p id="unverified">Please verify your email address before posting.</p>}
      {outcome === "unauthenticated" && <p id="session-expired">Your session has expired. Please log in again.</p>}
      {outcome === "error" && <p id="error">{message}</p>}

      {
        csrfToken === null ? (
          <p id="login-required"><a href={loginHref}>Log in to write a post</a></p>
        ) : (
          <form method="POST" id="editor-form">
            {/* The api's per-session CSRF token, promoted to the X-CSRF-Token header
                server-side on submit (see the frontmatter) — a form cannot set a
                header itself. */}
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <input type="hidden" name="postId" value={postId ?? ""} />
            <label>Title <input type="text" id="title" name="title" value={title} required /></label>
            <label>
              Body (Markdown)
              <textarea id="markdownSource" name="markdownSource" rows="24" required>{markdownSource}</textarea>
            </label>

            <fieldset>
              <legend>Insert an image</legend>
              {/* NOT inside a nested form — HTML forbids that. The island below
                  uploads it with fetch() and writes the Markdown into the textarea. */}
              <input type="file" id="media-file" accept="image/jpeg,image/png,image/gif,image/webp" />
              <p id="media-status" role="status"></p>
            </fieldset>

            <button type="submit" name="intent" value="preview">Preview</button>
            <button type="submit" name="intent" value="draft">Save draft</button>
            <button type="submit" name="intent" value="publish">Publish</button>
          </form>
        )
      }

      {
        previewHtml !== null && (
          <section id="preview">
            <h2>Preview</h2>
            {/* Safe for the SAME one reason as the public page: this string came out
                of packages/markdown, whose LAST UNSAFE THING is rehype-sanitize.
                And it is the same function, so what you see IS what publishes. */}
            <div set:html={previewHtml} />
          </section>
        )
      }

      <script>
        /**
         * THE ONE ISLAND. Everything else on this page is a plain form POST; a file
         * is the one thing that cannot reach the server without JS.
         *
         * Astro bundles this into an EXTERNAL module (`<script type="module" src=…>`),
         * so `script-src 'self'` holds with no inline script and no nonce — which
         * matters because nonces are useless on cached pages (src/lib/csp.ts).
         *
         * ⚠️ Uploads to /media-upload (same-origin), NOT to the api: the api has no
         * public route, and same-origin-by-construction is what makes its Origin
         * allowlist meaningful.
         */
        const input = document.querySelector<HTMLInputElement>("#media-file");
        const status = document.querySelector<HTMLParagraphElement>("#media-status");
        const textarea = document.querySelector<HTMLTextAreaElement>("#markdownSource");
        const tokenField = document.querySelector<HTMLInputElement>("input[name='csrfToken']");

        input?.addEventListener("change", async () => {
          const file = input.files?.[0];
          if (file === undefined || status === null || textarea === null || tokenField === null) return;

          status.textContent = "Uploading…";
          input.disabled = true;
          try {
            const response = await fetch("/media-upload", {
              method: "POST",
              // The api demands this header and a form cannot set one — which is
              // exactly why the token round-trips through the page.
              headers: { "X-CSRF-Token": tokenField.value },
              // The raw File. No multipart: /media takes bytes (see its header).
              body: file,
            });
            const data = (await response.json()) as { url?: string; code?: string };
            if (!response.ok || data.url === undefined) {
              // The api's error envelope: {code, message?}. Show the code — the
              // messages are deliberately generic (they must not echo a filename).
              status.textContent = `Upload failed (${data.code ?? response.status}).`;
              return;
            }
            // Insert at the cursor rather than appending: an image belongs where the
            // author was typing.
            const at = textarea.selectionStart;
            const markdown = `\n![](${data.url})\n`;
            textarea.value = textarea.value.slice(0, at) + markdown + textarea.value.slice(at);
            status.textContent = "Inserted.";
          } catch {
            status.textContent = "Upload failed.";
          } finally {
            input.disabled = false;
            input.value = "";
          }
        });
      </script>
    </body>
  </html>
  ```

  ⚠️ **`username` in the publish redirect is not in scope.** Fix it by having `GET /auth/csrf` remain untouched and instead reading the author's username once: add `const me = await apiFetch<{ username: string }>("/auth/csrf", …)`? **No** — that conflates two concerns. Instead have `POST /posts` and `PATCH /posts/:id` **return `username`** alongside `id`/`slug` (they already join nothing, so add `RETURNING` + one `SELECT username FROM profiles WHERE user_id = $1` inside the same `withClient`), extend the response type to `{ id, slug, status, username }`, and redirect with `response.data.username`. Update Task 9's tests to assert the added field.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test` (the cache inventory now covers `new-post.astro` and `media-upload.ts`) and `typecheck` → exit 0; re-run the **api** suite for the `username` addition.
- [ ] **Step 5: Verify by hand.** Build, run both Workers, log in as a verified user:
  - `/new-post` → Preview renders; `Save draft` → "Draft saved."; the URL keeps `?post=<id>` on reload and the form is prefilled.
  - Upload a PNG → an `![](https://cdn.thinkersjournal.com/media/post/<hash>.webp)` appears at the cursor.
  - `Publish` → redirected to `/@user/slug`, which renders the body.
  - Open `/new-post?post=<someone else's id>` → **404**.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(m1): the Markdown editor — server-side preview, media upload island, draft/publish"`

### Task 18: `sitemap.xml` + `rss.xml`

> ⚠️ **These are the ONLY M1 renders that use `HYPERDRIVE_CACHED`, and the only ones that are UNTAGGED.** The two facts are the same fact. Untagged means nothing purges them, which means their edge entry is never invalidated, which means the first render after an edit is **not** a read-after-write — so Hyperdrive's 60s window is a strict subset of the 60s of staleness the short TTL already accepts. **Tag one of these pages and that stops being true**, and the binding must change with it. See the amended Global Constraint.
>
> They get `maxAge: 60, swr: 600` — the spec's decision #20 values, applied to exactly the shape decision #20 described.

**Files:** Create `apps/web/src/lib/xml.ts`, `apps/web/src/pages/sitemap.xml.ts`, `apps/web/src/pages/rss.xml.ts`, `apps/web/test/xml.test.ts`.

**Interfaces — Produces:** `escapeXml(value: string): string`; routes `GET /sitemap.xml`, `GET /rss.xml`.

- [ ] **Step 1: Write the failing test** (`apps/web/test/xml.test.ts`):

  ```ts
  import { describe, expect, it } from "vitest";

  import { escapeXml } from "../src/lib/xml";

  describe("escapeXml", () => {
    it("escapes every XML metacharacter", () => {
      expect(escapeXml(`<a href="x" & 'y'>`)).toBe("&lt;a href=&quot;x&quot; &amp; &apos;y&apos;&gt;");
    });

    it("escapes & FIRST so nothing is double-escaped", () => {
      // `&lt;` -> `&amp;lt;`, never `&amp;amp;lt;`. Same trap as
      // apps/api/src/auth/email-verify.ts's escapeHtml.
      expect(escapeXml("&lt;")).toBe("&amp;lt;");
    });

    it("⚠️ makes a title unable to break out of a feed element", () => {
      // A post titled `</title><script>…` would otherwise close the element and
      // inject markup into a document some readers render as HTML. The title never
      // goes through packages/markdown, so this function is the only guard.
      expect(escapeXml("</title><script>alert(1)</script>")).not.toContain("<");
    });

    it("leaves ordinary text alone", () => {
      expect(escapeXml("Hello, world — 2026")).toBe("Hello, world — 2026");
    });
  });
  ```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/web test xml` → module missing.
- [ ] **Step 3: Implement** (`apps/web/src/lib/xml.ts`):

  ```ts
  /**
   * Escape text for interpolation into an XML element or attribute.
   *
   * ⚠️ `&` MUST be replaced FIRST or the other replacements' ampersands are
   * double-escaped (`&lt;` -> `&amp;amp;lt;`). Same trap, same order, as
   * apps/api/src/auth/email-verify.ts's escapeHtml.
   *
   * ⚠️ THIS IS A REAL INJECTION DEFENSE. Titles and excerpts go into sitemap.xml
   * and rss.xml as raw string interpolation — Astro's templating is nowhere near
   * these files. A post titled `</title><script>alert(1)</script>` would otherwise
   * break out of the element, into a document plenty of feed readers render as
   * HTML. Neither the title nor the excerpt ever passes through packages/markdown,
   * so nothing else guards this path.
   */
  export function escapeXml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
  ```

- [ ] **Step 4: Implement the sitemap** (`apps/web/src/pages/sitemap.xml.ts`):

  ```ts
  /**
   * `GET /sitemap.xml`.
   *
   * ⚠️ UNTAGGED AND SHORT-TTL, AND THAT IS WHY /public/recent MAY READ THROUGH
   * HYPERDRIVE_CACHED. Nothing purges this entry, so the first render after an edit
   * is not a read-after-write and Hyperdrive's 60s window is a subset of the 60s
   * staleness this TTL already accepts. ⚠️ ADD A CACHE TAG HERE AND THAT REASONING
   * COLLAPSES — a purge would then re-cache a stale listing for the full window.
   * The binding in apps/api/src/routes/public.ts would have to change with it.
   *
   * A crawler that sees a post 60s late is not a defect; that is the whole reason
   * this shape exists.
   */
  import type { RecentPost } from "@thinkersjournal/shared";
  import type { APIRoute } from "astro";

  import { apiFetch } from "../lib/api";
  import { markFeedCacheable } from "../lib/cache";
  import { CANONICAL_ORIGIN, postUrl, profileUrl } from "../lib/canonical";
  import { escapeXml } from "../lib/xml";

  export const prerender = false;

  export const GET: APIRoute = async (context) => {
    markFeedCacheable(context);

    // ⚠️ ANONYMOUS — no `request`, so no Cookie is forwarded. A sitemap that varied
    // by viewer would be cached under one viewer and served to every crawler.
    const response = await apiFetch<{ posts: RecentPost[] }>("/public/recent");
    const posts = response.status === 200 ? (response.data?.posts ?? []) : [];

    // Unique authors — a profile is a page too, and this avoids a second query.
    const profiles = [...new Set(posts.map((p) => p.username))];

    const urls = [
      `<url><loc>${escapeXml(CANONICAL_ORIGIN)}/</loc></url>`,
      ...profiles.map((u) => `<url><loc>${escapeXml(profileUrl(u))}</loc></url>`),
      ...posts.map(
        (p) =>
          `<url><loc>${escapeXml(postUrl(p.username, p.slug))}</loc><lastmod>${escapeXml(
            new Date(p.updatedAt).toISOString(),
          )}</lastmod></url>`,
      ),
    ].join("");

    // ⚠️ The api caps /public/recent at 1000. The sitemap protocol's limit is
    // 50,000 URLs / 50MB, so we are far inside it — but a sitemap INDEX (and real
    // pagination on that route) is required before this site has 50k posts. M2.
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      { status: 200, headers: { "content-type": "application/xml; charset=utf-8" } },
    );
  };
  ```

- [ ] **Step 5: Implement the feed** (`apps/web/src/pages/rss.xml.ts`):

  ```ts
  /**
   * `GET /rss.xml` — the site-wide feed of the 20 most recent published posts.
   *
   * ⚠️ Same shape and same reasoning as sitemap.xml: UNTAGGED, short-TTL, which is
   * what licenses /public/recent's HYPERDRIVE_CACHED read. A subscriber seeing a
   * post up to ~2 minutes late (60s edge + 60s Hyperdrive) is normal for RSS.
   *
   * ⚠️ EXCERPTS, NOT BODIES. The feed carries `<description>` only — never rendered
   * HTML. Feed readers are a wildly varied set of HTML renderers with their own
   * sanitizers (or none), so shipping post bodies would put our XSS posture in
   * their hands. It also keeps the feed small and drives readers to the page.
   */
  import { markdownExcerpt } from "@thinkersjournal/markdown";
  import type { RecentPost } from "@thinkersjournal/shared";
  import type { APIRoute } from "astro";

  import { apiFetch } from "../lib/api";
  import { markFeedCacheable } from "../lib/cache";
  import { CANONICAL_ORIGIN, postUrl } from "../lib/canonical";
  import { escapeXml } from "../lib/xml";

  export const prerender = false;

  const FEED_ITEMS = 20;

  export const GET: APIRoute = async (context) => {
    markFeedCacheable(context);

    // ⚠️ ANONYMOUS — no `request`. See src/lib/cache.ts.
    const response = await apiFetch<{ posts: RecentPost[] }>(`/public/recent?limit=${FEED_ITEMS}`);
    const posts = response.status === 200 ? (response.data?.posts ?? []) : [];

    const items = posts
      .map((post) => {
        const url = postUrl(post.username, post.slug);
        return (
          `<item>` +
          `<title>${escapeXml(post.title)}</title>` +
          `<link>${escapeXml(url)}</link>` +
          // A permanent, stable identifier — the post's uuid, not its URL, which a
          // future slug policy could change under subscribers.
          `<guid isPermaLink="false">${escapeXml(post.id)}</guid>` +
          `<pubDate>${escapeXml(new Date(post.publishedAt).toUTCString())}</pubDate>` +
          `<description>${escapeXml(markdownExcerpt(post.excerptSource))}</description>` +
          `</item>`
        );
      })
      .join("");

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>` +
        `<title>Thinker's Journal</title>` +
        `<link>${escapeXml(CANONICAL_ORIGIN)}/</link>` +
        `<description>Posts from thinkers.</description>` +
        `<atom:link href="${escapeXml(CANONICAL_ORIGIN)}/rss.xml" rel="self" type="application/rss+xml" />` +
        items +
        `</channel></rss>`,
      { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } },
    );
  };
  ```

  Add `<link rel="alternate" type="application/rss+xml" title="Thinker's Journal" href="/rss.xml" />` to the `<head>` of `[handle]/index.astro` and `[handle]/[slug].astro`.

- [ ] **Step 6: Run → PASS + verify.** `pnpm --filter @thinkersjournal/web test` (xml + the cache inventory covering both new endpoints) and `typecheck` → exit 0. Then:

  ```bash
  curl -is http://127.0.0.1:8787/sitemap.xml | head -12
  #   EXPECT: content-type: application/xml; charset=utf-8
  #   EXPECT: cloudflare-cdn-cache-control: public, max-age=60, stale-while-revalidate=600
  #   ⚠️ NOT `cache-control` — the Astro Cloudflare provider writes the
  #   CDN-specific header name (verified against the installed adapter, Task 12).
  #   EXPECT: cache-tag: astro-path:/sitemap.xml  — and ONLY that. Astro CORE
  #   unconditionally stamps `astro-path:<path>` on every cacheable response, so
  #   the header is NOT absent. "Untagged" means our PURGE FLOW never targets this
  #   entry: apps/api/src/cache/purge.ts only ever purges `post:`/`author:`/
  #   `listing` — never `astro-path:` — which is the property the HYPERDRIVE_CACHED
  #   read depends on. So the load-bearing check is that NONE of post:/author:/
  #   listing appears, not that the header is empty.
  #   ⚠️ Only meaningful LOCALLY, where nothing strips headers — on a real deploy
  #   Cloudflare strips cache-tag from every response, tagged or not.
  curl -s http://127.0.0.1:8787/rss.xml | rg -c '<item>'          # EXPECT: your post count, <= 20
  ```

  Publish a post titled `</title><script>alert(1)</script>` and confirm `rg -c '<script>' <(curl -s .../rss.xml)` → **0**.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(m1): sitemap.xml + rss.xml (untagged, short-TTL, HYPERDRIVE_CACHED)"`

### Task 19: E2E — publish → render → edit → purge → reflected

> The Playwright suite is the only place the **whole** system runs at once: a real browser, both Workers, real Postgres, the real Service Bindings in **both** directions. It is what proves the purge hop and the poisoning guard actually work rather than merely type-check.
>
> **Topology is unchanged and DEV-ONLY**: web primary on `:8787`, api its **own** primary on `:8788` (an auxiliary Worker has no address, so `GET /__test/last-verify-token` — which stands in for the inbox — would be unreachable). The browser only ever touches `:8787`.

**Files:** Create `e2e/helpers.ts`, `e2e/publish.spec.ts`. Modify `e2e/signup.spec.ts`.

**Interfaces — Produces:** `signUpAndVerify(page, request): Promise<{ email: string; username: string }>`.

- [ ] **Step 1: Extract the signup helper.** Move `e2e/signup.spec.ts`'s signup → fetch-token → verify sequence into `e2e/helpers.ts` **verbatim**, exported as `signUpAndVerify(page, request)`, and have `signup.spec.ts` call it. ⚠️ **`signup.spec.ts`'s own assertions stay exactly where they are** — it exists to test that flow; this only stops `publish.spec.ts` from owning a second copy of it. Run `pnpm test:e2e` → **still 2 passed**, proving the extraction changed nothing.
- [ ] **Step 2: Write the failing E2E** (`e2e/publish.spec.ts`):

  ```ts
  import { expect, test } from "@playwright/test";

  import { signUpAndVerify } from "./helpers";

  /**
   * WHAT THIS PROVES THAT NO OTHER SUITE CAN: a real browser drives publish ->
   * public render -> edit -> purge -> reflected, through the `web` Worker, which
   * reaches `api` only over the Service Binding — and `api` reaches back over the
   * PURGE binding. Every unit suite stubs one side of that; this stubs none.
   */
  test("publish -> the public page renders -> edit -> the page reflects it", async ({ page }) => {
    const { username } = await signUpAndVerify(page, page.request);

    // ---- Publish -----------------------------------------------------------
    await page.goto("/new-post");
    await page.fill("#title", "My First Post");
    await page.fill("#markdownSource", "# Heading\n\nOriginal body.\n\n```typescript\nconst x = 1;\n```");
    await page.click("button[value='publish']");

    // The editor redirects to the public page.
    await expect(page).toHaveURL(new RegExp(`/@${username}/my-first-post$`));
    await expect(page.locator("#post-body h1")).toHaveText("Heading");
    await expect(page.locator("#post-body")).toContainText("Original body.");

    // Shiki ran, and it ran AFTER the sanitizer (defaultSchema strips `style`, so a
    // coloured token span existing at all proves the ordering).
    await expect(page.locator("#post-body pre span[style]").first()).toBeVisible();

    // OG + JSON-LD are present and correct.
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "My First Post");
    const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
    expect(JSON.parse(jsonLd ?? "{}")).toMatchObject({ "@type": "BlogPosting", headline: "My First Post" });

    // ---- Edit -> purge -> reflected ----------------------------------------
    const url = page.url();
    await page.goto(`/new-post?post=${await postIdFrom(page, url)}`);
    await page.fill("#markdownSource", "# Heading\n\nEdited body.");
    await page.click("button[value='publish']");

    await page.goto(url);
    // ⚠️ THE PURGE HOP, END TO END: api wrote the edit, then asked `web` (over the
    // WEB Service Binding, with the shared secret) to invalidate `post:<id>`. If
    // that hop is broken, this reads "Original body." — the exact symptom the hop
    // exists to prevent, and one that would otherwise last a full 25h window.
    await expect(page.locator("#post-body")).toContainText("Edited body.");
    await expect(page.locator("#post-body")).not.toContainText("Original body.");
  });

  test("the profile page lists the published post", async ({ page }) => {
    const { username } = await signUpAndVerify(page, page.request);
    await page.goto("/new-post");
    await page.fill("#title", "Listed Post");
    await page.fill("#markdownSource", "body");
    await page.click("button[value='publish']");

    await page.goto(`/@${username}`);
    await expect(page.locator("a", { hasText: "Listed Post" })).toBeVisible();
  });

  test("a DRAFT is not publicly reachable", async ({ page }) => {
    const { username } = await signUpAndVerify(page, page.request);
    await page.goto("/new-post");
    await page.fill("#title", "Secret Draft");
    await page.fill("#markdownSource", "unpublished text");
    await page.click("button[value='draft']");
    await expect(page.locator("#saved")).toBeVisible();

    const response = await page.request.get(`/@${username}/secret-draft`);
    expect(response.status()).toBe(404);
    await page.goto(`/@${username}`);
    await expect(page.locator("#no-posts")).toBeVisible();
  });

  test("⚠️ an AUTHED render of a public page is NEVER cacheable", async ({ page }) => {
    // ⚠️ THE HIGHEST-SEVERITY REGRESSION IN M1. Cookie is NOT in the Workers Cache
    // key and does NOT trigger bypass: if this ever fails, a logged-in render is
    // cached and served to every visitor — a mass session leak. This test is the
    // only place the real browser, the real cookie, and the real response headers
    // meet.
    const { username } = await signUpAndVerify(page, page.request);
    await page.goto("/new-post");
    await page.fill("#title", "Cache Probe");
    await page.fill("#markdownSource", "body");
    await page.click("button[value='publish']");
    const url = `/@${username}/cache-probe`;

    // Logged IN (the browser context still holds tj_session).
    const authed = await page.request.get(url);
    // ⚠️ `cache-control` here is CORRECT AS-IS: markPrivate sets this standard
    // header BY HAND (src/lib/cache.ts's `refuse()`), independent of the Astro
    // cache provider's own header. It is the one `cache-control` assertion in
    // this file that is not a naming bug.
    expect(authed.headers()["cache-control"]).toBe("private, no-store");
    expect(authed.headers()["cache-tag"]).toBeUndefined();

    // Logged OUT — a fresh context with no cookie jar.
    await page.context().clearCookies();
    const anon = await page.request.get(url);
    // ⚠️ `cloudflare-cdn-cache-control`, NOT `cache-control` — the Astro
    // Cloudflare provider writes the CDN-specific header (verified against the
    // installed adapter, Task 12); `cache-control` is always absent/undefined on
    // this path and would silently make a `.toBe(...)` assertion here a false
    // failure, not a vacuous pass.
    expect(anon.headers()["cloudflare-cdn-cache-control"]).toBe("public, max-age=3600, stale-while-revalidate=86400");
    // ⚠️ NEVER s-maxage / must-revalidate — either SILENTLY disables SWR.
    expect(anon.headers()["cloudflare-cdn-cache-control"]).not.toContain("s-maxage");
    // ⚠️ LOCAL-DEV-ONLY PROOF. This E2E runs both Workers under `wrangler dev`,
    // where there is no real Cloudflare edge to consume/strip `Cache-Tag` — so
    // this assertion legitimately observes what OUR code emits, but it does NOT
    // hold against a real deployed page (Cloudflare strips the header before any
    // client sees it there). The deploy-gate's client-visible proof that caching
    // is real is `Cf-Cache-Status` (`MISS` then `HIT`) — see Task 20.
    expect(anon.headers()["cache-tag"]).toContain("listing");
    expect(anon.headers()["content-security-policy"]).toContain("script-src 'self'");
    expect(anon.headers()["content-security-policy"]).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  test("sitemap.xml is untagged and short-TTL", async ({ page }) => {
    const response = await page.request.get("/sitemap.xml");
    // ⚠️ `cloudflare-cdn-cache-control`, not `cache-control` — see above.
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBe("public, max-age=60, stale-while-revalidate=600");
    // ⚠️ NOT `toBeUndefined()`. Astro CORE unconditionally appends
    // `astro-path:<path>` to every cacheable response, so the header is PRESENT.
    // "Untagged" means OUR PURGE FLOW never targets this entry — the header carries
    // ONLY that Astro-internal tag and NONE of the tags apps/api/src/cache/purge.ts
    // ever purges by. That is what licenses /public/recent's HYPERDRIVE_CACHED read.
    // (LOCAL-DEV-ONLY: a real deploy strips cache-tag from every response.)
    const cacheTag = response.headers()["cache-tag"];
    expect(cacheTag).toContain("astro-path:");
    expect(cacheTag).not.toContain("listing");
    expect(cacheTag).not.toContain("author:");
  });
  ```

  Add the small helper `postIdFrom` to `e2e/helpers.ts`: fetch `/@user` and read the edit id — or, simpler and with fewer moving parts, capture it from the editor's `input[name='postId']` **before** publishing. Use whichever the first run proves reliable; **prefer reading the hidden field**, since it needs no extra request.

- [ ] **Step 3: Run → FAIL, then GREEN.** `pnpm test:e2e`. ⚠️ **Build first, with no `wrangler dev` alive** (`pnpm --filter @thinkersjournal/web build`) — a build racing a dev server leaves the Service Binding reporting `[connected]` while every dispatch fails with `Network connection lost`, which looks like an app bug and is not.
  ⚠️ **Workers Cache is NOT simulated under `wrangler dev` — this is confirmed, not a "check whether."** Two GETs against local `wrangler dev` are two independent Worker invocations (no local `Cf-Cache-Status`), so the second `page.goto(url)` in the publish→edit→reflected test re-renders **unconditionally**, and its content assertion (`toContainText("Edited body.")`) would pass **vacuously** even if the purge hop were entirely broken — it never observed a cache at all. The **header** assertions above (`cloudflare-cdn-cache-control`, `cache-tag`) are the real local contract: they pin what OUR code emits regardless of whether a cache sits in front. **A real cache HIT-then-purge is unobservable locally by construction**, full stop — it is a **deploy-gate-only** proof (`Cf-Cache-Status`: `MISS` → `HIT` → edit → `MISS`/`UPDATING`, added to Task 20). Record this in `playwright.config.ts`'s header so the next reader does not re-derive it.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "test(m1): E2E publish -> render -> edit -> purge, and the authed-render cache guard"`

### Task 20: Deploy gate + docs

**Files:** Modify `README.md`, `HANDOFF.md`.

**Interfaces — Produces:** a deploy gate that carries every M1 provisioning step and every hazard the tests cannot reach.

- [ ] **Step 1: Update the README's local-dev section.** Postgres **18** (Task 1 did the one-liner; confirm it landed). Add `PURGE_SECRET=dev-purge-secret-not-for-production` to the documented `apps/api/.dev.vars`, and document the **new** `apps/web/.dev.vars` with the **same value** — noting that both are supplied independently by `vitest.config.ts` and `playwright.config.ts`, so a fresh clone still passes CI. Add the new test counts to the `### Tests` block.
- [ ] **Step 2: Add the M1 provisioning runbook** to `## Deploying (Workers Builds)`:

  ```md
  ### M1 provisioning (do these before the first M1 deploy)

  ```bash
  wrangler r2 bucket create tj-media
  # PURGE_SECRET: ONE high-entropy value, set on BOTH Workers. They must match, or
  # every purge 403s silently and content is stale for up to 25 hours.
  openssl rand -base64 32                        # generate once
  cd apps/api && wrangler secret put PURGE_SECRET
  cd ../web  && wrangler secret put PURGE_SECRET
  ```

  | Setting | Value |
  | --- | --- |
  | Neon Postgres major | **18** — Neon's default for new projects since 2026-06-05 |
  | R2 bucket | `tj-media`, bound as `MEDIA` on `api` |
  | R2 custom domain | `cdn.thinkersjournal.com` (requires a zone) |
  | Images binding | `IMAGES` on `api` — **no subscription, no zone, no base fee** |
  | Secrets (both Workers) | `PURGE_SECRET` — identical value |

  ⚠️ **First-deploy order, because the Service Bindings are now CIRCULAR**
  (`web → api` for everything, `api → web` for purge). `wrangler deploy` resolves
  the target service **by name**, and on a first deploy neither exists:

  1. Comment out `"services"` in `apps/api/wrangler.jsonc` → deploy `api`.
  2. Deploy `web` (its `API` binding now resolves).
  3. Restore `"services"` in `apps/api/wrangler.jsonc` → redeploy `api`.

  Every later deploy is order-independent.
  ```

- [ ] **Step 3: Add the M1 deploy gate.** Append to `### Deploy gate`, under a `**Learned during M1 — each of these is a hazard no test can reach:**` heading:

  ```md
  - [ ] **Neon is on Postgres 18.** `SELECT version();` on the deployed api's database.
        ⚠️ **Neon has NO in-place major upgrade** — a wrong major here means creating a
        NEW project and migrating data, forever after. PG18 is Neon's default for new
        projects; take the default. `migrations/0002` uses the **native** `uuidv7()`,
        which does not exist before 18, so a PG16 project fails at migrate time (loud) —
        but a PG17 project would fail the same way after data existed (expensive).
  - [ ] **The Cache Rule on `cdn.thinkersjournal.com` is NOT optional and is NOT
        performance.** Cache Everything + a long Edge TTL. ⚠️ **"Cached" is EXACTLY the
        set the CSAM Scanning Tool covers — media that bypasses cache is media that
        ISN'T SCANNED.** Verify with `curl -I https://cdn.thinkersjournal.com/media/post/<hash>.webp`
        → `cf-cache-status: HIT` on the second request. A MISS here is a legal exposure,
        not a slow image.
  - [ ] **A Transform Rule adds `X-Content-Type-Options: nosniff` on the
        `cdn.thinkersjournal.com` R2 custom domain itself.** Media is served
        DIRECTLY from R2 through that custom domain, deliberately NOT through a
        Worker (Task 8) — so neither `setPublicPageCsp`'s `nosniff` (which only
        runs on `web`'s own SSR page responses) nor anything set on `api`'s `POST
        /media` 201 JSON response ever touches these bytes. Without a Transform
        Rule on the zone, a served image has no nosniff protection at all. Verify:
        `curl -I https://cdn.thinkersjournal.com/media/post/<hash>.webp | rg -i
        'x-content-type-options'` → `nosniff`.
  - [ ] **CSAM Scanning Tool activated** on the CDN zone (Caching → Configuration → CSAM
        Scanning Tool). **Free, all plans. NCMEC credentials are NO LONGER REQUIRED** —
        activate, verify the notification email, accept the Service-Specific Terms. ⚠️ The
        tool **detects; it does not report** — we still file our own reports. The zone
        already exists because the R2 custom domain requires one, so this adds no burden.
  - [ ] **`workers_dev = false` on BOTH Workers** + custom `routes`. ⚠️ `*.workers.dev`
        **SHARES CACHE ENTRIES** with the custom domain at the same Worker version, so
        leaving it on means a `workers.dev` request can fill an entry served under the
        real domain. This also closes M0's "the api has a public workers.dev URL" finding
        — the api's only entry becomes the Service Binding from `web`.
        ⚠️ **It also removes `pnpm smoke:deploy`'s access.** Run every real-infra
        validation BEFORE closing the public URL, or against a staging Worker that keeps one.
  - [ ] **www → apex redirect is live.** ⚠️ **HOST IS NOT IN THE CACHE KEY** — apex and
        `www` share entries, so without the redirect a `www` render is served at the apex
        and vice versa. (Canonical/OG URLs are already built from a constant origin for
        this exact reason — see `apps/web/src/lib/canonical.ts`.)
  - [ ] **`PURGE_SECRET` is set on BOTH Workers and the values MATCH.** A mismatch fails
        **silently**: `purgeTags` never throws (it must not — the post is already saved),
        so the only symptom is content stale for a full `maxAge+swr` window (**25 hours**).
        Verify by publishing, editing, and confirming the public page changes.
  - [ ] **Alert on the purge log lines** — `cache purge rejected` / `cache purge threw`
        (`apps/api/src/cache/purge.ts`). Same class of hazard as M0's Postmark alerting:
        a failure mode that is invisible by design, whose first symptom is a user
        complaint. ⚠️ Purge is **rate-limited to 5 requests/MINUTE on a Free zone** (burst
        25, 100 ops/request). We batch every tag into one call per edit; a burst of edits
        can still exhaust it. Pro raises it to 5/sec.
  - [ ] **`api`'s `WEB` Service Binding resolves** — see the first-deploy order above. A
        missing binding is another silent-purge-failure path.
  - [ ] **Assert a real cache `MISS` then `HIT` via `Cf-Cache-Status`, on a public
        page, BEFORE trusting anything else about caching.** This is the ONLY
        client-visible proof Workers Cache is active at all — the header the Astro
        provider actually writes (`Cloudflare-CDN-Cache-Control`) and the
        `Cache-Tag` purge handle are both invisible client-side on a real deploy
        (Cloudflare strips `Cache-Tag` before the client ever sees it, and plain
        `Cache-Control` — the name every local/unit check in this plan used to
        read — is never set at all). `curl -is
        https://thinkersjournal.com/@<user>/<slug>` twice in a row → first request
        `cf-cache-status: MISS`, second `cf-cache-status: HIT`. If this never flips
        to `HIT`, nothing downstream (purge, TTLs, tags) can be trusted either, no
        matter how green the local suites are.
  - [ ] **Verify a REAL purge on the deployed Workers.** Local `wrangler dev` does
        NOT simulate Workers Cache at all — confirmed, not a maybe: two local GETs
        are two independent Worker invocations, so the E2E's purge assertion
        passes on content alone, without ever having observed a cache (see
        `playwright.config.ts`). Publish → confirm `cf-cache-status: HIT` (the item
        above) → edit → confirm the next request is a `MISS`/`UPDATING` carrying
        the new content.
  - [ ] **A gradual deployment leaves the OLD Worker version serving ITS OWN
        cached HTML to its traffic share until rollout completes.** The Worker
        version is part of the Workers Cache key (Task 12) by design, so during a
        gradual rollout the previous version's cache entries are not invalidated
        by the new version's deploy — each version's traffic share sees only that
        version's cache, and a purge issued against the new version does not reach
        the old version's entries. Expect a window where some readers still see
        pre-edit content even after a successful purge, until the old version's
        traffic share reaches zero. This is expected, not a purge-hop failure —
        do not "fix" it mid-rollout.
  - [ ] **Workers Cache + the Astro cache provider still have the shape M1 verified.**
        Workers Cache shipped **2026-07-06** and Astro's CDN cache-provider API is flagged
        **experimental**. Re-run Task 12 Step 1's four checks on any bump of astro,
        `@astrojs/cloudflare`, or wrangler. The verified shape is recorded in
        `apps/web/astro.config.mjs`'s notes block.
  - [ ] **`HYPERDRIVE_CACHED` is used ONLY by `GET /public/recent`.** `rg -n
        'HYPERDRIVE_CACHED' apps/api/src` → exactly one hit, in
        `src/routes/public.ts`. ⚠️ Every other public read uses **FRESH**, because their
        edge entries are purge-invalidated: the first render after a purge is a
        read-after-write, and Hyperdrive **never invalidates on write**, so a CACHED read
        there could serve a pre-edit row that the edge then re-caches for **25 hours**.
        Behind a 3600s edge TTL a 60s query cache hits ~never anyway. See the amended
        Global Constraint in the M1 plan.
  - [ ] **Upload a REAL SVG against the REAL Images binding on a deployed
        Worker.** Miniflare backs the `IMAGES` binding with `sharp`, which
        RASTERIZES SVG input — so a local `IMAGES` call against an SVG either
        fails cleanly or comes back as a raster format, either of which can read
        as "the binding neutralizes SVG safely." Production Cloudflare Images does
        the opposite: it PASSES SVG THROUGH (sanitized via svg-hush), still shaped
        as SVG, not rasterized. Local green here proves nothing about production
        behaviour. Task 7's magic-byte sniff is the ACTUAL SVG defense (it rejects
        SVG with a 415 before the Images binding ever sees it) — this check exists
        to catch a regression in that sniff, which local tests alone cannot.
  - [ ] **"What local green does NOT prove" — a standing warning, not a one-time
        check.** ⚠️ **LOCAL HYPERDRIVE IS NOT A POOLER**: local dev connects
        STRAIGHT to Postgres, with none of a real pooler's connection reuse or
        transaction-mode semantics in front of it. Anything whose correctness
        depends on real pooling behaviour is UNPROVEN by a local green run — this
        nearly shipped a no-op safety setting in Task 11, where the
        transaction-mode-pooler reasoning behind the atomic guarded upsert had
        nothing real to run against locally. Pair this with the `sharp`/SVG item
        above: local infra simulation (miniflare's Images/R2/Hyperdrive) is close
        enough for LOGIC, never close enough for a SECURITY or POOLING guarantee.
        Anything in that category earns its own real-infra deploy-gate line, not a
        "tests are green" sign-off.
  - [ ] **The Images bill is a TRANSFORM bill, not a traffic bill.** 5,000 free unique
        transforms/month, then $0.50/1k, billed once per unique (source+params) per
        calendar month. We transform on **write** and serve from R2 (egress $0), so this
        scales with uploads, not views. Check it after the first month of real uploads.
  - [ ] **The R2 dedupe/deletion hazard is understood before ANY delete ships.** Two users
        uploading the same image share **ONE R2 object with TWO `media` rows** — the key is
        the content hash. Deleting one row must **NOT** delete the object. M1 never deletes
        an object inline; reclamation is an offline GC (M4, with moderation deletion). Do
        not add an inline delete without refcounting first.
  ```

- [ ] **Step 4: Update `HANDOFF.md`.** Set the status to *"M1 built"*, add
      `docs/superpowers/plans/2026-07-15-m1-publishing-and-public-web.md` to the
      documentation map, and update the **green baseline** table with the real
      post-M1 counts from a full run (`api`, `web`, `shared`, **`markdown`** — a new
      row — and `e2e`). ⚠️ **Run the suites and copy the real numbers.** A baseline
      table nobody can reproduce is worse than none: it trains the next session to
      ignore a mismatch.
- [ ] **Step 5: Full verification sweep.** Every command, all green:

  ```bash
  docker compose up -d
  pnpm install
  pnpm --filter @thinkersjournal/shared test
  pnpm --filter @thinkersjournal/markdown test
  pnpm --filter @thinkersjournal/markdown run check:workerd     # exit 0
  pnpm --filter @thinkersjournal/api test
  pnpm --filter @thinkersjournal/web test
  pnpm typecheck                                                 # exit 0
  pnpm --filter @thinkersjournal/web build
  pnpm test:e2e
  ```

- [ ] **Step 6: Commit.** `git add -A && git commit -m "docs(m1): deploy gate + runbook for R2/CDN/CSAM/purge/PG18"`

---

## Deploy-gate checklist

**The live, maintained gate is `README.md`'s** — it carries M0's list plus every M1 item Task 20 adds. This is the index:

**Inherited from M0 (all still binding):** `HYPERDRIVE_FRESH` is cache-disabled and every auth/dup/verify/epoch read uses it · Neon's string is the **direct** (non-pooled) host with `sslmode=require` · Postmark `From` is a **confirmed** sender · real Turnstile keys, dummy keys never deployed · **`TEST_ROUTES` unset in prod** (gates **two** things: the `__test` token route *and* the session cookie's `Domain`/`Secure`) — asserted by `pnpm smoke:deploy` steps 1 + 4 · wrangler + `@cloudflare/vitest-pool-workers` pinned, config shapes re-verified · one real-infra pass (`pnpm smoke:deploy` step 3) · Postmark alerting · argon2id `.wasm` bundles on a real deploy · the Astro-403→503 dev quirk does not reproduce deployed · the api's public workers.dev URL — **now closed by M1's `workers_dev = false`**.

**New in M1:** Neon on **PG18** · R2 `tj-media` + `cdn.thinkersjournal.com` · **the CDN Cache Rule (cached == the set CSAM scanning covers — NOT optional)** · **a Transform Rule adds `nosniff` on the CDN custom domain itself** (the media route's own `nosniff` never reaches R2-served bytes) · **CSAM tool activated** (free; no NCMEC creds) · **`workers_dev = false` on both** (workers.dev shares cache entries) · **www → apex** (host is not in the cache key) · **`PURGE_SECRET` matches on both Workers** · purge alerting + the 5/min Free-zone limit · the circular Service Binding's first-deploy order · **a real cache `MISS`→`HIT` via `Cf-Cache-Status` on a public page** (the only client-visible proof caching works at all) · a **real** purge verified on deployed Workers · a gradual deployment's old Worker version keeps serving its own cached HTML until rollout completes · Workers Cache/Astro-provider shapes re-verified on any bump · **`HYPERDRIVE_CACHED` used by exactly one route** · **a real SVG uploaded against the real Images binding** (miniflare's `sharp` rasterizes SVG; production passes it through via svg-hush) · **local Hyperdrive is not a pooler** — anything pooling-dependent is unproven locally · the R2 dedupe/deletion hazard understood before any delete ships.

## Deferred / out-of-scope

**Explicitly NOT M1 — do not plan tasks for these:**

| Deferred to | Scope |
|---|---|
| **M2** | Follows · pull-on-read feed · comments (materialized-path) · reactions · notifications (DO Hibernation WS + email + batching) · Postgres FTS search · explore/trending · **user-chosen usernames** (the profile-editing rename that must purge `author:<id>` + every `post:<id>` — *first thing in M2*, see below). **Also M2:** `HYPERDRIVE_CACHED`'s *proper* payoff (the feed is viewer-specific ⇒ never edge-cached ⇒ genuinely high origin read rate); a cacheable logged-out home; sitemap **index** + real pagination on `/public/recent` (M1 caps it at 1000; the protocol's limit is 50,000); **app-level rate limiting on `/public/*` + `/@*`** (M1 has none — the deploy gate mitigates it with a Cloudflare WAF rate-limit rule; the durable fix is app-level, keyed so `?cursor=` cannot mint unbounded cacheable edge entries). |
| **M3** | References + connectors · GitHub App/GitLab OAuth · snapshot capture · paste-to-enrich + @/slash picker · Cron+Queue refresh sweep · per-author rate-budget DO · envelope-encrypted `source_connections`. `{{ref:TOKEN}}` placeholders already have their home in `posts.markdown_source`, and the render pipeline already has its insertion point (**after** sanitize, as trusted hast). |
| **M4** | Moderation queue · report → auto-hide → action + audit log behind Access · DMCA registration + takedown/counter-notice · CSAM/NCMEC playbook · attorney review. **Also M4:** the **offline R2 GC** that makes media deletion safe (see the dedupe hazard). |

**Deferred with reasoning — revisit when named:**

- **Move `email_verified_at` into `UserSecurityDO` to make the soft gate free.** A real optimization, and M0's final review recommended it: `requireVerifiedEmail` currently costs a **Postgres round-trip on every content mutation**, and the DO is already read on that same path for the epoch check — so the gate could be free. **Deferred because it creates TWO SOURCES OF TRUTH FOR A SECURITY GATE.** `users.email_verified_at` would remain the durable record while the DO became the enforcement point, and the two can diverge: a `GET /verify-email` that commits the UPDATE and then fails to reach the DO leaves a verified user permanently gated, and the inverse (DO says verified, Postgres does not) is worse. Making that safe needs a designed reconciliation — which is the write's source of record, how a divergence is detected, how it heals — and that is its own design, not a line in a task. ⚠️ **Do not fold it into an M1 task as a "quick win."** **Revisit in M2**, where `UserSecurityDO`'s role is already being extended.
- **Eliminate `style-src 'unsafe-inline'`** via `@shikijs/transformers`' `transformerStyleToClass` + a static stylesheet. Today Shiki emits an inline `style` per token span and CSP has no hash/nonce mechanism for style *attributes*. It is safe **only** because `defaultSchema` has no `style` in `attributes`, so user content can never carry one — every inline style is app-generated, post-sanitize. Worth closing, but it needs dynamic CSS emitted per render (which lands back at an inline `<style>` needing a hash) and buys a directive that is not the one XSS travels through. `script-src 'self'` — the one that matters — already has **no** `unsafe-inline`.
- **Avatar variants + a per-variant media pipeline.** M1 stores one variant (`media/post/<hash>.webp`, 2048px). The spec's ~5MB avatar cap and `anim: false` for avatars need a `variant` parameter on `POST /media`; the key scheme (`media/<variant>/<hash>.webp`) already has the slot. Nothing in M1 renders an avatar.
- **The atomic guarded upsert's residual concurrency window (Task 11).** Task 11 closed the M0 dup-check→INSERT race — signup is now one `withClient` / one `INSERT … ON CONFLICT`, and concurrent same-email signups can no longer 500. Two residuals remain, both bounded and documented in `apps/api/src/routes/signup.ts`: (1) two concurrent signups over the SAME unverified address may **both** legitimately 201 (each a re-signup over the unverified row — this is deviation E's anti-enumeration behaviour, not a bug); (2) the epoch bump now runs AFTER commit, so if that call throws, a displaced unverified session survives against the new password — harmless because an unverified session cannot mutate content (soft gate) and `GET /verify-email` re-checks the epoch. Neither is worth closing in M1; revisit only if the verify-email/epoch model changes.
- **User-chosen usernames.** M0's signup *generates* one (deviation E) and explicitly defers chosen usernames to "M1 profile editing". **M1 does not ship profile editing** — the profile page is read-only. ⚠️ This is a real gap between M0's note and M1's scope: a user cannot change the auto-generated username their public URL is built from. **The URL shape (`/@username`) is designed for it** (`profiles.username` is already `citext UNIQUE`), but a rename must purge `author:<id>` and every `post:<id>` — which is exactly why it waits for the purge hop to have shipped and been verified. **First thing in M2.**

## Self-Review

**Spec coverage.** Every M1 deliverable in the design spec (line 99) maps to tasks: `posts` (T4, T9) · Markdown editor island (T17) · media pipeline (T7, T8) · SSR public post/profile pages (T15, T16) · OG/JSON-LD (T15) · edge cache + `Cache-Tag` purge (T12, T13, T14) · sitemap/RSS (T18). The cross-cutting decisions land too: rendering per-route (T13's helpers make cacheability a declared property of every page) · data access via the two Hyperdrive bindings (the amended Global Constraint + T9) · UUIDv7 PKs (T4) · no SVG, WebP output, per-user quota, discard originals, CSAM tool (T7, T8, T20) · public-page cache `max-age` + SWR (T12, T13) · Postgres cost control — "hard edge-cache public reads" is the #1 ranked lever and T12–T15 are it. ✅

**Gaps I could not close (flagged, not hidden):**
1. **Profile editing / user-chosen usernames.** M0's deviation E defers them to "M1 profile editing"; the spec's line 99 does not name them, and the brief's task list does not include them. Recorded in *Deferred* with the purge-on-rename reasoning and named as M2's first item — **not silently dropped**.
2. **`HYPERDRIVE_CACHED`'s scope.** The brief says M1 is its first *real* use for "public reads"; the plan restricts it to `sitemap.xml`/`rss.xml` and uses **FRESH** for the purge-tagged pages. The reasoning is in the amended Global Constraint and is a correctness argument, not a preference — it is the most significant deviation in the plan and is called out again in the report.

**Placeholder scan.** No TBD/TODO. Genuinely provisioning-time values are flagged as such and given owners: R2/Hyperdrive/KV ids, the real `PURGE_SECRET`, Turnstile/Postmark secrets (Prerequisites + T20). **Three explicit VERIFY steps** exist where the toolchain is younger than the plan — T8 Step 1 (Images/R2 under miniflare), T12 Step 1 (Workers Cache + the Astro provider), T14 Step 6 (`cache.invalidate`'s shape). Each names a **concrete command, an expected output, and a documented fallback with real code** — they are contingencies, not gaps, and each records its finding in a source file rather than in this plan.

**Type/interface consistency.** `ApiErrorCode`/`ApiErrorBody` (T2) are produced by `errorResponse` (T2) and consumed by `apiErrorCode` (T2) in `new-post.astro` (T17) · `RouteDef`/`ROUTES` (T3) are consumed by `index.ts` and by `route-protection.test.ts`, and every later route registers there (T8, T9, T10) · `withClient(hd, ctx, fn)`'s **3-arg** M0 shape is honoured at every new call site · `runMutatingPipeline` (M0) is called by T8/T9/T10's handlers, and `readCurrentSession` (T9) by `handleCsrf` + `handleGetPost` · `PIPELINE_VERSION` (T5) is consumed by `markPublicCacheable` (T13) · `CacheContext` (T13) is satisfied by `Astro`/`APIContext` at every page · `PublicPost`/`PublicProfile`/`RecentPost` (T9) are produced by `routes/public.ts` (T9) and consumed by T15/T16/T18 · `purgeTags` (T14) is both **created and wired into T9's handlers by T14**, so it is never referenced before it exists · `timingSafeEqual` (T14) has exactly one definition, used by both Workers · `sniffImageFormat` (T7) is consumed by T8. ✅

**Ordering — every task is independently testable in task order, with no forward references.** Infrastructure and M0 carry-overs come first (T1–T3), so no M1 code is written against a shape that is about to change. **T3 (the route table) precedes every new route**, because `PATCH /posts/:id` is invisible to M0's regex-based inventory and would otherwise ship un-inventoried — through the exact blind spot of the file written to prevent that.

**Purge-on-edit lives in T14, not T9, and that is a dependency fact rather than a sequencing preference:** *there is no cache to purge until T12 creates one.* A `purgeTags` call in T9 would be dead code invalidating a cache that does not exist, and the tags it names (`post:`, `author:`, `listing`) are not set by anything until T13. So T9's handlers are complete and green standalone with no reference to `purgeTags`, and T14 — which creates the hop, and sits after the cache and the tags both exist — adds the two call sites plus `test/purge-wiring.test.ts` to pin them (one batched call per edit; a draft purges nothing; a 404 edit purges nothing; a purge failure never fails the write).

Every other cross-task symbol flows strictly forward: `errorResponse`/`ApiErrorCode` (T2) → every later handler · `ROUTES` (T3) → T8/T9/T10's registrations and `route-protection.test.ts` · the `posts`/`media` schema (T4) → T8/T9 · `PIPELINE_VERSION`/`renderMarkdown`/`markdownExcerpt` (T5) → T13/T15/T16/T17/T18 · `sniffImageFormat` (T7) → T8 · `test/actor.ts` (T9) → T14's wiring tests · the public DTOs (T9) → T15/T16/T18 · the Workers Cache (T12) → T13's helpers → T15/T16/T17/T18's pages · `canonical.ts`/`csp.ts` (T15) → T16/T18. **The one backward edit is deliberate and its Files entry says so:** T17 adds `username` to T9's create/edit responses, because the editor's publish redirect is the first thing that needs it. ✅

## Next: Execution

Plan complete. Execution options: **subagent-driven** (recommended — a fresh subagent per task plus review gates) or **inline**. Provisioning surfaces just-in-time per the Prerequisites table; the three VERIFY steps (T8, T12, T14) are the ones most likely to change what gets built, so they are early inside their tasks by design.
</content>
</invoke>

# Web theming — parent design-system adoption (design)

**Date:** 2026-07-21
**Status:** approved design; feeds into an implementation plan (`docs/superpowers/plans/`).
**Milestone context:** a standalone, cross-cutting **theming milestone** (not part of the M0–M4 feature sequence), triggered by the design-system handoff from the ThinkersJournal.com marketing site (project ①). It adopts that site's design system into the Community `web` app so the two feel like one product. Runs after M2.1 (merged) + the `community.thinkersjournal.com` host correction (merged); M2.2 (engagement) follows.

---

## 1. Goal

Make the Community app (`apps/web`, on `community.thinkersjournal.com`) visually part of **thinkersjournal.com**: adopt the parent site's design tokens, self-hosted fonts, global CSS, and chrome (a shared layout, sticky nav, footer, and small components), across **every** HTML page — while preserving the M1 edge-cache discipline (no per-viewer state in cached HTML) and the app's CSP.

The parent's design system is prescriptive and already handed off (source: `C:\Projects\ThinkersJournal.com\src\styles\*` + `src\components\*` + `src\layouts\*`, plus `docs\community-design-handoff.md`). The real work is **integration under the Community app's constraints** (cache, CSP, auth-aware nav) — constraints the parent (a static, authless, CSP-less site) never faced.

## 2. Scope (what ships)

1. **Design-system foundation** — `tokens.css` (all tokens) + `global.css` (verbatim) + the two self-hosted Fontsource variable fonts, loaded once via a head component.
2. **Shared chrome** — `BaseLayout` (with a named `head` slot), `BaseHead`, `Nav` (app link set + client-hydrated auth slot), `Footer` (app content), `PageLayout` (band hero), and the small components `Wordmark` (CSP-clean), `Button`, `SectionLabel`.
3. **Client-hydrated nav auth** — a bundled `nav-auth.ts` island + `/api/me` and `/api/logout` web proxies, so the nav's Sign in/up ↔ @handle+Sign out never enters cached SSR.
4. **Extended CSP** — one shared policy (adds `font-src`/`style-src`; now applied to authed pages too).
5. **Retrofit of all HTML pages** — home, login, signup, verify-email, new-post, choose-username, feed, authors, `[handle]/index` (profile), `[handle]/[slug]` (post) — each wrapped in the shared layout, keeping its own cache-helper + CSP call.

**Out of scope** (see §10): a full marketing-style home landing, per-page OG images, About/Guidelines pages, deeper per-page visual polish.

## 3. Locked decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| 1 | **Full adoption, all pages** this milestone | A half-themed app reads as broken; the retrofit is mechanical once the foundation + nav island exist. |
| 2 | Nav auth = **uniform client-hydrated slot** | Public pages are edge-cached + anonymous; the only per-viewer nav bit (Sign in/up ↔ @handle+Sign out) hydrates client-side (same pattern as the M2.1 follow island), keeping every page cache-safe with one code path. |
| 3 | **Port the parent CSS verbatim** (tokens + global) + **self-host the same two fonts** | Identical brand; the parent is plain CSS custom-properties + Fontsource (no Tailwind/framework), and `apps/web` is also Astro — copy wholesale. Dark-only, no `prefers-color-scheme`. |
| 4 | **Extend the CSP** with `font-src 'self'` + `style-src 'self'`, and apply a CSP to authed pages too | Fonts + Astro scoped styles are same-origin; authed pages now carry the nav island + fonts, so they get the same defense-in-depth policy. |
| 5 | `Wordmark` **refactored off its inline `style=`** | The parent's `style={\`font-size:${size}\`}` is blocked under `style-src 'self'`; size becomes a discrete prop → class. |
| 6 | Wordmark **links to the apex** `https://thinkersjournal.com/` | Per the handoff — the shared brand points back to the flagship marketing site. |
| 7 | Home page **markPrivate → markPublicCacheable** | With auth client-hydrated, the home SSR is anonymous → it can finally be edge-cached. |

## 4. Foundation — CSS + fonts

**Files (new, in `apps/web`):**
- `src/styles/tokens.css` — the parent's full `:root` (all 15 tokens, **not** just the handoff subset): `--ink:#060608 --ink2:#0a0a0d --green:#3dff95 --green-bright:#7dffbc --green-glow:rgba(61,255,149,.5) --text:#f3f3f5 --muted:#a8a8b3 --dim:#7a7a85 --head:#fafafc --emph:#e9e9ee --on-green:#03130a --line:rgba(255,255,255,.08) --serif:'Fraunces Variable',… --sans:'Inter Variable',… --wrap:1120px`. (The chrome depends on `--line/--muted/--text/--head/--green/--green-glow/--on-green`, so all must be ported.)
- `src/styles/global.css` — verbatim: `@import './tokens.css'` + the reset, `body`, `.wrap/.serif/.label/.btn/.btn-primary/.btn-ghost/.link`, `h1,h2,h3` serif, `:focus-visible` green ring, the `prefers-reduced-motion` block, and `em` → green-serif.

**Fonts:** add `@fontsource-variable/fraunces` + `@fontsource-variable/inter` to `apps/web/package.json`, imported (bare specifiers) once in `BaseHead`. Vite bundles the woff2 as **same-origin assets** served via the existing `ASSETS` binding — self-hosted, `font-display:swap`, `unicode-range`-subsetted, no CDN (exactly like the parent). Family names `'Fraunces Variable'` / `'Inter Variable'` match the tokens.

**Load path (matches parent):** `BaseHead` does `import '@fontsource-variable/fraunces'; import '@fontsource-variable/inter'; import '../styles/global.css'` → `global.css` `@import`s `tokens.css`. No separate CSS entry, no `@layer`, no preload links (deferred polish).

## 5. Chrome — layout & components

New `apps/web/src/components/` (the app's first components dir). **Every chrome component is pure presentation — none calls a cache helper** (the `page-cache-inventory` SWEEP B forbids `cache.set`/cache-control in anything but `lib/cache.ts`; the cache-helper call stays in each page's frontmatter).

- **`BaseLayout.astro`** — `<html><head><BaseHead {title,description,canonical,ogImage}/><slot name="head"/></head><body><Nav/><main><slot/></main><Footer/></body></html>`. The **named `head` slot** is load-bearing: the profile/post pages inject their existing OG tags, JSON-LD, and RSS `<link>` there (nothing lost). Props: `title?`, `description?`, `canonical?`, `ogImage?`.
- **`BaseHead.astro`** — the two font imports + `global.css` import + base meta: `<title>`, description, `theme-color:#060608`, `<link rel="icon" href="/favicon.svg">` (copy the parent favicon into `public/`), canonical (defaults to the current path on `CANONICAL_ORIGIN` = `https://community.thinkersjournal.com`, overridable), OG + Twitter. Does **not** clobber page-specific OG (pages add richer OG via the head slot when needed).
- **`Nav.astro`** — the parent's chrome **CSS verbatim** (sticky `top:0 z-index:40`, `rgba(6,6,8,.72)` + `backdrop-filter:blur(12px)`, `--line` border, 66px bar, `.wrap.bar` flex, the zero-JS checkbox+label mobile disclosure at `max-width:840px`, the green pill). Our link set: wordmark (→ `https://thinkersjournal.com/`) · static browse links **Feed** · **Authors** · and a `[data-auth-slot]` container (neutral placeholder in SSR) that the island fills with the **auth-dependent** items — including the primary pill CTA, whose label/target depends on auth state (Sign up when logged out, New post when logged in). Because the pill is auth-dependent it lives in the slot, not as static SSR. Requires the `<input>`/`<label>`/`<nav class="links">` sibling order for the disclosure.
- **`Footer.astro`** — the parent's footer *treatment* (`#040405`, `--line` borders, the flex `.note` bar) with app content: `Wordmark size="sm"` + tagline · a short links column (Feed, Authors) · a "← thinkersjournal.com" back-link · the non-profit note + Privacy/GitHub. Simpler than the marketing 4-col.
- **`PageLayout.astro`** — the band-header hero (verbatim: `.band` gradient `#111114→#060608` + blurred green `::after` glow, `SectionLabel` eyebrow + `h1` + optional `.intro`, then a `.wrap.body` slot). Props: `title`, `eyebrow`, `heading`, `intro?`. Wraps `BaseLayout`.
- **`Wordmark.astro`** — **CSP-clean**: no inline `style=`. `size: 'lg' | 'sm'` (default `lg`) maps to a class in the scoped `<style>`; `.wm` serif `--head`, `.dot` green `--green-glow`. App wordmark text "Thinker's Journal".
- **`Button.astro` / `SectionLabel.astro`** — verbatim; style-less shells over the global `.btn*` / `.label` classes. No inline styles.

## 6. Client-hydrated nav auth

**`src/scripts/nav-auth.ts`** (bundled island, same-origin only): on load, `fetch('/api/me')`; fill `[data-auth-slot]` — logged-in → **New post** (→ `/new-post`) · **@username** (→ `/@username`) · **Sign out** (button → `POST /api/logout` then reload/redirect `/`); logged-out → **Sign in** (→ `/login`) · **Sign up** (→ `/signup`). Uniform on every page; **no viewer state in SSR** (the slot ships as a neutral placeholder). Talks only to same-origin `/api/*` (the api Worker has no public origin).

**Proxies (new web APIRoutes, each `markPrivate` with the wrapped context):**
- `src/pages/api/me.ts` (GET) → proxies `GET /profile/me` (forwards cookie) and, when logged in, `GET /auth/csrf`; returns `{ loggedIn, username, usernameChosen, csrfToken }` (loggedIn:false + nulls on 401).
- `src/pages/api/logout.ts` (POST) → proxies `POST /auth/logout` (forwards cookie + Origin + `X-CSRF-Token`), `applyCookies` (propagates the cleared session cookie), returns the api status.

## 7. CSP

One shared policy on every themed page (public **and** authed), **extending the current `setPublicPageCsp` directives** (read `apps/web/src/lib/csp.ts` first and preserve its existing base — `script-src 'self'`, `img-src 'self' https://cdn.thinkersjournal.com`, `connect-src 'self'`, plus whatever `base-uri`/`form-action`/etc. it already sets). The additions: **`style-src 'self'`** (Astro scoped `<style>` compiles to external hashed stylesheets) and **`font-src 'self'`** (bundled woff2). Public pages: extend `setPublicPageCsp`. Authed pages (login/signup/verify-email/new-post/choose-username/feed): gain a CSP via **one shared helper** (either the generalized `setPublicPageCsp` or a sibling — the plan picks; today they are CSP-free, and now they carry the nav island + fonts). The `/api/*` proxies stay JSON + `markPrivate`, no CSP. **No inline `<script>`/`<style>`/`style=` anywhere** — the Wordmark refactor (§5) and bundled island (§6) keep `'self'` sufficient (no `unsafe-inline`).

## 8. Page retrofit

Each HTML page: wrap body in `<BaseLayout>`/`<PageLayout>`, move page-specific head into `<Fragment slot="head">`, **keep its own cache-helper + CSP call in frontmatter**, restyle markup with the global classes. Non-HTML routes (`sitemap.xml`/`rss.xml`, `/api/*`, `/internal/purge`, `/media-upload`) are untouched.

| Page | Layout | Cache helper | Notes |
|---|---|---|---|
| `index.astro` (home) | PageLayout hero | **markPublicCacheable** (was markPrivate) | now anonymous (auth client-hydrated); themed hero + CTAs, not a full landing |
| `login` / `signup` / `verify-email` | BaseLayout | markPrivate (unchanged — mint sessions) | themed forms |
| `new-post` / `choose-username` / `feed` | BaseLayout | markPrivate | authed |
| `authors` | PageLayout ("Recent authors") | markFeedCacheable + CSP | follow island stays |
| `[handle]/index` (profile) | BaseLayout | markPublicCacheable + CSP | social island stays; OG/JSON-LD/RSS → head slot |
| `[handle]/[slug]` (post) | BaseLayout | markPublicCacheable + CSP | OG/JSON-LD/RSS → head slot; `#post-body` (Shiki) themed |

**Cache-leak invariant preserved:** no per-viewer state enters cached SSR — the nav auth slot is client-only, and `data-*` embedded server-side stay viewer-independent (as in M2.1). The home page's markPrivate→markPublicCacheable flip is safe precisely because auth moved to the client.

## 9. Testing strategy (source/structure + build-gate + E2E, per the repo convention)

- **Must stay green:** `page-cache-inventory` (exactly one cache helper per page; chrome components call none), the profile/post/feed cache tripwires, the anonymous-`apiFetch` guards, the "no `listing` tag" tripwire, and the M2.1 island cache invariant.
- **Updated:** the `csp` test (now asserts `font-src`/`style-src`/`img-src cdn`); the per-page structure tests (pages import `BaseLayout`; page-specific head in the slot); the home page's cacheability test (private → public).
- **New:** chrome structure tests — `BaseLayout` head-slot + Nav + main + Footer; `Nav` has the app links + wordmark→apex + auth-slot placeholder and **no** viewer state in SSR; `Wordmark` has **no** inline `style=`; the `nav-auth` island + `/api/me`/`/api/logout` proxies fetch only same-origin `/api/*` and are `markPrivate`; a fonts source assertion (`BaseHead` imports the two `@fontsource-variable/*`) + a build-gate that the woff2 assets are emitted.
- **E2E — themed-shell smoke:** a logged-out visitor sees **Sign in / Sign up** in the nav; a logged-in user sees **@handle** + **Sign out**, and Sign out actually clears the session (subsequent load shows Sign in). Plus a spot-check that a themed public page still renders its content (no regression to the M2.1 flows).

## 10. Deferred / roadmap

- **Full marketing-style home landing** (hero + feed preview + rich CTAs) — this milestone ships a clean themed hero only.
- **Per-page OG images** — the app uses a single default; per-post OG images later.
- **About / Community-guidelines pages**, deeper per-page visual polish, font-preload `<link>`s for first-paint.
- **Wordmark → apex** cross-link follows the handoff; trivially revisitable if the founder wants wordmark → app-home instead.

## 11. Open questions

- **Primary pill CTA target** — logged-out: "Sign up"; logged-in: "New post" (the app's primary action). Resolved as: the pill is part of the client-hydrated auth slot (Sign up when logged out, New post when logged in), so it stays cache-safe. No blocker.
- None outstanding that block the plan.

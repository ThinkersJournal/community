# Web theming — parent design-system adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the ThinkersJournal.com marketing-site design system (tokens, self-hosted fonts, a shared `BaseLayout`/`Nav`/`Footer` chrome, small components) across every HTML page of the Community `web` app, with a client-hydrated auth nav that keeps cached pages viewer-independent — preserving the M1 edge-cache discipline and the existing CSP.

**Architecture:** Port the parent's CSS (`tokens.css` + `global.css`) verbatim and self-host the same two Fontsource variable fonts. Introduce `apps/web/src/components/` (the app's first components dir) with a `BaseLayout` shell that exposes a named `head` slot (so profile/post pages keep their in-source OG/RSS/JSON-LD). The nav's only per-viewer bit (Sign in/up ↔ @handle+Sign out) hydrates client-side via a bundled island + `/api/me`/`/api/logout` proxies. Each page keeps its own cache-helper + CSP call in frontmatter and wraps its body in the layout.

**Tech Stack:** Astro `7.0.9` (`output:'server'` + `@astrojs/cloudflare@14.1.3`), plain CSS custom properties (no Tailwind/framework), `@fontsource-variable/{fraunces,inter}` (self-hosted, Vite-bundled), vitest (plain-Node source/structure tests), Playwright (E2E).

## Global Constraints

Every task's requirements implicitly include this section. Values verified against the current codebase.

- **Node** `26`, **pnpm** `9.15.9`, **Astro** pinned `7.0.9`, `@astrojs/cloudflare` `14.1.3`, **vitest** `4.1.10`, **wrangler** `4.110.0`.
- **Dark-only.** No `prefers-color-scheme`, no light theme, no toggle (the parent's `global.css` has none).
- **CSP is already complete — DO NOT change `apps/web/src/lib/csp.ts` or `apps/web/test/csp.test.ts`.** `PUBLIC_PAGE_CSP` already emits: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.thinkersjournal.com; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`. The `'unsafe-inline'` is **style-src-only** (Shiki token styles) and a creep-guard test pins it there alone — **never add `'unsafe-inline'`/`'unsafe-eval'` to any other directive, and never add an inline `<script>`** (`script-src 'self'` has no `unsafe-inline`). `setPublicPageCsp(context)` takes anything with `{response:{headers:Headers}}` (pages call `setPublicPageCsp(Astro)`); it sets `content-security-policy` + `x-content-type-options: nosniff` + `referrer-policy` and touches no cache header.
- **Cache discipline (M1, unchanged):** every executable file under `src/pages/` calls **exactly one** of `markPublicCacheable` / `markFeedCacheable` / `markPrivate` (`page-cache-inventory.test.ts` SWEEP A); **nothing under `src/` except `lib/cache.ts`** may call `cache.set(` or set a `cache-control`/`cloudflare-cdn-cache-control` header (SWEEP B). **Chrome components render markup only — they never call a cache helper.** No per-viewer state in cached SSR HTML — the nav auth slot is client-hydrated; embedded `data-*` stays viewer-independent.
- **Bundled islands, never inline JS on a CSP page:** an Astro `<script>` containing an `import` is externalized by Astro to a `/_astro/*.js` module served from `'self'` (satisfies `script-src 'self'`). The pattern is `<script>import { fn } from "<rel>/scripts/<mod>"; fn();</script>`. Existing example: `src/scripts/social.ts` mounted from `[handle]/index.astro` (`../../scripts/social`) and `authors.astro` (`../scripts/social`). Path depth is relative to the emitting file.
- **Page-specific head stays in the page.** Move OG/Twitter/RSS-`<link>`/JSON-LD into a `<Fragment slot="head">` **in the page's own `.astro` source** — do NOT centralize them in `BaseHead`, or these literal-string tests fail: `feed-pages.test.ts:108-118` (RSS `<link rel="alternate" type="application/rss+xml" href="/rss.xml">` must appear in both `[handle]/index.astro` and `[handle]/[slug].astro`) and `post-page.test.ts:157` (`<script is:inline type="application/ld+json"` must appear in `[slug].astro`). The `is:inline` on the JSON-LD `<script>` is **required** (without it Astro externalizes it and destroys the structured data).
- **Two forbidden tokens** in `[handle]/[slug].astro` and `[handle]/index.astro`: their tests assert the source has **no** `Astro.request` and **no** `request:` (they must stay anonymous-by-construction). `[handle]/index.astro` must additionally never contain `set:html`. Retrofit must not introduce these.
- **Canonical/URLs:** `CANONICAL_ORIGIN = "https://community.thinkersjournal.com"` (`src/lib/canonical.ts`), `profileUrl`/`postUrl` builders; `jsonLdScript(data)` (`src/lib/json-ld.ts`) JSON-stringifies + escapes `<`; `FEED_TITLE` from `src/lib/xml.ts`. Wordmark links to the **apex** `https://thinkersjournal.com/` (the marketing site).
- **Web build:** `pnpm --filter @thinkersjournal/web build` = `node ../../scripts/build-web.mjs` (NOT bare `astro build`). Adopting scoped `<style>` components + `@fontsource` imports needs **no `astro.config.mjs` change** (Astro compiles scoped styles natively; Vite bundles font CSS/woff2 as same-origin assets). `astro.config.mjs` keeps `cache: { provider: cacheCloudflare() }` (the Workers-Cache on-switch) and `adapter: cloudflare({ imageService: "passthrough" })` — do not touch.
- **Test commands:** `pnpm --filter @thinkersjournal/web test [pattern]`, `pnpm --filter @thinkersjournal/web build`, `pnpm --filter @thinkersjournal/web run typecheck` (`astro check`), `pnpm typecheck`, `pnpm test:e2e`. Web tests are plain-Node **source/structure** assertions (`readFileSync` + a `stripComments` helper + regex/`toContain`) + built-manifest greps (`it.skipIf(!existsSync('dist/server/entry.mjs'))`); there is no in-vitest render. E2E uses the dev DB `thinkersjournal`.

## File Structure

**New — `apps/web/src/styles/`:**
- `tokens.css` — the parent `:root` (all 15 tokens).
- `global.css` — the parent global CSS (`@import './tokens.css'` + reset/body/utilities/`h1,h2,h3`).

**New — `apps/web/src/components/` (first components dir):**
- `Wordmark.astro`, `Button.astro`, `SectionLabel.astro` — small components.
- `BaseHead.astro` — `<head>` generics + font + global.css imports.
- `Nav.astro` — sticky chrome + app links + `[data-auth-slot]`.
- `Footer.astro` — app footer.
- `BaseLayout.astro` — the shell (Nav + `<main><slot/></main>` + Footer, with a named `head` slot).
- `PageLayout.astro` — band-header hero wrapping `BaseLayout`.

**New — `apps/web/src/scripts/`:**
- `nav-auth.ts` — the nav auth-slot island.
- `media-upload.ts` — the media-upload island extracted from `new-post.astro` (so it becomes bundled/CSP-safe).

**New — `apps/web/src/pages/api/`:**
- `me.ts` (GET), `logout.ts` (POST) — nav-auth proxies.

**New — `apps/web/public/`:**
- `favicon.svg`.

**Modified — every HTML page** (`index`, `login`, `signup`, `verify-email`, `new-post`, `choose-username`, `feed`, `authors`, `[handle]/index`, `[handle]/[slug]`): wrap in the layout, keep its cache-helper call, add/keep its CSP call, restyle. **`apps/web/package.json`**: add the two font deps. Several `apps/web/test/*.ts` structure tests updated where noted.

**Untouched:** `src/lib/csp.ts` + `test/csp.test.ts`, `src/lib/cache.ts` + `test/cache.test.ts`, `sitemap.xml.ts`/`rss.xml.ts`, `astro.config.mjs`.

---

## Task 1: Foundation — tokens, global CSS, fonts, favicon

**Files:**
- Create: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/global.css`, `apps/web/public/favicon.svg`
- Modify: `apps/web/package.json` (add font deps)
- Test: `apps/web/test/design-foundation.test.ts`

**Interfaces:**
- Produces: `src/styles/tokens.css` (defines the `:root` custom properties), `src/styles/global.css` (imports tokens; defines `.wrap/.serif/.label/.btn*/.link` + `body` + `h1,h2,h3`), `public/favicon.svg`; deps `@fontsource-variable/fraunces` + `@fontsource-variable/inter` in `apps/web/package.json`. (Consumed by Task 3's `BaseHead`.)

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/design-foundation.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const tokens = () => readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8");
const global = () => readFileSync(join(ROOT, "src/styles/global.css"), "utf8");

describe("design tokens", () => {
  it("defines the chrome-critical custom properties", () => {
    const t = tokens();
    for (const token of ["--ink:#060608", "--green:#3dff95", "--text:#f3f3f5", "--muted:#a8a8b3",
      "--head:#fafafc", "--on-green:#03130a", "--line:rgba(255,255,255,.08)",
      "--green-glow:rgba(61,255,149,.5)", "--wrap:1120px"]) {
      expect(t.replace(/\s/g, "")).toContain(token.replace(/\s/g, ""));
    }
    expect(t).toContain("'Fraunces Variable'");
    expect(t).toContain("'Inter Variable'");
  });
  it("is dark-only (no prefers-color-scheme)", () => {
    expect(tokens()).not.toContain("prefers-color-scheme");
    expect(global()).not.toContain("prefers-color-scheme:light");
  });
});

describe("global css", () => {
  it("imports tokens and defines the utility classes + serif headings", () => {
    const g = global();
    expect(g).toContain("@import './tokens.css'");
    for (const cls of [".wrap", ".serif", ".label", ".btn", ".btn-primary", ".btn-ghost", ".link"]) {
      expect(g).toContain(cls);
    }
    expect(g).toMatch(/h1,\s*h2,\s*h3\{[^}]*var\(--serif\)/);
    expect(g).toContain(":focus-visible");
    expect(g).toContain("prefers-reduced-motion");
  });
});

describe("fonts + favicon are declared", () => {
  it("adds both Fontsource variable packages as web deps", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies["@fontsource-variable/fraunces"]).toBeDefined();
    expect(pkg.dependencies["@fontsource-variable/inter"]).toBeDefined();
  });
  it("ships a favicon", () => {
    expect(existsSync(join(ROOT, "public/favicon.svg"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test design-foundation`
Expected: FAIL — files/deps missing.

- [ ] **Step 3: Create the CSS + favicon + deps**

Create `apps/web/src/styles/tokens.css`:

```css
:root{
  --ink:#060608;
  --ink2:#0a0a0d;
  --green:#3dff95;
  --green-bright:#7dffbc;
  --green-glow:rgba(61,255,149,.5);
  --text:#f3f3f5;
  --muted:#a8a8b3;
  --dim:#7a7a85;
  --head:#fafafc;
  --emph:#e9e9ee;
  --on-green:#03130a;
  --line:rgba(255,255,255,.08);
  --serif:'Fraunces Variable',Georgia,'Times New Roman',serif;
  --sans:'Inter Variable',-apple-system,'Segoe UI',system-ui,sans-serif;
  --wrap:1120px;
}
```

Create `apps/web/src/styles/global.css`:

```css
@import './tokens.css';

*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}
  *{animation-duration:.001ms !important;transition-duration:.001ms !important}}
body{background:var(--ink);color:var(--text);font-family:var(--sans);
  -webkit-font-smoothing:antialiased;overflow-x:hidden;line-height:1.6}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
:focus-visible{outline:2px solid var(--green);outline-offset:3px;border-radius:3px}

.wrap{max-width:var(--wrap);margin:0 auto;padding:0 clamp(20px,5vw,48px)}
.serif{font-family:var(--serif)}
.label{font-family:var(--sans);font-size:12px;font-weight:600;letter-spacing:.24em;
  text-transform:uppercase;color:var(--green);opacity:.95}
em{font-family:var(--serif);font-style:italic;color:var(--green-bright)}

.btn{display:inline-block;font-family:var(--sans);font-size:15px;font-weight:600;
  padding:13px 26px;border-radius:999px;transition:transform .15s ease}
.btn:hover{transform:translateY(-2px)}
.btn-primary{background:var(--green);color:var(--on-green);box-shadow:0 8px 30px -6px var(--green-glow)}
.btn-ghost{background:transparent;color:var(--text);border:1px solid rgba(255,255,255,.22)}
.link{color:var(--green);font-weight:600;font-size:15px}
.link:hover{text-decoration:underline}

h1,h2,h3{font-family:var(--serif);font-weight:500;letter-spacing:-.01em;color:var(--head)}
```

Create `apps/web/public/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#060608"/>
  <text x="15" y="45" font-family="Georgia, serif" font-size="38" fill="#f3f3f5">T</text>
  <circle cx="46" cy="42" r="4.5" fill="#3dff95"/>
</svg>
```

Add the deps: edit `apps/web/package.json` `dependencies` to include (alphabetical, near `astro`):

```json
    "@fontsource-variable/fraunces": "^5.1.0",
    "@fontsource-variable/inter": "^5.1.0",
```

Then install: run `pnpm install` (from repo root).

- [ ] **Step 4: Run the test + confirm the build still works**

Run: `pnpm --filter @thinkersjournal/web test design-foundation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles apps/web/public/favicon.svg apps/web/package.json ../../pnpm-lock.yaml apps/web/test/design-foundation.test.ts
git commit -m "feat(theming): design tokens, global css, self-hosted fonts, favicon"
```

---

## Task 2: Small components — Wordmark, Button, SectionLabel

**Files:**
- Create: `apps/web/src/components/Wordmark.astro`, `Button.astro`, `SectionLabel.astro`
- Test: `apps/web/test/components-small.test.ts`

**Interfaces:**
- Produces: `Wordmark` (props `size?: 'lg'|'sm'`), `Button` (props `href: string; variant?: 'primary'|'ghost'`), `SectionLabel` (slot only). Consumed by Nav (Task 4), Footer (Task 5), PageLayout (Task 6).

**Note (spec correction):** the parent's `Wordmark` uses an inline `style={size}` attribute. The app's CSP already permits inline styles (`style-src 'self' 'unsafe-inline'`), so this is not a CSP blocker — but per spec decision #5 we still make size a **class** (avoids expanding `'unsafe-inline'` reliance and is cleaner). Only two sizes are used (nav `lg`, footer `sm`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components-small.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const C = (name: string) =>
  readFileSync(join(import.meta.dirname, "../src/components", name), "utf8");

describe("Wordmark", () => {
  const src = () => C("Wordmark.astro");
  it("uses a size CLASS, not an inline style attribute", () => {
    expect(src()).not.toMatch(/style=\{/);
    expect(src()).toMatch(/size\??:\s*['"]lg['"]\s*\|\s*['"]sm['"]/);
  });
  it("renders the wordmark text + green dot from tokens", () => {
    expect(src()).toContain("Thinker");
    expect(src()).toContain("var(--head)");
    expect(src()).toContain("var(--green-glow)");
  });
});

describe("Button", () => {
  it("is a style-less shell over the global .btn classes", () => {
    const s = C("Button.astro");
    expect(s).toMatch(/btn btn-\$\{variant\}/);
    expect(s).not.toContain("<style");
  });
});

describe("SectionLabel", () => {
  it("emits the global .label class", () => {
    expect(C("SectionLabel.astro")).toMatch(/class="label"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test components-small`
Expected: FAIL — components missing.

- [ ] **Step 3: Create the components**

`apps/web/src/components/Wordmark.astro`:

```astro
---
interface Props { size?: 'lg' | 'sm' }
const { size = 'lg' } = Astro.props;
---
<span class:list={["wm", `wm-${size}`]}>Thinker's Journal<span class="dot">.</span></span>
<style>
  .wm{font-family:var(--serif);font-weight:500;color:var(--head)}
  .wm-lg{font-size:21px}
  .wm-sm{font-size:20px}
  .dot{color:var(--green);text-shadow:0 0 14px var(--green-glow)}
</style>
```

`apps/web/src/components/Button.astro`:

```astro
---
interface Props { href: string; variant?: 'primary' | 'ghost' }
const { href, variant = 'primary' } = Astro.props;
---
<a href={href} class={`btn btn-${variant}`}><slot /></a>
```

`apps/web/src/components/SectionLabel.astro`:

```astro
---
---
<p class="label"><slot /></p>
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm --filter @thinkersjournal/web test components-small && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Wordmark.astro apps/web/src/components/Button.astro apps/web/src/components/SectionLabel.astro apps/web/test/components-small.test.ts
git commit -m "feat(theming): Wordmark (class-sized), Button, SectionLabel components"
```

---

## Task 3: BaseHead — head generics + font/CSS imports

**Files:**
- Create: `apps/web/src/components/BaseHead.astro`
- Test: `apps/web/test/base-head.test.ts`

**Interfaces:**
- Consumes: `CANONICAL_ORIGIN` (`../lib/canonical`).
- Produces: `BaseHead` (props `title: string; description?: string; canonical?: string`). Emits ONLY generic head (charset, viewport, title, description, canonical, favicon, theme-color, og:site_name) + the font + global.css imports. **Emits no `og:type`/`og:title`/`og:url`/`twitter:*`** — those stay page-specific (Task 14/15 Fragments) to avoid duplicate tags. Consumed by `BaseLayout` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/base-head.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () => readFileSync(join(import.meta.dirname, "../src/components/BaseHead.astro"), "utf8");

describe("BaseHead", () => {
  it("self-hosts both fonts + imports global css (which pulls tokens)", () => {
    const s = src();
    expect(s).toContain("import '@fontsource-variable/fraunces'");
    expect(s).toContain("import '@fontsource-variable/inter'");
    expect(s).toContain("../styles/global.css");
  });
  it("emits the generic head: charset, viewport, title, canonical, favicon, theme-color", () => {
    const s = src();
    expect(s).toContain('charset="utf-8"');
    expect(s).toContain("width=device-width");
    expect(s).toMatch(/<title>\{title\}<\/title>/);
    expect(s).toMatch(/rel="canonical"/);
    expect(s).toMatch(/rel="icon"\s+href="\/favicon\.svg"/);
    expect(s).toContain('name="theme-color" content="#060608"');
  });
  it("does NOT emit page-specific OG/Twitter (those stay in page head slots)", () => {
    const s = src();
    expect(s).not.toContain('property="og:type"');
    expect(s).not.toContain('name="twitter:card"');
  });
  it("defaults canonical to CANONICAL_ORIGIN + path (constant origin, never the request host)", () => {
    const s = src();
    expect(s).toContain("CANONICAL_ORIGIN");
    expect(s).not.toMatch(/Astro\.url\.(origin|host)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test base-head`
Expected: FAIL — missing.

- [ ] **Step 3: Create BaseHead**

`apps/web/src/components/BaseHead.astro`:

```astro
---
import '@fontsource-variable/fraunces';
import '@fontsource-variable/inter';
import '../styles/global.css';

import { CANONICAL_ORIGIN } from '../lib/canonical';

interface Props { title: string; description?: string; canonical?: string }
const { title, description, canonical } = Astro.props;
// Constant origin + path (path IS in the Workers Cache key; host is NOT — so we
// must never build this from the request host). Pages with a computed canonical
// (post/profile) pass it explicitly.
const canonicalUrl = canonical ?? `${CANONICAL_ORIGIN}${Astro.url.pathname}`;
---
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title}</title>
{description && <meta name="description" content={description} />}
<link rel="canonical" href={canonicalUrl} />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta name="theme-color" content="#060608" />
<meta property="og:site_name" content="Thinker's Journal" />
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @thinkersjournal/web test base-head && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BaseHead.astro apps/web/test/base-head.test.ts
git commit -m "feat(theming): BaseHead (fonts + global css + generic meta)"
```

---

## Task 4: Nav — sticky chrome + app links + progressive auth slot

**Files:**
- Create: `apps/web/src/components/Nav.astro`
- Test: `apps/web/test/nav.test.ts`

**Interfaces:**
- Consumes: `Wordmark` (`./Wordmark.astro`).
- Produces: `Nav` (no props). Sticky chrome (parent CSS verbatim) + wordmark (→ apex) + static browse links Feed/Authors + a `[data-auth-slot]` whose **SSR default is the anonymous view** (Sign in + Sign up pill) — functional without JS, cache-safe. Task 8's island upgrades the slot for logged-in viewers. Consumed by `BaseLayout` (Task 6).

**Progressive enhancement:** the auth slot's SSR content is the logged-OUT view (correct for anonymous, a safe default for everyone). No per-viewer state in SSR. The island swaps in the logged-in view client-side.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/nav.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () => readFileSync(join(import.meta.dirname, "../src/components/Nav.astro"), "utf8");

describe("Nav", () => {
  it("wordmark links to the apex marketing site", () => {
    expect(src()).toMatch(/href="https:\/\/thinkersjournal\.com\/"/);
  });
  it("has static browse links to /feed and /authors", () => {
    const s = src();
    expect(s).toContain('href="/feed"');
    expect(s).toContain('href="/authors"');
  });
  it("has the client-hydrated auth slot with an anonymous-default SSR view", () => {
    const s = src();
    expect(s).toMatch(/data-auth-slot/);
    // anonymous default is functional without JS
    expect(s).toContain('href="/login"');
    expect(s).toContain('href="/signup"');
  });
  it("carries NO per-viewer state (no cookie/session read, no apiFetch)", () => {
    const s = src();
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/Astro\.request/);
  });
  it("keeps the zero-JS mobile disclosure (checkbox + label siblings)", () => {
    const s = src();
    expect(s).toContain('type="checkbox"');
    expect(s).toContain('id="nav-toggle"');
    expect(s).toMatch(/for="nav-toggle"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test nav`
Expected: FAIL — missing.

- [ ] **Step 3: Create Nav** (chrome CSS is the parent's, verbatim)

`apps/web/src/components/Nav.astro`:

```astro
---
import Wordmark from './Wordmark.astro';
---
<header class="nav">
  <div class="wrap bar">
    <a href="https://thinkersjournal.com/" class="brand" aria-label="Thinker's Journal home"><Wordmark /></a>

    <input type="checkbox" id="nav-toggle" class="nav-toggle" />
    <label for="nav-toggle" class="burger" aria-label="Toggle navigation menu">
      <span class="bars" aria-hidden="true"></span>
    </label>

    <nav class="links" aria-label="Primary">
      <a href="/feed">Feed</a>
      <a href="/authors">Authors</a>
      <span class="auth" data-auth-slot>
        <a href="/login">Sign in</a>
        <a href="/signup" class="support">Sign up</a>
      </span>
    </nav>
  </div>
</header>
<style>
  .nav{position:sticky;top:0;z-index:40;background:rgba(6,6,8,.72);
    backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
  .bar{display:flex;align-items:center;justify-content:space-between;height:66px;gap:18px}
  .links{display:flex;gap:26px;align-items:center;font-size:14px;color:var(--muted)}
  .links a:hover{color:var(--text)}
  .auth{display:flex;gap:26px;align-items:center}
  .support{font-size:13.5px;font-weight:600;color:var(--on-green) !important;background:var(--green);
    padding:9px 17px;border-radius:999px;box-shadow:0 0 20px var(--green-glow)}
  .nav-toggle{display:none}
  .burger{display:none}
  @media(max-width:840px){
    .nav-toggle{display:block;position:absolute;width:1px;height:1px;margin:-1px;
      padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .burger{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;
      border:1px solid var(--line);border-radius:10px;cursor:pointer;background:transparent}
    .bars,.bars::before,.bars::after{content:"";display:block;width:20px;height:2px;
      border-radius:2px;background:var(--text);transition:transform .2s ease,opacity .2s ease}
    .bars{position:relative}
    .bars::before{position:absolute;top:-6px;left:0}
    .bars::after{position:absolute;top:6px;left:0}
    .nav-toggle:focus-visible ~ .burger{outline:2px solid var(--green);outline-offset:3px}
    .nav-toggle:checked ~ .burger .bars{background:transparent}
    .nav-toggle:checked ~ .burger .bars::before{transform:translateY(6px) rotate(45deg)}
    .nav-toggle:checked ~ .burger .bars::after{transform:translateY(-6px) rotate(-45deg)}
    .links{position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:stretch;
      gap:0;background:rgba(6,6,8,.97);backdrop-filter:blur(12px);
      border-bottom:1px solid var(--line);padding:8px 0 16px;display:none}
    .nav-toggle:checked ~ .links{display:flex}
    .links a{padding:13px clamp(20px,6vw,48px);font-size:16px}
    .links a:not(.support):hover{background:rgba(255,255,255,.04);color:var(--text)}
    .auth{flex-direction:column;align-items:stretch;gap:0}
    .support{margin:12px clamp(20px,6vw,48px) 4px;text-align:center}
  }
</style>
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @thinkersjournal/web test nav && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Nav.astro apps/web/test/nav.test.ts
git commit -m "feat(theming): Nav chrome + app links + progressive auth slot"
```

---

## Task 5: Footer

**Files:**
- Create: `apps/web/src/components/Footer.astro`
- Test: `apps/web/test/footer.test.ts`

**Interfaces:**
- Consumes: `Wordmark` (`./Wordmark.astro`).
- Produces: `Footer` (no props). Parent footer treatment (`#040405`, `--line` borders, note bar) with app content: wordmark + tagline · a Community links column (Feed, Authors) · a "← thinkersjournal.com" back-link · the non-profit note + Privacy/GitHub.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/footer.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () => readFileSync(join(import.meta.dirname, "../src/components/Footer.astro"), "utf8");

describe("Footer", () => {
  it("uses the parent footer treatment + links back to the apex site", () => {
    const s = src();
    expect(s).toContain("#040405");
    expect(s).toMatch(/href="https:\/\/thinkersjournal\.com\/"/);
  });
  it("has Community links + is pure presentation (no cache helper / apiFetch)", () => {
    const s = src();
    expect(s).toContain('href="/feed"');
    expect(s).toContain('href="/authors"');
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/mark(Private|PublicCacheable|FeedCacheable)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test footer`
Expected: FAIL.

- [ ] **Step 3: Create Footer**

`apps/web/src/components/Footer.astro`:

```astro
---
import Wordmark from './Wordmark.astro';
---
<footer class="ft">
  <div class="wrap grid">
    <div class="brand">
      <Wordmark size="sm" />
      <p>The community for thinkers who build — publish your work, follow other builders, and reference the exact thing you're talking about.</p>
    </div>
    <div class="col">
      <h4>Community</h4>
      <a href="/feed">Your feed</a>
      <a href="/authors">Discover authors</a>
      <a href="/new-post">Write a post</a>
    </div>
    <div class="col">
      <h4>Thinker's Journal</h4>
      <a href="https://thinkersjournal.com/">← thinkersjournal.com</a>
      <a href="https://thinkersjournal.com/mission">Our mission</a>
    </div>
  </div>
  <div class="wrap note">
    <span>Thinker's Journal is a non-profit in formation. <span class="green">No thinker should have to build alone.</span></span>
    <span><a href="https://thinkersjournal.com/privacy">Privacy</a> · <a href="https://github.com/thinkersjournal">github.com/thinkersjournal</a></span>
  </div>
</footer>
<style>
  .ft{background:#040405;border-top:1px solid var(--line);padding:64px 0 40px}
  .grid{display:grid;grid-template-columns:1.6fr 1fr 1fr;gap:34px}
  @media(max-width:760px){.grid{grid-template-columns:1fr 1fr}}
  .brand p{color:var(--dim);font-size:14px;margin-top:12px;max-width:38ch}
  .col h4{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:14px}
  .col a{display:block;color:var(--muted);font-size:14.5px;padding:5px 0}
  .col a:hover{color:var(--text)}
  .note{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);
    color:var(--dim);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
  .note .green{color:var(--green)}
</style>
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @thinkersjournal/web test footer && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Footer.astro apps/web/test/footer.test.ts
git commit -m "feat(theming): Footer"
```

---

## Task 6: BaseLayout + PageLayout

**Files:**
- Create: `apps/web/src/components/BaseLayout.astro`, `apps/web/src/components/PageLayout.astro`
- Test: `apps/web/test/layouts.test.ts`

**Interfaces:**
- Consumes: `BaseHead`, `Nav`, `Footer` (Tasks 3–5), `SectionLabel` (Task 2).
- Produces: `BaseLayout` (props `title: string; description?: string; canonical?: string`; default `<slot/>` for body; **named `head` slot** for page-specific head). `PageLayout` (props `title: string; eyebrow: string; heading: string; intro?: string`; wraps `BaseLayout`, renders a band hero + `.wrap.body` slot). Consumed by every retrofitted page (Tasks 9–15).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/layouts.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const C = (name: string) => readFileSync(join(import.meta.dirname, "../src/components", name), "utf8");

describe("BaseLayout", () => {
  const s = () => C("BaseLayout.astro");
  it("is the shell: html/head[BaseHead + named head slot]/body[Nav + main slot + Footer]", () => {
    const src = s();
    expect(src).toContain("<html");
    expect(src).toMatch(/<BaseHead\s/);
    expect(src).toMatch(/<slot\s+name="head"\s*\/>/);
    expect(src).toMatch(/<Nav\s*\/>/);
    expect(src).toMatch(/<main>[\s\S]*<slot\s*\/>[\s\S]*<\/main>/);
    expect(src).toMatch(/<Footer\s*\/>/);
  });
  it("renders no cache-control/cache.set (SWEEP B — components are markup-only)", () => {
    const src = s();
    expect(src).not.toContain("cache.set");
    expect(src).not.toMatch(/mark(Private|PublicCacheable|FeedCacheable)/);
  });
});

describe("PageLayout", () => {
  it("wraps BaseLayout + a band hero with eyebrow/heading/intro", () => {
    const src = C("PageLayout.astro");
    expect(src).toMatch(/<BaseLayout\s/);
    expect(src).toContain("SectionLabel");
    expect(src).toMatch(/class="band"/);
    expect(src).toMatch(/<slot\s*\/>/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test layouts`
Expected: FAIL.

- [ ] **Step 3: Create the layouts**

`apps/web/src/components/BaseLayout.astro`:

```astro
---
import BaseHead from './BaseHead.astro';
import Nav from './Nav.astro';
import Footer from './Footer.astro';

interface Props { title: string; description?: string; canonical?: string }
const { title, description, canonical } = Astro.props;
---
<html lang="en">
  <head>
    <BaseHead title={title} description={description} canonical={canonical} />
    <slot name="head" />
  </head>
  <body>
    <Nav />
    <main>
      <slot />
    </main>
    <Footer />
  </body>
</html>
```

`apps/web/src/components/PageLayout.astro`:

```astro
---
import BaseLayout from './BaseLayout.astro';
import SectionLabel from './SectionLabel.astro';

interface Props { title: string; eyebrow: string; heading: string; intro?: string; description?: string; canonical?: string }
const { title, eyebrow, heading, intro, description, canonical } = Astro.props;
---
<BaseLayout title={title} description={description} canonical={canonical}>
  <slot name="head" slot="head" />
  <div class="band"><div class="wrap">
    <SectionLabel>{eyebrow}</SectionLabel>
    <h1>{heading}</h1>
    {intro && <p class="intro">{intro}</p>}
  </div></div>
  <div class="wrap body"><slot /></div>
</BaseLayout>
<style>
  .band{padding:clamp(56px,8vw,96px) 0 clamp(30px,4vw,44px);
    background:linear-gradient(180deg,#111114 0%,#060608 100%);
    border-bottom:1px solid var(--line);position:relative;overflow:hidden}
  .band::after{content:"";position:absolute;inset:-40% -10% 0;filter:blur(70px);opacity:.6;z-index:0;
    background:radial-gradient(36% 60% at 22% 20%,rgba(61,255,149,.14),transparent 70%)}
  .band .wrap{position:relative;z-index:2}
  h1{font-size:clamp(32px,5.2vw,54px);line-height:1.06;margin-top:16px}
  .intro{color:var(--muted);font-size:clamp(16px,2vw,19px);margin-top:20px;max-width:60ch}
  .body{padding:clamp(48px,7vw,88px) 0}
</style>
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @thinkersjournal/web test layouts && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BaseLayout.astro apps/web/src/components/PageLayout.astro apps/web/test/layouts.test.ts
git commit -m "feat(theming): BaseLayout (head slot) + PageLayout (band hero)"
```

---

## Task 7: Nav-auth proxies — `/api/me` + `/api/logout`

**Files:**
- Create: `apps/web/src/pages/api/me.ts`, `apps/web/src/pages/api/logout.ts`
- Test: `apps/web/test/nav-auth-proxies.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `applyCookies` (`../../lib/api`), `markPrivate` (`../../lib/cache`), `Me` (`@thinkersjournal/shared`).
- Produces: `GET /api/me` → `{ loggedIn, username, usernameChosen, csrfToken }`; `POST /api/logout` → proxies `POST /auth/logout`. Both `markPrivate`. Consumed by the nav-auth island (Task 8).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/nav-auth-proxies.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../src/pages/api");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("/api/me", () => {
  const s = () => strip(readFileSync(join(DIR, "me.ts"), "utf8"));
  it("is a GET APIRoute, markPrivate (wrapped), proxies /profile/me + /auth/csrf, forwards cookie", () => {
    const src = s();
    expect(src).toMatch(/export const GET\s*:\s*APIRoute/);
    expect(src).toContain("export const prerender = false");
    expect(src).toMatch(/markPrivate\(/);
    expect(src).toMatch(/response:\s*\{\s*headers\s*\}/);
    expect(src).toContain("/profile/me");
    expect(src).toContain("/auth/csrf");
    expect(src).toMatch(/request:\s*context\.request/);
  });
});

describe("/api/logout", () => {
  const s = () => strip(readFileSync(join(DIR, "logout.ts"), "utf8"));
  it("is a POST APIRoute, markPrivate, proxies /auth/logout, applyCookies, forwards origin+csrf", () => {
    const src = s();
    expect(src).toMatch(/export const POST\s*:\s*APIRoute/);
    expect(src).toMatch(/markPrivate\(/);
    expect(src).toContain("/auth/logout");
    expect(src).toContain("applyCookies(");
    expect(src).toMatch(/origin/i);
    expect(src).toMatch(/X-CSRF-Token/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test nav-auth-proxies`
Expected: FAIL.

- [ ] **Step 3: Create the proxies**

`apps/web/src/pages/api/me.ts`:

```ts
/**
 * BROWSER read hop for the nav auth slot. Forwards the session cookie to the api
 * and reports whether the viewer is signed in (+ their handle, onboarding state,
 * and a CSRF token for the logout button). Never cached (markPrivate) — the nav
 * consuming it renders on cached pages, so this per-viewer state stays client-side.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { Me } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const me = await apiFetch<Me>("/profile/me", { request: context.request });
  if (me.status !== 200 || me.data === null) {
    return new Response(
      JSON.stringify({ loggedIn: false, username: null, usernameChosen: false, csrfToken: null }),
      { status: 200, headers },
    );
  }
  const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
  return new Response(
    JSON.stringify({
      loggedIn: true,
      username: me.data.username,
      usernameChosen: me.data.usernameChosen,
      csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
    }),
    { status: 200, headers },
  );
};
```

`apps/web/src/pages/api/logout.ts`:

```ts
/**
 * BROWSER → api authed hop for SIGN OUT. Forwards the session cookie + Origin +
 * CSRF token to POST /auth/logout, propagates the cleared session cookie back.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const response = await apiFetch<unknown>("/auth/logout", {
    method: "POST",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};
```

- [ ] **Step 4: Run test + typecheck + page-cache-inventory**

Run: `pnpm --filter @thinkersjournal/web test nav-auth-proxies page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS (each proxy declares exactly one cache helper).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/api/me.ts apps/web/src/pages/api/logout.ts apps/web/test/nav-auth-proxies.test.ts
git commit -m "feat(theming): /api/me + /api/logout nav-auth proxies"
```

---

## Task 8: Nav-auth island — upgrade the slot for signed-in viewers

**Files:**
- Create: `apps/web/src/scripts/nav-auth.ts`
- Modify: `apps/web/src/components/Nav.astro` (mount the island)
- Test: `apps/web/test/nav-auth-island.test.ts`

**Interfaces:**
- Consumes (browser globals): `fetch`, `document`. Talks to `/api/me`, `/api/logout`.
- Produces: `initNavAuth(): void`. On load, fetches `/api/me`; if `loggedIn`, replaces `[data-auth-slot]`'s contents with **New post · @username · Sign out** (Sign out POSTs `/api/logout` with the csrfToken, then navigates to `/`). If not, leaves the SSR anonymous default (Sign in · Sign up).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/nav-auth-island.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const island = () => readFileSync(join(import.meta.dirname, "../src/scripts/nav-auth.ts"), "utf8");
const nav = () => readFileSync(join(import.meta.dirname, "../src/components/Nav.astro"), "utf8");

describe("nav-auth island", () => {
  it("talks only to same-origin /api/* (never the api Worker directly)", () => {
    const s = island();
    expect(s).toContain("/api/me");
    expect(s).toContain("/api/logout");
    expect(s).not.toMatch(/https?:\/\//);
  });
  it("upgrades the slot for signed-in viewers and wires Sign out", () => {
    const s = island();
    expect(s).toContain("data-auth-slot");
    expect(s).toMatch(/loggedIn/);
    expect(s).toMatch(/X-CSRF-Token/i);
  });
});

describe("Nav mounts the island as a bundled module", () => {
  it("imports initNavAuth (Astro externalizes it → script-src 'self')", () => {
    expect(nav()).toMatch(/import\s+\{\s*initNavAuth\s*\}\s+from\s+["']\.\.\/scripts\/nav-auth["']/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @thinkersjournal/web test nav-auth-island`
Expected: FAIL.

- [ ] **Step 3: Create the island + mount it**

`apps/web/src/scripts/nav-auth.ts`:

```ts
/**
 * Upgrades the nav's [data-auth-slot] for a signed-in viewer. The slot ships a
 * logged-OUT default in SSR (Sign in / Sign up) — cache-safe and functional
 * without JS. This runs client-side, asks the same-origin /api/me proxy who the
 * viewer is, and (only if signed in) swaps in New post / @handle / Sign out.
 * Talks only to same-origin /api/* (the api Worker has no public origin).
 */
interface MeResponse {
  loggedIn: boolean;
  username: string | null;
  usernameChosen: boolean;
  csrfToken: string | null;
}

async function signOut(csrfToken: string | null): Promise<void> {
  if (csrfToken === null) { window.location.href = "/login"; return; }
  await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
  window.location.href = "/";
}

export function initNavAuth(): void {
  const slot = document.querySelector<HTMLElement>("[data-auth-slot]");
  if (slot === null) return;

  void fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
    .then((me) => {
      if (me === null || !me.loggedIn) return; // keep the SSR anonymous default
      slot.replaceChildren();

      const newPost = document.createElement("a");
      newPost.href = "/new-post";
      newPost.textContent = "New post";

      const profile = document.createElement("a");
      profile.href = me.username ? `/@${me.username}` : "/feed";
      profile.textContent = me.username ? `@${me.username}` : "Account";

      const out = document.createElement("button");
      out.type = "button";
      out.className = "support";
      out.textContent = "Sign out";
      out.addEventListener("click", () => void signOut(me.csrfToken));

      slot.append(newPost, profile, out);
    });
}
```

Mount it in `apps/web/src/components/Nav.astro` — add at the end of the file (after the `<style>` block):

```astro
<script>
  import { initNavAuth } from "../scripts/nav-auth";
  initNavAuth();
</script>
```

- [ ] **Step 4: Run test + typecheck + nav test (still green)**

Run: `pnpm --filter @thinkersjournal/web test nav-auth-island nav && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/scripts/nav-auth.ts apps/web/src/components/Nav.astro apps/web/test/nav-auth-island.test.ts
git commit -m "feat(theming): nav-auth island (signed-in slot upgrade + sign out)"
```

---

## Retrofit tasks — shared rules (read before Tasks 9–15)

Each page: (1) add the layout import; (2) keep its **existing frontmatter logic** (apiFetch calls, POST handling, `applyCookies`, manual redirects) exactly — only the **cache-helper call stays in frontmatter** and any **`setPublicPageCsp(Astro)`** is added there; (3) replace the page's own `<html><head>…</head><body>…</body></html>` with `<BaseLayout title=… >…body…</BaseLayout>` (or `<PageLayout>`), moving page-specific head into `<Fragment slot="head">`; (4) restyle content with the global classes (`.wrap`, `.btn`, `.link`, `Button`). **Never** introduce `Astro.request` or `request:` into `[handle]/*` sources, or `set:html` into the profile page. Keep the RSS `<link>` and the `is:inline` JSON-LD **literally in the page source** (inside the Fragment). Do not move the cache-helper or POST-return logic into a component.

---

## Task 9: Retrofit the home page (`index.astro`) — theme + make it cacheable

**Files:**
- Modify: `apps/web/src/pages/index.astro`
- Test: `apps/web/test/home-page.test.ts` (new)

**Interfaces:** consumes `PageLayout`, `Button`, `markPublicCacheable`, `setPublicPageCsp`.

**Behavior change:** the home page today is `markPrivate` + a debug `/health` "api-status" render (an M0 Service-Binding proof, pinned by no test). It becomes an anonymous, themed **landing** (`markPublicCacheable`) — safe now that auth is client-hydrated in the nav. Drop the `/health` apiFetch + `#api-status` display (no test pins them; the SB is exercised by every E2E). Keep the `/authors` + `/feed` links (`authors-page.test.ts:45-48` pins them).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/home-page.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = () =>
  readFileSync(join(import.meta.dirname, "../src/pages/index.astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("home page (themed landing)", () => {
  it("is now anonymous + cacheable (markPublicCacheable), one cache helper", () => {
    const s = src();
    expect(s).toContain("markPublicCacheable(Astro,");
    expect(s).not.toContain("markPrivate(");
  });
  it("sets the public CSP and uses the shared chrome", () => {
    const s = src();
    expect(s).toContain("setPublicPageCsp(Astro)");
    expect(s).toMatch(/<PageLayout\s/);
  });
  it("keeps the /authors and /feed links and is anonymous (no apiFetch)", () => {
    const s = src();
    expect(s).toContain('href="/authors"');
    expect(s).toContain('href="/feed"');
    expect(s).not.toContain("apiFetch");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @thinkersjournal/web test home-page` → FAIL.

- [ ] **Step 3: Rewrite `apps/web/src/pages/index.astro`**

```astro
---
import Button from '../components/Button.astro';
import PageLayout from '../components/PageLayout.astro';
import { markPublicCacheable } from '../lib/cache';
import { setPublicPageCsp } from '../lib/csp';

// Anonymous themed landing — the nav's auth state hydrates client-side, so this
// SSR is viewer-independent and can be edge-cached. (Was markPrivate in M0 when
// it doubled as a Service-Binding debug probe; that proof now lives in the E2E.)
markPublicCacheable(Astro, []);
setPublicPageCsp(Astro);
---
<PageLayout
  title="Thinker's Journal — Community"
  eyebrow="The Community"
  heading="No thinker should have to build alone."
  intro="Publish your work, follow other builders, and reference the exact thing you're building — down to the file, line, or commit."
  canonical="https://community.thinkersjournal.com/"
>
  <p class="cta">
    <Button href="/signup">Get started</Button>
    <Button href="/authors" variant="ghost">Discover authors</Button>
  </p>
  <ul class="links">
    <li><a class="link" href="/feed">Your feed</a></li>
    <li><a class="link" href="/authors">Discover authors</a></li>
    <li><a class="link" href="/new-post">Write a post</a></li>
  </ul>
</PageLayout>
<style>
  .cta{display:flex;gap:14px;flex-wrap:wrap}
  .links{list-style:none;margin-top:32px;display:flex;gap:22px;flex-wrap:wrap}
</style>
```

- [ ] **Step 4: Run tests** — `pnpm --filter @thinkersjournal/web test home-page authors-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/test/home-page.test.ts
git commit -m "feat(theming): themed cacheable home landing"
```

---

## Task 10: Retrofit the auth/onboarding form pages (login, signup, verify-email, choose-username)

**Files:**
- Modify: `apps/web/src/pages/login.astro`, `signup.astro`, `verify-email.astro`, `choose-username.astro`
- Test: extend each page's existing structure test (`choose-username-page.test.ts`, etc.) — see Step 4.

**Interfaces:** consumes `BaseLayout`, `Button`, `setPublicPageCsp`.

These four are near-identical mechanical retrofits: they stay **`markPrivate`**, keep **all** POST-handling / `applyCookies` / manual-redirect / `resolveNext` logic **verbatim in frontmatter**, gain a **`setPublicPageCsp(Astro)`** call (they carry the nav island + fonts now; none has an inline `<script>`, so `script-src 'self'` is safe), and wrap only their `<body>` markup in `<BaseLayout title=…>`. The `<head>` (just `<meta charset>` + `<title>`) is replaced by BaseLayout — pass the title as a prop.

- [ ] **Step 1: Write/extend the failing tests**

For each page's structure test, add assertions that it now imports `BaseLayout` and calls `setPublicPageCsp(Astro)` while keeping `markPrivate(Astro)`. Example addition to `apps/web/test/choose-username-page.test.ts`:

```ts
it("adopts the shared chrome + CSP while staying markPrivate", () => {
  // `code` is the comment-stripped source already read in this file
  expect(code).toMatch(/<BaseLayout\s/);
  expect(code).toContain("setPublicPageCsp(Astro)");
  expect(code).toContain("markPrivate(Astro)");
});
```

Add the analogous test to `login`, `signup`, and `verify-email` (create `login-page.test.ts` / `signup-page.test.ts` if none exists; a minimal file reading the source + the three assertions above).

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @thinkersjournal/web test choose-username-page login-page signup-page verify-email` → FAIL (no BaseLayout/CSP yet).

- [ ] **Step 3: Retrofit each page**

For EACH of the four pages, apply this transformation (illustrated for `login.astro`; apply the same shape to the others, keeping each page's own logic):

Frontmatter — add the imports + the CSP call (keep the existing `markPrivate(Astro)`, `resolveNext`, POST handling, `applyCookies`, and the manual `Response(null,{status:302,…})` success redirect **exactly as-is**):

```astro
import BaseLayout from '../components/BaseLayout.astro';
import Button from '../components/Button.astro';
import { setPublicPageCsp } from '../lib/csp';
// ...existing imports (apiFetch, applyCookies, markPrivate, resolveNext)...

markPrivate(Astro);
setPublicPageCsp(Astro);
// ...existing next/POST/applyCookies/redirect logic UNCHANGED...
```

Template — replace the whole `<html>…</html>` with (login shown; keep each page's own body/`error`/`form`/conditional markup):

```astro
<BaseLayout title="Log in" description="Sign in to Thinker's Journal.">
  <div class="wrap form-page">
    <h1>Log in</h1>
    {error !== null && <p id="error" role="alert">{error}</p>}
    <form method="POST" class="form">
      <label>Email<input type="email" name="email" required /></label>
      <label>Password<input type="password" name="password" required /></label>
      <button type="submit" class="btn btn-primary">Log in</button>
    </form>
    <p><a class="link" href="/signup">Need an account? Sign up</a></p>
  </div>
</BaseLayout>
<style>
  .form-page{padding:clamp(40px,7vw,80px) 0;max-width:440px}
  .form{display:flex;flex-direction:column;gap:16px;margin:24px 0}
  .form label{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:14px}
  .form input{background:var(--ink2);border:1px solid var(--line);border-radius:8px;
    padding:11px 13px;color:var(--text);font:inherit}
  .form input:focus-visible{border-color:var(--green)}
</style>
```

For `signup.astro`: wrap the **entire `result === "created" ? … : <>…</>` conditional** (the `#check-email` branch AND the error+form branch, including the `turnstileToken` input) inside `<BaseLayout title="Sign up">…</BaseLayout>`; keep the turnstile input and all branches. For `verify-email.astro` and `choose-username.astro`: wrap their existing body markup the same way, keeping their token/`?next=`/`apiErrorCode` logic and the `/verify-email` resend link.

⚠️ Do NOT move the success-path `return`ed `Response` (login) or the `applyCookies` calls — those stay in frontmatter, untouched. Wrapping only affects the rendered template.

- [ ] **Step 4: Run tests + full web suite + e2e-relevant check**

Run: `pnpm --filter @thinkersjournal/web test login-page signup-page verify-email choose-username-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck`
Then the FULL suite: `pnpm --filter @thinkersjournal/web test`. Expected: PASS. (If a pre-existing structure test for one of these pages breaks on an unrelated assertion, reconcile it to the new markup without weakening it.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/login.astro apps/web/src/pages/signup.astro apps/web/src/pages/verify-email.astro apps/web/src/pages/choose-username.astro apps/web/test/*-page.test.ts
git commit -m "feat(theming): retrofit auth/onboarding form pages + CSP"
```

---

## Task 11: Retrofit the editor (`new-post.astro`) — bundle its island, then theme + CSP

**Files:**
- Create: `apps/web/src/scripts/media-upload.ts`
- Modify: `apps/web/src/pages/new-post.astro`
- Test: `apps/web/test/new-post-page.test.ts` (extend)

**Interfaces:** consumes `BaseLayout`, `setPublicPageCsp`.

**The load-bearing catch:** `new-post.astro` has an **inline `<script type="module">`** (the media-upload island, no `import` → Astro leaves it inline). Applying `setPublicPageCsp` (`script-src 'self'`, no `'unsafe-inline'`) would **block it**. So first **extract the island to a bundled module** (`src/scripts/media-upload.ts` + a `<script>import …</script>`), which Astro externalizes to `/_astro/*.js` (served `'self'`). Then the page can carry the CSP. Keep all editor POST/publish logic (including the `USERNAME_REQUIRED → /choose-username` manual redirect and the `markPrivate`) verbatim.

- [ ] **Step 1: Write the failing test** — extend `apps/web/test/new-post-page.test.ts`:

```ts
it("has NO inline script and carries the shared chrome + CSP", () => {
  // `code` = comment-stripped source read in this file
  // the media-upload island is now a bundled import, not inline JS
  expect(code).toMatch(/import\s+.*from\s+["']\.\.\/scripts\/media-upload["']/);
  expect(code).toContain("setPublicPageCsp(Astro)");
  expect(code).toMatch(/<BaseLayout\s/);
  expect(code).toContain("markPrivate(Astro)");
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @thinkersjournal/web test new-post-page` → FAIL.

- [ ] **Step 3: Extract the island + retrofit**

Create `apps/web/src/scripts/media-upload.ts` — move the body of `new-post.astro`'s current inline `<script>` (the `#media-file` change handler that POSTs to `/media-upload` with the `X-CSRF-Token` header and inserts the returned URL) into an exported `initMediaUpload()` (convert the top-level code into the function body; keep the exact fetch/DOM logic).

In `new-post.astro`:
- Frontmatter: add `import BaseLayout from '../components/BaseLayout.astro';` + `import { setPublicPageCsp } from '../lib/csp';`; keep `markPrivate(Astro)`; add `setPublicPageCsp(Astro);`. Keep all existing publish/CSRF/`USERNAME_REQUIRED`-redirect logic verbatim.
- Template: wrap the editor body markup in `<BaseLayout title="New post">…</BaseLayout>` (keep the logged-out "log in to write" branch, the not-onboarded "choose a handle" branch, and the editor `<form>` all inside it), restyle with `.wrap`/`.btn`/`.form` classes.
- Replace the old inline `<script>…</script>` with the bundled mount:

```astro
<script>
  import { initMediaUpload } from "../scripts/media-upload";
  initMediaUpload();
</script>
```

- [ ] **Step 4: Run tests + build (island must externalize) + typecheck**

Run: `pnpm --filter @thinkersjournal/web test new-post-page page-cache-inventory && pnpm --filter @thinkersjournal/web build && pnpm --filter @thinkersjournal/web run typecheck`
Expected: PASS; the build emits the media-upload module under `dist/…/_astro/*.js` (bundled, not inline).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/scripts/media-upload.ts apps/web/src/pages/new-post.astro apps/web/test/new-post-page.test.ts
git commit -m "feat(theming): editor — bundle media-upload island, adopt chrome + CSP"
```

---

## Task 12: Retrofit the feed page (`feed.astro`)

**Files:** Modify `apps/web/src/pages/feed.astro`; extend `apps/web/test/home-feed-page.test.ts`.

**Interfaces:** consumes `BaseLayout`, `setPublicPageCsp`.

Keep **`markPrivate`**, the cookie-forwarded `apiFetch("/feed…", {request})`, the manual `Response(null,{status:302,headers:{Location:"/login"}})` redirect (NOT `Astro.redirect`), `applyCookies`, the `/authors` empty-state link, and the `/feed?cursor=` older-posts link — all verbatim in frontmatter. Add `setPublicPageCsp(Astro)` (no inline script here → safe). Wrap the body in `<BaseLayout title="Your feed">`, theme the cards.

- [ ] **Step 1: Extend the test** — add to `home-feed-page.test.ts`:

```ts
it("adopts the chrome + CSP while staying markPrivate", () => {
  expect(code).toMatch(/<BaseLayout\s/);
  expect(code).toContain("setPublicPageCsp(Astro)");
  expect(code).toContain("markPrivate(");
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @thinkersjournal/web test home-feed-page` → FAIL.

- [ ] **Step 3: Retrofit** — add the two imports + `setPublicPageCsp(Astro)` in frontmatter (keep everything else), and wrap the rendered body:

```astro
<BaseLayout title="Your feed">
  <div class="wrap feed">
    <h1>Your feed</h1>
    {feed.posts.length === 0 ? (
      <p>Your feed is empty. <a class="link" href="/authors">Discover authors to follow →</a></p>
    ) : (
      <ul class="cards">
        {feed.posts.map((post) => (
          <li class="card">
            <h2><a href={`/@${post.username}/${post.slug}`}>{post.title}</a></h2>
            <p class="meta">by <a class="link" href={`/@${post.username}`}>@{post.username}</a> · <time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></p>
            <p>{post.excerptSource.slice(0, 200)}</p>
          </li>
        ))}
      </ul>
    )}
    {feed.nextCursor !== null && (
      <a class="link" rel="next" href={`/feed?cursor=${encodeURIComponent(feed.nextCursor)}`}>Older posts →</a>
    )}
  </div>
</BaseLayout>
<style>
  .feed{padding:clamp(40px,7vw,80px) 0}
  .cards{list-style:none;display:flex;flex-direction:column;gap:28px;margin:28px 0}
  .card{border:1px solid var(--line);border-radius:12px;padding:22px;background:var(--ink2)}
  .card h2{font-size:22px;margin-bottom:6px}
  .card .meta{color:var(--dim);font-size:14px;margin-bottom:10px}
</style>
```

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter @thinkersjournal/web test home-feed-page page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/feed.astro apps/web/test/home-feed-page.test.ts
git commit -m "feat(theming): retrofit feed page"
```

---

## Task 13: Retrofit the authors page (`authors.astro`) — PageLayout band

**Files:** Modify `apps/web/src/pages/authors.astro`; extend `apps/web/test/authors-page.test.ts`.

**Interfaces:** consumes `PageLayout` (adds `setPublicPageCsp` via the head slot? No — the page keeps its own `setPublicPageCsp(Astro)` call). Keep `markFeedCacheable(Astro)`, `setPublicPageCsp(Astro)`, the anonymous `/public/authors` fetch (no `request`), the `data-follow-btn`/`data-user-id` rows, the `?cursor=` link, and the social-island `<script>import { initSocialIsland } from "../scripts/social"`. Wrap in `<PageLayout eyebrow="Discover" heading="Recent authors">`, theme the list.

- [ ] **Step 1: Extend the test** — add to `authors-page.test.ts` (authors.astro block):

```ts
it("adopts the PageLayout band while keeping cache + CSP + island", () => {
  expect(code).toMatch(/<PageLayout\s/);
  expect(code).toContain("markFeedCacheable(");
  expect(code).toContain("setPublicPageCsp(");
  expect(code).toMatch(/initSocialIsland/);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Retrofit** — keep the frontmatter (fetch + `markFeedCacheable(Astro)` + `setPublicPageCsp(Astro)`), wrap the body:

```astro
<PageLayout
  title="Recent authors — Thinker's Journal"
  eyebrow="Discover"
  heading="Recent authors"
  intro="Builders who've published recently. Follow a few to fill your feed."
>
  {page.authors.length === 0 ? (
    <p>No authors yet — be the first to <a class="link" href="/new-post">publish</a>.</p>
  ) : (
    <ul class="authors">
      {page.authors.map((author) => (
        <li class="author">
          <a class="name" href={`/@${author.username}`}>{author.displayName ?? `@${author.username}`}</a>
          <span class="handle">@{author.username}</span>
          <button class="btn btn-ghost follow" data-follow-btn data-user-id={author.userId} hidden>Follow</button>
        </li>
      ))}
    </ul>
  )}
  {page.nextCursor !== null && (
    <a class="link" rel="next" href={`/authors?cursor=${encodeURIComponent(page.nextCursor)}`}>More →</a>
  )}
  <script>
    import { initSocialIsland } from "../scripts/social";
    initSocialIsland();
  </script>
</PageLayout>
<style>
  .authors{list-style:none;display:flex;flex-direction:column;gap:14px;margin:0 0 28px}
  .author{display:flex;align-items:center;gap:14px;border:1px solid var(--line);
    border-radius:10px;padding:14px 18px;background:var(--ink2)}
  .author .name{font-family:var(--serif);color:var(--head)}
  .author .handle{color:var(--dim);font-size:14px}
  .author .follow{margin-left:auto;font-size:13.5px;padding:8px 16px}
</style>
```

> Note: `setPublicPageCsp` is called in the page frontmatter (not the layout). The `<script>` with the `import` externalizes (satisfies `script-src 'self'`). The `.wrap` comes from PageLayout's `.wrap.body`, so the content is already width-constrained.

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter @thinkersjournal/web test authors-page social-island page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/authors.astro apps/web/test/authors-page.test.ts
git commit -m "feat(theming): retrofit authors page (PageLayout band)"
```

---

## Task 14: Retrofit the profile page (`[handle]/index.astro`)

**Files:** Modify `apps/web/src/pages/[handle]/index.astro`; the existing `profile-page.test.ts` / `social-island.test.ts` / `social-lists.test.ts` / `feed-pages.test.ts` must stay green.

**Interfaces:** consumes `BaseLayout`.

⚠️ **The high-risk retrofit.** Keep: `markPublicCacheable(Astro, [\`author:${profile.userId}\`])`, `setPublicPageCsp(Astro)`, the anonymous `/public/profile` fetch, `markdownExcerpt`, `profileUrl`, the social-island `<script>import { initSocialIsland } from "../../scripts/social"`, and ALL `data-*` island markup. Move `<title>`/canonical to `BaseLayout` props; move the **RSS `<link>`** (kept literally in source), the conditional `robots` meta, and the **profile OG tags** into `<Fragment slot="head">`. **Never** introduce `Astro.request`, `request:`, or `set:html`.

- [ ] **Step 1: Confirm the guards** — no new failing test needed; the retrofit must keep `profile-page.test.ts`, `social-island.test.ts`, `social-lists.test.ts`, `feed-pages.test.ts` green. (Optionally add: `expect(code).toMatch(/<BaseLayout\s/)`.)

- [ ] **Step 2: Baseline** — run `pnpm --filter @thinkersjournal/web test profile-page social-island social-lists feed-pages` and note the current green counts.

- [ ] **Step 3: Retrofit** — frontmatter unchanged except `import BaseLayout from '../../components/BaseLayout.astro';` (keep `markPublicCacheable`, `setPublicPageCsp`, the fetch, `profileUrl`, `markdownExcerpt`, `FEED_TITLE`, `canonical`, `displayName`, `description`, `nextHref`, `displayDate`). Replace the `<html>…</html>` with:

```astro
<BaseLayout title={displayName} description={description} canonical={canonical}>
  <Fragment slot="head">
    <link rel="alternate" type="application/rss+xml" title={FEED_TITLE} href="/rss.xml" />
    {cursor !== null && <meta name="robots" content="noindex, follow" />}
    <meta property="og:type" content="profile" />
    <meta property="og:title" content={displayName} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
  </Fragment>

  <div class="wrap profile">
    <h1>{displayName}</h1>
    {profile.bio && <p class="bio">{profile.bio}</p>}

    <section class="social" data-social-counts data-username={profile.username}>
      <span><strong data-followers-count>—</strong> followers</span>
      <span><strong data-following-count>—</strong> following</span>
    </section>
    <button class="btn btn-primary follow" data-follow-btn data-user-id={profile.userId} hidden>Follow</button>
    <div class="lists">
      <button class="btn btn-ghost" data-load-list="followers" data-username={profile.username}>Followers</button>
      <ul data-list-panel="followers"></ul>
      <button class="btn btn-ghost" data-load-list="following" data-username={profile.username}>Following</button>
      <ul data-list-panel="following"></ul>
    </div>

    {profile.posts.length === 0 ? (
      <p id="no-posts">No posts yet.</p>
    ) : (
      <ul class="posts">
        {profile.posts.map((post) => (
          <li class="post">
            <h2><a href={`/@${encodeURIComponent(profile.username)}/${encodeURIComponent(post.slug)}`}>{post.title}</a></h2>
            <p>{markdownExcerpt(post.excerptSource)}</p>
            <time datetime={post.publishedAt}>{displayDate(post.publishedAt)}</time>
          </li>
        ))}
      </ul>
    )}
    {nextHref !== null && <a id="next-page" class="link" rel="next" href={nextHref}>Older posts →</a>}
  </div>

  <script>
    import { initSocialIsland } from "../../scripts/social";
    initSocialIsland();
  </script>
</BaseLayout>
<style>
  .profile{padding:clamp(40px,7vw,80px) 0}
  .bio{color:var(--muted);margin:12px 0}
  .social{display:flex;gap:22px;color:var(--muted);margin:18px 0}
  .lists{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
  .posts{list-style:none;display:flex;flex-direction:column;gap:24px;margin-top:28px}
</style>
```

> Preserve the EXACT `data-*` attribute names and the empty `—` placeholders (the M2.1 island + its tests depend on them). The `<Fragment slot="head">` keeps the RSS `<link>` and OG in this file's source (satisfying `feed-pages.test.ts:108-118`). No `set:html`, no `request:`.

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter @thinkersjournal/web test profile-page social-island social-lists feed-pages page-cache-inventory && pnpm --filter @thinkersjournal/web run typecheck` → PASS (matching the Step-2 counts). Fix any assertion that pinned the old `<head>` structure by moving it, not deleting it.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/pages/[handle]/index.astro" apps/web/test/profile-page.test.ts
git commit -m "feat(theming): retrofit profile page (head slot, island preserved)"
```

---

## Task 15: Retrofit the post page (`[handle]/[slug].astro`)

**Files:** Modify `apps/web/src/pages/[handle]/[slug].astro`; `post-page.test.ts` + `feed-pages.test.ts` must stay green.

**Interfaces:** consumes `BaseLayout`.

⚠️ **The other high-risk retrofit.** Keep: `markPublicCacheable(Astro, [\`post:${post.id}\`, \`author:${post.authorId}\`])`, `setPublicPageCsp(Astro)`, the anonymous `/public/posts` fetch, `renderMarkdown`, `markdownExcerpt`, `postUrl`/`profileUrl`, `jsonLdScript`, the `#post-body` `set:html={html}` render, and the `is:inline` JSON-LD `<script>`. Move `<title>`/canonical to props; move the RSS `<link>`, article OG, and the `is:inline` JSON-LD into `<Fragment slot="head">` (all kept literally in source). **Never** introduce `Astro.request`/`request:`.

- [ ] **Step 1: Baseline** — run `pnpm --filter @thinkersjournal/web test post-page feed-pages` and note green counts.

- [ ] **Step 2: Retrofit** — add `import BaseLayout from '../../components/BaseLayout.astro';` (keep all other imports + logic). Replace `<html>…</html>` with:

```astro
<BaseLayout title={post.title} description={description} canonical={canonical}>
  <Fragment slot="head">
    <link rel="alternate" type="application/rss+xml" title={FEED_TITLE} href="/rss.xml" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content={post.title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    <meta property="article:published_time" content={post.publishedAt} />
    <meta property="article:modified_time" content={post.updatedAt} />
    <meta property="article:author" content={post.displayName ?? post.username} />
    <meta name="twitter:card" content="summary_large_image" />
    <script is:inline type="application/ld+json" set:html={jsonLdScript(jsonLd)} />
  </Fragment>

  <article class="wrap post">
    <h1>{post.title}</h1>
    <p class="meta">
      <a class="link" href={`/@${encodeURIComponent(post.username)}`}>{post.displayName ?? post.username}</a>
      · <time datetime={post.publishedAt}>{publishedDisplay}</time>
    </p>
    <div id="post-body" set:html={html} />
  </article>
</BaseLayout>
<style>
  .post{padding:clamp(40px,7vw,80px) 0;max-width:min(var(--wrap),760px)}
  .post .meta{color:var(--dim);margin:8px 0 28px}
  #post-body{line-height:1.7}
  #post-body :global(h2),#post-body :global(h3){margin:1.6em 0 .5em}
  #post-body :global(p){margin:0 0 1em}
  #post-body :global(pre){background:var(--ink2);border:1px solid var(--line);
    border-radius:10px;padding:16px;overflow-x:auto;margin:1.2em 0}
  #post-body :global(a){color:var(--green)}
</style>
```

> The `<script is:inline type="application/ld+json"` stays in THIS file's source (satisfies `post-page.test.ts:157`). `#post-body`'s `set:html={html}` is the ONLY unescaped-HTML sink (safe — `html` is post-sanitize from `packages/markdown`). Shiki token styles inside `#post-body` are inline `style=` on `<span>`s — allowed by the existing `style-src 'unsafe-inline'`; the `:global()` rules here only add layout, not token colors. No `request:`.

- [ ] **Step 3: Run tests + build (Shiki + CSP survive) + typecheck** — `pnpm --filter @thinkersjournal/web test post-page feed-pages page-cache-inventory && pnpm --filter @thinkersjournal/web build && pnpm --filter @thinkersjournal/web run typecheck` → PASS (matching Step-1 counts).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/pages/[handle]/[slug].astro" apps/web/test/post-page.test.ts
git commit -m "feat(theming): retrofit post page (head slot, ld+json + set:html preserved)"
```

---

## Task 16: E2E — themed shell + nav auth smoke

**Files:** Create `e2e/theming.spec.ts`.

**Interfaces:** consumes `signUpAndVerify`, `chooseUsername`, `uniqueHandle` (`e2e/helpers.ts`).

Verify the shell renders and the nav auth slot hydrates correctly across auth states — the one thing source/structure tests cannot prove.

- [ ] **Step 1: Write the spec**

Create `e2e/theming.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { chooseUsername, signUpAndVerify, uniqueHandle } from "./helpers";

test("themed shell renders with nav + footer on a public page", async ({ page }) => {
  await page.goto("/authors");
  await expect(page.locator("header.nav")).toBeVisible();
  await expect(page.locator("footer.ft")).toBeVisible();
  // wordmark links back to the apex marketing site
  await expect(page.locator('header.nav a[href="https://thinkersjournal.com/"]')).toBeVisible();
});

test("nav auth slot: logged-out shows Sign in/up; logged-in shows @handle + Sign out that clears the session", async ({ page }) => {
  // Logged out
  await page.goto("/authors");
  await expect(page.locator('[data-auth-slot] a[href="/login"]')).toBeVisible();
  await expect(page.locator('[data-auth-slot] a[href="/signup"]')).toBeVisible();

  // Sign up + onboard
  await signUpAndVerify(page, page.request);
  const handle = uniqueHandle("themer");
  await chooseUsername(page, handle);

  // Logged in — the island upgrades the slot
  await page.goto("/authors");
  const slot = page.locator("[data-auth-slot]");
  await expect(slot.getByText(`@${handle}`)).toBeVisible();
  const signOut = slot.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();

  // Sign out clears the session → back to Sign in
  await signOut.click();
  await page.waitForURL(/\/$/);
  await page.goto("/authors");
  await expect(page.locator('[data-auth-slot] a[href="/login"]')).toBeVisible();
});
```

- [ ] **Step 2: Run the full E2E suite** — `pnpm test:e2e`. Expected: all specs pass (the new `theming.spec.ts` + every existing spec still green — the retrofits must not regress publish/social/onboarding flows). If an existing spec now fails because a selector changed under theming (e.g. a form field wrapped), reconcile the selector without weakening the assertion.

- [ ] **Step 3: Commit**

```bash
git add e2e/theming.spec.ts
git commit -m "test(theming): e2e themed shell + nav auth smoke"
```

---

## Milestone-end verification & whole-branch review (controller task)

After Task 16, the controller independently verifies green and runs the whole-branch adversarial review.

- [ ] **Green sweep:** `pnpm typecheck` · `pnpm --filter @thinkersjournal/shared test` · `pnpm --filter @thinkersjournal/markdown test` · `pnpm --filter @thinkersjournal/markdown run check:workerd` · `pnpm --filter @thinkersjournal/api test` · **`pnpm --filter @thinkersjournal/web build`** then `pnpm --filter @thinkersjournal/web test` (build-gated route/asset survival active) · `pnpm test:e2e`. All green, including `page-cache-inventory`, `csp` (unchanged), and the profile/post/feed guards.
- [ ] **Whole-branch adversarial review** (priority lenses): **cache leak** (does any cached page carry per-viewer state in SSR? the nav auth slot must be client-only + its SSR default anonymous); **CSP** (no inline `<script>` on any page; `'unsafe-inline'` still style-src-only; the media-upload + nav-auth + social islands all externalized); **cache-invariant** (each page still exactly one cache helper; components call none; the home markPrivate→markPublicCacheable flip leaks nothing); **head integrity** (RSS `<link>` + `is:inline` ld+json still in the post/profile source; canonical not host-derived; no duplicate OG/title); **a11y** (`:focus-visible`, `prefers-reduced-motion`, the mobile disclosure); **visual consistency** (tokens/chrome match the parent). Address findings, re-verify, then `superpowers:finishing-a-development-branch`.

---

## Self-Review (author's checklist — completed against the spec)

**1. Spec coverage:** §2.1 foundation → Task 1; §2.2 chrome → Tasks 2–6; §2.3 nav auth → Tasks 7–8; §2.4 CSP → already present (Global Constraints) + applied per-page in Tasks 9–15; §2.5 retrofit all pages → Tasks 9–15; §9 testing → each task + Task 16 + the milestone sweep. Every spec section maps to a task.

**2. Placeholder scan:** no "TBD/similar-to/add error handling." Retrofit tasks give the exact new template + the precise frontmatter changes; "keep existing logic verbatim" refers to concrete, named existing code (POST handlers, `applyCookies`, manual redirects), not gaps.

**3. Type/name consistency:** `initNavAuth`/`initMediaUpload`/`initSocialIsland` used consistently; `Me` DTO fields (`username`, `usernameChosen`) match `@thinkersjournal/shared`; `data-auth-slot`/`data-social-counts`/`data-follow-btn` attribute names consistent between components/islands/tests; `PageLayout` props (`title,eyebrow,heading,intro`) consistent between Task 6 and its callers (Tasks 9, 13).

**Documented corrections to the spec (from the current-code map, all preserving spec intent):** (a) the CSP already contains `style-src 'self' 'unsafe-inline'` + `font-src 'self'`, so no `csp.ts`/`csp.test.ts` change — the work is *applying* the CSP to authed pages; (b) applying CSP to `new-post` requires bundling its inline island first (Task 11); (c) page-specific OG/RSS/JSON-LD stay in each page's `<Fragment slot="head">` (not centralized in `BaseHead`) to keep the literal-string guards green; (d) the Wordmark inline-style refactor is cleanliness, not a CSP fix (still done, Task 2).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-21-web-theming-design-system.md`.**

**1. Subagent-Driven (recommended)** — fresh subagent per task + two-stage review (the flow used for M2.1 and the host fix). Given the retrofit touches the load-bearing cache/CSP invariants, per-task review is the safeguard.

**2. Inline Execution** — via `superpowers:executing-plans`.

The controller will drive option 1, with the milestone-end whole-branch review run as an ultracode Workflow (multi-dimensional adversarial pass).




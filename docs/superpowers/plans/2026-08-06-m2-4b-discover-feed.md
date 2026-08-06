# M2.4b Discover Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the community front page (`/`) the public, anonymous, edge-cacheable **Discover feed** — the newest published posts site-wide, keyset-paginated.

**Architecture:** A new FRESH keyset API route `GET /public/discover` (recent-posts query + `id < cursor` keyset), consumed anonymously by a rewritten `index.astro` that subscribes to the reserved `listing` purge tag via `markPublicCacheable(["listing"])`. Reuses the existing purge hop (publish/edit already purge `listing`), the `RecentPost` DTO, the `feed.astro` card shape, and the `authors.astro` page shell. No new cache infra.

**Tech Stack:** TypeScript 6.0.3, Postgres 18 (uuidv7, time-ordered ids), Cloudflare Workers (api + web joined by a Service Binding), Astro `output:server`, pnpm monorepo, Vitest + `cloudflare:test`, Playwright.

## Global Constraints

- The `listing` cache-tag string on the page MUST byte-match the api purge call sites (`apps/api/src/routes/posts.ts:252,336`). A typo is invisible (miniflare doesn't simulate Workers Cache) and silently breaks purge.
- `GET /public/discover` MUST read `HYPERDRIVE_FRESH`, never `HYPERDRIVE_CACHED` (a cached read behind a purge-tagged edge entry reopens a ~25h stale-read window). `handlePublicRecent` stays the sole `HYPERDRIVE_CACHED` route (`hyperdrive-binding-inventory.node.test.ts`).
- Anonymous pages call `apiFetch` **without** `request:` (omitting the Cookie is what keeps the render viewer-independent and leak-safe).
- Exactly ONE cache helper per web page (`page-cache-inventory.test.ts`); nothing under `src/` except `lib/cache.ts` may call `cache.set(` or set cache headers by hand.
- Keyset, not offset: `WHERE id < $cursor ORDER BY id DESC LIMIT PAGE_SIZE+1`; the +1 row is a sentinel; `nextCursor` = last kept row's id, or `null` when no sentinel came back.
- Never `set:html`; excerpts render as escaped text via `markdownExcerpt`. Every interpolated URL segment is `encodeURIComponent`-wrapped.
- `PAGE_SIZE = 20`, `EXCERPT_SOURCE_CHARS = 400` (reuse the existing constants in `apps/api/src/routes/public.ts`).
- Commit messages end with the two trailers:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_012sdN4Y44W3bVtUb6qqtsGm`.
- Local dev/e2e: no new migration (0009 from M2.4a is the only pending Neon migration). The dev DB is already migrated through 0009.

## File Structure

- `packages/shared/src/posts.ts` — **modify**: add the `DiscoverPage` DTO (auto-exported by the existing `export * from './posts'` barrel).
- `apps/api/src/routes/public.ts` — **modify**: add `handlePublicDiscover` beside `handlePublicRecent`.
- `apps/api/src/routes.ts` — **modify**: register `GET /public/discover`.
- `apps/api/test/discover.test.ts` — **create**: API handler tests.
- `apps/api/test/error-envelope.test.ts` — **modify**: add a `CASES` probe for the new route (its route-coverage gate fails closed otherwise).
- `apps/web/src/pages/index.astro` — **modify (rewrite)**: marketing landing → Discover feed.
- `apps/web/test/home-page.test.ts` — **modify (rewrite)**: assert the Discover feed, not the old marketing content.
- `apps/web/src/components/Nav.astro` — **modify**: add the "Discover" → `/` browse link.
- `apps/web/test/nav.test.ts` — **modify**: assert the new Discover link.
- `apps/web/src/pages/feed.astro` — **modify**: empty-state secondary "browse Discover →" → `/` link.
- `apps/web/test/home-feed-page.test.ts` — **modify**: assert the empty-state Discover link.
- `e2e/discover.spec.ts` — **create**: the cross-stack spine.

---

### Task 1: API `GET /public/discover` (+ `DiscoverPage` DTO)

**Files:**
- Modify: `packages/shared/src/posts.ts` (add `DiscoverPage` after `RecentPost`, ~line 89)
- Modify: `apps/api/src/routes/public.ts` (add `handlePublicDiscover` after `handlePublicRecent`; add `DiscoverPage` to the type import)
- Modify: `apps/api/src/routes.ts` (import + register the route)
- Modify: `apps/api/test/error-envelope.test.ts` (add a `CASES` probe)
- Test: `apps/api/test/discover.test.ts` (create)

**Interfaces:**
- Consumes: `MAX_CURSOR`, `RecentPost` (`@thinkersjournal/shared`); `withClient`, `isInvalidTextRepresentation`, `errorResponse`, the module-local `json()` and `PAGE_SIZE`/`EXCERPT_SOURCE_CHARS` in `public.ts`.
- Produces: `handlePublicDiscover(request, env, ctx): Promise<Response>` returning `200 { posts: RecentPost[], nextCursor: string | null }`; the `DiscoverPage` type.

- [ ] **Step 1: Write the failing API test**

`apps/api/test/discover.test.ts` (pool project; anonymous — no cookie; seed via SQL):

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";

const created: string[] = [];
afterAll(async () => {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`DELETE FROM users WHERE id = ANY($1)`, [created]));
  await waitOnExecutionContext(ctx);
});

async function fetchWorker(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

async function seedAuthor(): Promise<string> {
  const ctx = createExecutionContext();
  let id = "";
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`disc-${crypto.randomUUID()}@t.test`]);
    id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, username_chosen)
       VALUES ($1,$2,'Disc Author', true)`,
      [id, `disc_${crypto.randomUUID().slice(0, 8)}`]);
  });
  await waitOnExecutionContext(ctx);
  return id;
}

async function insertPost(
  authorId: string, title: string, status: "published" | "draft",
): Promise<string> {
  const ctx = createExecutionContext();
  let postId = "";
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body',$4, CASE WHEN $4 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, title, `disc-${crypto.randomUUID()}`, status]);
    postId = rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return postId;
}

const U = "https://api.test";

describe("GET /public/discover", () => {
  it("returns published posts newest-first and excludes drafts", async () => {
    const author = await seedAuthor();
    const pubId = await insertPost(author, "Discover Published One", "published");
    const draftId = await insertPost(author, "Discover Draft One", "draft");
    const r = await fetchWorker(`${U}/public/discover`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { posts: { id: string }[]; nextCursor: string | null };
    const ids = body.posts.map((p) => p.id);
    expect(ids).toContain(pubId);        // the just-published post is on page 1 (newest)
    expect(ids).not.toContain(draftId);  // drafts never surface
    // newest-first: the page the api returned is sorted by id DESC (v7 = time order).
    const desc = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(ids).toEqual(desc);
  });

  it("keyset-paginates: a full page yields a nextCursor onto a non-overlapping older page", async () => {
    const author = await seedAuthor();
    for (let i = 0; i < 21; i++) await insertPost(author, `Discover Paging ${i}`, "published");
    const p1 = (await (await fetchWorker(`${U}/public/discover`)).json()) as {
      posts: { id: string }[]; nextCursor: string | null;
    };
    expect(p1.posts.length).toBe(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await (await fetchWorker(
      `${U}/public/discover?cursor=${encodeURIComponent(p1.nextCursor!)}`,
    )).json()) as { posts: { id: string }[]; nextCursor: string | null };
    const ids1 = new Set(p1.posts.map((p) => p.id));
    for (const p of p2.posts) {
      expect(ids1.has(p.id)).toBe(false);        // no overlap between pages
      expect(p.id < p1.nextCursor!).toBe(true);  // strictly older than the cursor
    }
  });

  it("400s a malformed cursor rather than 500ing", async () => {
    expect((await fetchWorker(`${U}/public/discover?cursor=not-a-uuid`)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @thinkersjournal/api test -- discover.test`
Expected: FAIL — route unregistered (404), so `r.status` is 404 not 200.

- [ ] **Step 3: Add the `DiscoverPage` DTO**

In `packages/shared/src/posts.ts`, after the `RecentPost` interface (end of file):

```ts
/** What `GET /public/discover` returns — the site-wide Discover feed, one keyset page. */
export interface DiscoverPage {
  posts: RecentPost[];
  /** The last id on this page, or null when there are no more. */
  nextCursor: string | null;
}
```

(No barrel edit: `packages/shared/src/index.ts` already re-exports `./posts` — `public.ts` imports `RecentPost` from `@thinkersjournal/shared` today, which proves it.)

- [ ] **Step 4: Add the handler**

In `apps/api/src/routes/public.ts`, add `DiscoverPage` to the type import block (alongside `RecentPost`), then add this handler immediately after `handlePublicRecent`:

```ts
export async function handlePublicDiscover(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // First page uses the all-f sentinel so ONE query serves page 1 and page N.
  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;
  try {
    // ⚠️ HYPERDRIVE_FRESH, never CACHED: this route backs a PURGE-TAGGED edge entry
    // (the `/` Discover page subscribes to `listing`), so the first render after a
    // publish/edit is a read-after-write. A cached read there could re-cache a
    // pre-edit row for up to 25h. See this file's header, bullet 4.
    const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.title, p.slug, pr.username,
                left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt"
           FROM posts p
           JOIN profiles pr ON pr.user_id = p.author_id
          WHERE p.status = 'published' AND p.id < $1
          ORDER BY p.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [cursor],
      );
      const list = rows as RecentPost[];
      const hasMore = list.length > PAGE_SIZE;
      const posts = list.slice(0, PAGE_SIZE);
      return {
        posts,
        nextCursor: hasMore ? posts[posts.length - 1]!.id : null,
      } satisfies DiscoverPage;
    });
    return json(page);
  } catch (err) {
    // `id < 'not-a-uuid'` throws 22P02 — the client's error, not a 500.
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}
```

- [ ] **Step 5: Register the route**

In `apps/api/src/routes.ts`, add `handlePublicDiscover` to the existing `import { … } from "./routes/public"`, then add this entry beside `/public/recent` (the anonymous public-reads block):

```ts
  { method: "GET", pattern: "/public/discover", handler: handlePublicDiscover },
```

- [ ] **Step 6: Add the error-envelope coverage probe**

`apps/api/test/error-envelope.test.ts` enumerates every route in `src/routes.ts` and fails closed unless each has a `CASES` probe or an `ERROR_FREE` reason. `/public/discover` has a real 400 (malformed cursor), so add a `CASES` entry near the other `/public/*` probes:

```ts
  // GET /public/discover (M2.4b) — a malformed cursor is its reachable 400, same
  // shape as /public/profile's malformed-cursor case. See src/routes/public.ts.
  {
    name: "400 public discover with a malformed cursor",
    route: "GET /public/discover",
    build: () => new Request("https://api.test/public/discover?cursor=not-a-uuid"),
  },
```

- [ ] **Step 7: Run, verify pass**

Run: `pnpm --filter @thinkersjournal/api test -- discover.test error-envelope route-protection hyperdrive-binding-inventory`
Expected: PASS (discover 3/3; error-envelope now accounts for the route; route-protection passes — it's a session-free public GET; hyperdrive-binding-inventory still passes — discover is FRESH, so `/public/recent` remains the sole CACHED route). Then the full api suite: `pnpm --filter @thinkersjournal/api test` — green.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/posts.ts apps/api/src/routes/public.ts apps/api/src/routes.ts apps/api/test/discover.test.ts apps/api/test/error-envelope.test.ts
git commit -m "feat(m2.4b): GET /public/discover (FRESH keyset recent-posts feed)" -m "" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_012sdN4Y44W3bVtUb6qqtsGm"
```

---

### Task 2: Home page `/` = the Discover feed

**Files:**
- Modify (rewrite): `apps/web/src/pages/index.astro`
- Test (rewrite): `apps/web/test/home-page.test.ts`

**Interfaces:**
- Consumes: `handlePublicDiscover` via `apiFetch<DiscoverPage>("/public/discover"…)`; `DiscoverPage` (`@thinkersjournal/shared`); `markPublicCacheable`, `setPublicPageCsp`, `markdownExcerpt`, `PageLayout`.
- Produces: the `/` route rendering the Discover feed, edge-cached under `["listing"]`.

- [ ] **Step 1: Rewrite the failing source test**

Replace the body of `apps/web/test/home-page.test.ts` (keep the `src()` reader that strips comments from `../src/pages/index.astro`):

```ts
describe("home page (the Discover feed)", () => {
  it("is anonymous + edge-cacheable via the reserved `listing` tag (one cache helper)", () => {
    const s = src();
    expect(s).toMatch(/markPublicCacheable\(Astro,\s*\[\s*["']listing["']/);
    expect(s).not.toContain("markPrivate(");
    expect(s).not.toContain("markFeedCacheable(");
  });
  it("sets the public CSP and uses the shared page chrome", () => {
    const s = src();
    expect(s).toContain("setPublicPageCsp(Astro)");
    expect(s).toMatch(/<PageLayout\s/);
  });
  it("reads the site-wide Discover feed ANONYMOUSLY (apiFetch without request)", () => {
    const s = src();
    expect(s).toContain("/public/discover");
    expect(s).toContain("apiFetch");
    expect(s).not.toMatch(/apiFetch<[^>]*>\([^)]*request:/); // no cookie forwarded
  });
  it("renders escaped excerpts (markdownExcerpt, never set:html) and a keyset pager", () => {
    const s = src();
    expect(s).toContain("markdownExcerpt");
    expect(s).not.toContain("set:html");
    expect(s).toMatch(/\/\?cursor=/);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @thinkersjournal/web test -- home-page`
Expected: FAIL — the current `index.astro` has no `"listing"` tag, no `apiFetch`, no `/public/discover`, no `markdownExcerpt`, no `/?cursor=`.

- [ ] **Step 3: Rewrite `index.astro`**

Replace the entire file `apps/web/src/pages/index.astro`:

```astro
---
/**
 * `/` — the community front page IS the public Discover feed (M2.4b): the newest
 * published posts site-wide, keyset-paginated via `?cursor=`.
 *
 * ⚠️ ANONYMOUS BY CONSTRUCTION. The `/public/discover` fetch omits `request`, so
 * src/lib/api.ts never forwards the browser Cookie — the render is
 * viewer-independent and safe to edge-cache. The nav's auth state hydrates
 * client-side. Do NOT add `request: Astro.request` to "personalize" this page.
 *
 * ⚠️ EDGE-CACHED under the `listing` tag. Every publish/edit already purges
 * `listing` (apps/api/src/routes/posts.ts), so a new/edited post evicts this feed
 * at once. This is the subscriber the tag was reserved for.
 *
 * ⚠️ KEYSET, NOT OFFSET. `?cursor=<last-seen-id>` with `ORDER BY id DESC` (v7 ids
 * are time-ordered). The cursor is forwarded OPAQUELY via URLSearchParams; a
 * malformed one 400s at the api and this page treats any non-200 as an empty feed.
 * Cursor pages canonical to `/` and are `noindex` (pagination, not distinct pages).
 *
 * The marketing hero + signup CTA live on ThinkersJournal.com (the apex landing);
 * this page is the entry INTO the community. Signup stays reachable via the nav.
 */
import { markdownExcerpt } from "@thinkersjournal/markdown";

import PageLayout from "../components/PageLayout.astro";
import { apiFetch } from "../lib/api";
import { markPublicCacheable } from "../lib/cache";
import { setPublicPageCsp } from "../lib/csp";

import type { DiscoverPage } from "@thinkersjournal/shared";

const cursor = Astro.url.searchParams.get("cursor");
const query = new URLSearchParams();
if (cursor !== null) query.set("cursor", cursor);

// ⚠️ ANONYMOUS — no `request`. See the header.
const response = await apiFetch<DiscoverPage>(
  query.toString() === "" ? "/public/discover" : `/public/discover?${query.toString()}`,
);
const page: DiscoverPage =
  response.status === 200 && response.data !== null
    ? response.data
    : { posts: [], nextCursor: null };

// ⚠️ THIS `"listing"` LITERAL MUST MATCH apps/api/src/routes/posts.ts's purge call
// sites EXACTLY — a typo is invisible (miniflare doesn't simulate Workers Cache)
// and its only symptom is a feed that never reflects a new post for up to 25h.
markPublicCacheable(Astro, ["listing"]);
setPublicPageCsp(Astro);

// Defensive date formatting (same rationale as [handle]/index.astro): a malformed
// timestamp would make `.toISOString()` THROW and 500 this cached page.
const displayDate = (value: string): string => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
};
---
<PageLayout
  title="Discover — Thinker's Journal Community"
  eyebrow="Community"
  heading="Discover"
  intro="The latest from the community."
  canonical="https://community.thinkersjournal.com/"
>
  <Fragment slot="head">
    {/* Cursor pages are pagination, not distinct content — keep them out of the
        index while still letting a crawler follow through to the posts. */}
    {cursor !== null && <meta name="robots" content="noindex, follow" />}
  </Fragment>

  {page.posts.length === 0 ? (
    <p>No posts yet — be the first to <a class="link" href="/new-post">publish</a>.</p>
  ) : (
    <ul class="cards">
      {page.posts.map((post) => (
        <li class="card">
          {/* encodeURIComponent on both segments (URL needs percent-encoding;
              Astro `{}` only HTML-escapes). markdownExcerpt returns TEXT — Astro
              escapes it into the element; never set:html (untrusted source). */}
          <h2><a href={`/@${encodeURIComponent(post.username)}/${encodeURIComponent(post.slug)}`}>{post.title}</a></h2>
          <p class="meta">by <a class="link" href={`/@${encodeURIComponent(post.username)}`}>@{post.username}</a> · <time datetime={post.publishedAt}>{displayDate(post.publishedAt)}</time></p>
          <p>{markdownExcerpt(post.excerptSource)}</p>
        </li>
      ))}
    </ul>
  )}
  {page.nextCursor !== null && (
    <a class="link" rel="next" href={`/?cursor=${encodeURIComponent(page.nextCursor)}`}>Older posts →</a>
  )}
</PageLayout>
<style>
  .cards{list-style:none;display:flex;flex-direction:column;gap:28px;margin:0 0 28px}
  .card{border:1px solid var(--line);border-radius:12px;padding:22px;background:var(--ink2)}
  .card h2{font-size:22px;margin-bottom:6px}
  .card .meta{color:var(--dim);font-size:14px;margin-bottom:10px}
</style>
```

- [ ] **Step 4: Run, verify pass + the cache inventory sweep**

Run: `pnpm --filter @thinkersjournal/web test -- home-page page-cache-inventory`
Expected: PASS (home-page 4/4; the cache sweep still sees exactly one helper on `/`). Then build so the route registers and run the full web suite: `pnpm --filter @thinkersjournal/web build` then `pnpm --filter @thinkersjournal/web test`.
Expected: green. (No other web test asserts the old marketing home — `theming.spec` uses `/authors`, and `feed.astro`'s tests are unaffected here.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/test/home-page.test.ts
git commit -m "feat(m2.4b): community home / is the Discover feed" -m "" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_012sdN4Y44W3bVtUb6qqtsGm"
```

---

### Task 3: Nav "Discover" link + feed empty-state cross-link

**Files:**
- Modify: `apps/web/src/components/Nav.astro` (add the Discover link)
- Modify: `apps/web/test/nav.test.ts` (assert it)
- Modify: `apps/web/src/pages/feed.astro` (empty-state secondary link)
- Modify: `apps/web/test/home-feed-page.test.ts` (assert it)

**Interfaces:**
- Consumes: nothing new — a static `<a href="/">Discover</a>` and a static `<a href="/">` in the feed empty state.
- Produces: the "Discover" nav entry pointing at the community home feed.

- [ ] **Step 1: Add the failing nav assertion**

In `apps/web/test/nav.test.ts`, add to the `describe("Nav", …)` block:

```ts
  it("has a static Discover browse link to / (the community feed home)", () => {
    const s = src();
    expect(s).toMatch(/<a\s+href="\/"\s*>Discover<\/a>/);
    // still no data fetching — the nav stays viewer-independent
    expect(s).not.toContain("apiFetch");
    expect(s).not.toMatch(/Astro\.request/);
  });
```

- [ ] **Step 2: Add the failing feed empty-state assertion**

In `apps/web/test/home-feed-page.test.ts`, add inside `describe("feed.astro", …)`:

```ts
  it("also offers the public Discover feed from its empty state", () => {
    expect(code).toContain('href="/"');
    expect(code).toContain("browse Discover");
  });
```

- [ ] **Step 3: Run, verify both fail**

Run: `pnpm --filter @thinkersjournal/web test -- nav home-feed-page`
Expected: FAIL — no `<a href="/">Discover</a>` in the nav yet, no `href="/"`/"browse Discover" in `feed.astro`.

- [ ] **Step 4: Add the Discover link to the nav**

In `apps/web/src/components/Nav.astro`, inside `<nav class="links" …>`, add the Discover link as the FIRST browse link, before `<a href="/feed">Feed</a>`:

```astro
      <a href="/">Discover</a>
      <a href="/feed">Feed</a>
      <a href="/authors">Authors</a>
```

(Only the first line is new; the `/feed` and `/authors` lines already exist — keep them in this order.)

- [ ] **Step 5: Add the feed empty-state cross-link**

In `apps/web/src/pages/feed.astro`, change the empty-state paragraph (currently:
`<p>Your feed is empty. <a class="link" href="/authors">Discover authors to follow →</a></p>`) to add the secondary Discover link:

```astro
    {feed.posts.length === 0 ? (
      <p>Your feed is empty. <a class="link" href="/authors">Discover authors to follow →</a> or <a class="link" href="/">browse Discover →</a></p>
    ) : (
```

(The existing "Discover authors → /authors" link stays — the e2e `social.spec` scopes to `main a` with text "Discover authors", which still matches uniquely because the new link's text is "browse Discover".)

- [ ] **Step 6: Run, verify pass**

Run: `pnpm --filter @thinkersjournal/web test -- nav home-feed-page`
Expected: PASS. Then the full web suite: `pnpm --filter @thinkersjournal/web test` — green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Nav.astro apps/web/test/nav.test.ts apps/web/src/pages/feed.astro apps/web/test/home-feed-page.test.ts
git commit -m "feat(m2.4b): nav Discover link + feed empty-state cross-link" -m "" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_012sdN4Y44W3bVtUb6qqtsGm"
```

---

### Task 4: e2e Discover spine

**Files:**
- Create: `e2e/discover.spec.ts`

**Interfaces:**
- Consumes: `signUpAndVerify`, `publishPost`, `uniqueHandle` from `e2e/helpers.ts`.

> **Note on scope.** Keyset paging correctness (full-page → `nextCursor` → non-overlapping older page) is covered deterministically by the Task 1 API test, and the pager markup by the Task 2 web static test. The e2e verifies the cross-stack SPINE — a real publish reaching the real cached `/` — without depending on there being >20 accumulated posts (which would be flaky in isolation). Assertions are scoped to `main` to avoid the nav-auth-slot handle-collision class of bug seen in M2.4a.

- [ ] **Step 1: Write the e2e**

`e2e/discover.spec.ts` — a single spine test. (Do NOT call `publishPost` twice in one context: it onboards its own handle each call, and handles are immutable, so a second call hangs on the `/choose-username` redirect — the exact M2.4a Task 6 failure. One post through the real stack is the load-bearing assertion; multi-post ordering and keyset paging are covered deterministically by the Task 1 API test.)

```ts
import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("a published post appears on the community Discover home feed", async ({ page, request }) => {
  await signUpAndVerify(page, request);
  // A distinctive, unlikely-to-collide title so the assertion is unambiguous in
  // the shared, accumulating test DB.
  const title = `Discoverable Fieldnote ${uniqueHandle("d")}`;
  await publishPost(page, { title, markdownSource: "a discoverable body about widgets" });

  await page.goto("/");
  // Scoped to <main> (not the nav/footer chrome): the post's card heading is
  // present on the Discover feed.
  await expect(page.locator("main").getByRole("heading", { name: title })).toBeVisible();
});
```

- [ ] **Step 2: Run**

The dev DB is already migrated (0009 from M2.4a; no new migration). Run the discover e2e (per the repo e2e command, e.g. `pnpm test:e2e discover.spec`). Documented harness noise ("postmark send failed", "cache.purge is not a function") is unchanged and expected. Expected: the test passes. If the post does NOT appear on `/`, that is a real cross-stack defect (purge/cache/route) — STOP and investigate, do not loosen the assertion.

- [ ] **Step 3: Commit**

```bash
git add e2e/discover.spec.ts
git commit -m "test(m2.4b): e2e discover spine (publish -> appears on / feed)" -m "" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_012sdN4Y44W3bVtUb6qqtsGm"
```

---

## Final steps (after all tasks)

- [ ] Full suites green: `pnpm --filter @thinkersjournal/shared test`, `pnpm --filter @thinkersjournal/api test`, `pnpm --filter @thinkersjournal/web test`, and the e2e.
- [ ] Whole-branch adversarial review (Ultracode). Point it at any Minor findings logged during the tasks.
- [ ] `superpowers:finishing-a-development-branch` → push `m2-4b-discover`, CI-gated PR. Founder merges. **Deploy note in the PR:** no new migration (0009 from M2.4a is the only pending Neon item); no new secrets/bindings/cron.

## Self-Review

**Spec coverage:** §Surface (`/` = feed, no `/discover`, nav Discover + Feed, empty-feed cross-link) → Tasks 2+3. §API (new FRESH keyset `/public/discover`, `RecentPost`, `DiscoverPage`) → Task 1. §Cache/purge (`markPublicCacheable(["listing"])`, publish already purges) → Task 2. §Cards/pagination (feed card via `markdownExcerpt`, keyset "Older →") → Task 2. §Testing (api/web/e2e) → Tasks 1/2/3/4. §SEO (cursor→canonical `/`, noindex) → Task 2. §Out-of-scope (trending, personalization, marketing hero) → untouched by design.

**Placeholder scan:** no TBD/TODO. Every code step carries real code. The one conditional note (Task 4's `publishPost`-twice caveat) is a concrete verify-the-contract instruction with a named fallback, not a placeholder.

**Type consistency:** `DiscoverPage = { posts: RecentPost[]; nextCursor: string|null }` defined in Task 1, consumed identically in Task 2 (`apiFetch<DiscoverPage>`). `handlePublicDiscover` name matches the `routes.ts` registration and the import. `RecentPost` fields (`id,title,slug,excerptSource,publishedAt,updatedAt,username`) match the SQL aliases and the card usage (`username`, `slug`, `title`, `publishedAt`, `excerptSource`). `MAX_CURSOR`/`PAGE_SIZE`/`EXCERPT_SOURCE_CHARS` reused from their existing definitions.

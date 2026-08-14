/**
 * THE PUBLISHING SPINE — the integration capstone. A real browser drives
 * signup -> verify -> PUBLISH -> the public `/@user/slug` page RENDERING the
 * post -> EDIT -> the public page reflecting the edit, through the `web` Worker,
 * which reaches `api` only over the Service Binding, against real Postgres and
 * real workerd.
 *
 * ⚠️ WHAT THIS PROVES THAT NO OTHER SUITE CAN. T14 could not drive publish (only
 * drafts existed); T17 built publish but its temporary publish E2E was deleted
 * before commit. So until now NOTHING permanently drove publish all the way to
 * the public post page rendering the published body. This closes that gap. Every
 * unit suite stubs one side of the two-Worker hop; this stubs none.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHAT IS AND IS NOT OBSERVABLE LOCALLY — READ BEFORE STRENGTHENING A TEST.
 * ─────────────────────────────────────────────────────────────────────────────
 * `wrangler dev` / miniflare does NOT simulate Workers Cache. This is confirmed
 * (playwright.config.ts's header; apps/web/test/workers-cache.test.ts). Two GETs
 * of the same public URL are two independent Worker invocations with no cache in
 * between, so:
 *   • The edit-reflection assertion below observes the DB-BACKED content change
 *     (the page re-reads the row every render) — that IS real and IS what the
 *     "the public page reflects the edit" requirement asks for.
 *   • The CACHE-PURGE INVALIDATION itself — api writing the edit and then asking
 *     `web` over the WEB Service Binding to drop `post:<id>` — is NOT observable
 *     here, BY CONSTRUCTION: there is no cache to invalidate. A HIT-then-purge
 *     proof is DEPLOY-GATE-ONLY (`Cf-Cache-Status`: MISS -> HIT -> edit -> MISS),
 *     added to Task 20. This file does NOT claim to test it, and must not.
 * What IS pinned locally is the CACHE-HEADER CONTRACT our code emits regardless
 * of whether a cache sits in front (the last two tests) — the real local guard.
 */
import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify } from "./helpers";

test("publish -> the public page renders -> edit -> the page reflects it", async ({
  page,
  browser,
}) => {
  await signUpAndVerify(page, page.request);

  // ---- Publish -------------------------------------------------------------
  // `publishPost` writes through the real editor and PUBLISHES, returning the
  // author's minted username, the derived slug, the post id, and the public URL.
  const { username, slug, postId, url } = await publishPost(page, {
    title: "My First Post",
    markdownSource: "# Heading\n\nOriginal body.\n\n```typescript\nconst x = 1;\n```",
  });

  // The editor redirected the browser to the public page, and the api derived
  // "my-first-post" from the title (apps/api/src/routes/posts.ts's `slugify`).
  expect(slug).toBe("my-first-post");
  await expect(page).toHaveURL(new RegExp(`/@${username}/my-first-post$`));

  // The published body rendered — the payoff no other suite reaches.
  await expect(page.locator("#post-body h1")).toHaveText("Heading");
  await expect(page.locator("#post-body")).toContainText("Original body.");

  // Shiki ran, and it ran AFTER the sanitizer: rehype-sanitize's defaultSchema
  // carries no `style` in its attribute allowlist, so a coloured token span
  // existing AT ALL proves the highlight step runs on the trusted side of the
  // sanitizer (packages/markdown/src/render.ts).
  await expect(page.locator("#post-body pre span[style]").first()).toBeVisible();

  // OG + JSON-LD are present and correct (the unfurl/SEO surface).
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "My First Post",
  );
  const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
  expect(JSON.parse(jsonLd ?? "{}")).toMatchObject({
    "@type": "BlogPosting",
    headline: "My First Post",
  });

  // ---- Edit ----------------------------------------------------------------
  // Re-open the editor for THIS post (the id is why `publishPost` bothered to
  // save a draft first — see its header) and replace the body. Title is left
  // as loaded, so the slug is unchanged and the redirect lands on the same URL.
  await page.goto(`/new-post?post=${encodeURIComponent(postId)}`);
  await page.fill("#markdownSource", "# Heading\n\nEdited body.");
  await page.click("button[value='publish']");
  await expect(page).toHaveURL(new RegExp(`/@${username}/my-first-post$`));

  // ---- The edit is reflected on the public page ----------------------------
  // ⚠️ Read as a FRESH ANONYMOUS reader — a brand-new browser context with an
  // empty HTTP cache and no session cookie. This is how the edit-reflection
  // requirement is verified without a stale render muddying it two ways at once:
  //   1. a fresh context cannot serve a browser-cached copy of the first render;
  //   2. an anonymous reader is exactly who a published post is FOR, and the
  //      render they get is the DB row as it stands now.
  // (miniflare has no Workers Cache, so this re-renders unconditionally; the
  // purge hop's cache invalidation is deploy-gate-only — see the file header.)
  const reader = await browser.newContext();
  try {
    const readerPage = await reader.newPage();
    await readerPage.goto(url);
    await expect(readerPage.locator("#post-body")).toContainText("Edited body.");
    await expect(readerPage.locator("#post-body")).not.toContainText("Original body.");
  } finally {
    await reader.close();
  }
});

test("the profile page lists the published post", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  const { username } = await publishPost(page, {
    title: "Listed Post",
    markdownSource: "body",
  });

  await page.goto(`/@${username}`);
  await expect(page.locator("a", { hasText: "Listed Post" })).toBeVisible();
});

test("a DRAFT is not publicly reachable", async ({ page }) => {
  await signUpAndVerify(page, page.request);

  // Publish one post — the ONLY way this fresh user's randomly-suffixed username
  // becomes knowable to the browser (see helpers.ts's `publishPost` header).
  const { username } = await publishPost(page, {
    title: "Public Post",
    markdownSource: "visible text",
  });

  // Now author a DRAFT that must stay invisible to the public.
  await page.goto("/new-post");
  await page.fill("#title", "Secret Draft");
  await page.fill("#markdownSource", "unpublished text");
  await page.click("button[value='draft']");
  await expect(page.locator("#saved")).toBeVisible();

  // The draft's public URL is a 404 — a draft is indistinguishable from a
  // nonexistent post, even to its own author (apps/api/src/routes/public.ts's
  // `status = 'published'` is IN the query). Authed or not, the public page
  // forwards no cookie, so the api answers the same 404 either way.
  const draftResponse = await page.request.get(`/@${username}/secret-draft`);
  expect(draftResponse.status()).toBe(404);

  // The profile lists the PUBLISHED post but not the draft.
  await page.goto(`/@${username}`);
  await expect(page.locator("a", { hasText: "Public Post" })).toBeVisible();
  await expect(page.locator("a", { hasText: "Secret Draft" })).toHaveCount(0);
});

test("⚠️ an AUTHED render of a public page is NEVER cacheable", async ({ page }) => {
  // ⚠️ THE HIGHEST-SEVERITY REGRESSION IN M1. Cookie is NOT in the Workers Cache
  // key and does NOT trigger a bypass: if a logged-in render were ever marked
  // cacheable, it would be cached and served to every visitor — a mass session
  // leak. This is the only place the real browser, the real cookie, and the real
  // response headers meet. (apps/web/src/lib/cache.ts.)
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, {
    title: "Cache Probe",
    markdownSource: "body",
  });

  // Logged IN — `page.request` shares the browser context's cookie jar, so the
  // GET carries tj_session. markPublicCacheable sees a session-bearing request
  // and REFUSES: `cache-control: private, no-store`, no cache-tag.
  const authed = await page.request.get(url);
  // ⚠️ `cache-control` here is CORRECT AS-IS: `refuse()` (src/lib/cache.ts) sets
  // this standard header BY HAND on the private path, independent of the Astro
  // cache provider's own CDN-targeted header. It is the one `cache-control`
  // assertion in this file that is not a naming subtlety.
  expect(authed.headers()["cache-control"]).toBe("private, no-store");
  expect(authed.headers()["cache-tag"]).toBeUndefined();

  // Logged OUT — a cleared cookie jar. Now the render is anonymous and cacheable.
  await page.context().clearCookies();
  const anon = await page.request.get(url);
  // ⚠️ `cloudflare-cdn-cache-control`, NOT `cache-control` — the @astrojs/cloudflare
  // provider writes the CDN-specific header (pinned against the INSTALLED adapter
  // in apps/web/test/workers-cache.test.ts); `cache-control` is null on this path.
  expect(anon.headers()["cloudflare-cdn-cache-control"]).toBe(
    "public, max-age=3600, stale-while-revalidate=86400",
  );
  // ⚠️ NEVER s-maxage — it SILENTLY disables stale-while-revalidate (RFC 9111).
  expect(anon.headers()["cloudflare-cdn-cache-control"]).not.toContain("s-maxage");
  // ⚠️ LOCAL-DEV-ONLY PROOF. wrangler dev has no real Cloudflare edge to
  // consume/strip `Cache-Tag`, so this legitimately observes what OUR code emits
  // — but it does NOT hold against a deployed page (Cloudflare strips the header
  // before any client sees it). The post page depends on post:/author:/pipeline:
  // (plus Astro core's own `astro-path:`) and DELIBERATELY NOT the platform-wide
  // `listing` tag — removed in the M1 final review, because a single post's page
  // must not be evicted every time a DIFFERENT author publishes (see
  // apps/web/src/pages/[handle]/[slug].astro + apps/web/test/post-page.test.ts).
  // This is the LIVE, on-the-wire tripwire against `listing` coming back here.
  const anonTag = anon.headers()["cache-tag"];
  expect(anonTag).toContain("post:");
  expect(anonTag).toContain("author:");
  expect(anonTag).toContain("pipeline:");
  expect(anonTag).not.toContain("listing");
  expect(anon.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(anon.headers()["content-security-policy"]).not.toContain(
    "script-src 'self' 'unsafe-inline'",
  );
});

test("author deletes their post from the post page → it 404s", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, { title: "Delete Me", markdownSource: "body" });

  await page.goto(url);

  // ⚠️ THE ISLAND REVEALS ASYNCHRONOUSLY. `[data-post-delete]` ships
  // `hidden` in the SSR markup (this render is anonymous/cached — see the
  // page's own header) and post-delete.ts only unhides it, and only builds
  // the start/confirm buttons, after its own `/api/me` fetch resolves and
  // confirms this viewer IS the post's author. A bare `.click()` would race
  // that fetch; waiting for `[data-delete-start]` to be visible is the same
  // hydration wait `toggleFollowTo` (helpers.ts) needs for the follow
  // island, for the identical reason.
  const startBtn = page.locator("[data-post-delete] [data-delete-start]");
  await expect(startBtn).toBeVisible();
  await startBtn.click();

  await page.locator("[data-post-delete] [data-delete-confirm]").click();

  // The island's fetch succeeds and redirects to the author's own profile —
  // NOT the post URL, so this also proves the delete actually landed rather
  // than merely being requested.
  await page.waitForURL(/\/@[^/]+$/);

  // Re-fetching the post's own URL now 404s: the api hard-deletes the row
  // (apps/api/src/routes/posts.ts's DELETE handler), so `GET /public/posts`
  // for it comes back empty exactly like a post that never existed
  // (see [handle]/[slug].astro's "a draft and a nonexistent post are the
  // same answer" branch), and this uncached-404 GET reaches that live.
  const resp = await page.goto(url);
  expect(resp?.status()).toBe(404);
});

test("sitemap.xml is untagged and short-TTL", async ({ page }) => {
  const response = await page.request.get("/sitemap.xml");
  // ⚠️ `cloudflare-cdn-cache-control`, not `cache-control` — see above.
  expect(response.headers()["cloudflare-cdn-cache-control"]).toBe(
    "public, max-age=60, stale-while-revalidate=600",
  );
  // ⚠️ NOT `toBeUndefined()`. "Untagged" means OUR PURGE FLOW NEVER TARGETS THIS
  // ENTRY, not that the `cache-tag` header is absent: Astro core unconditionally
  // appends `astro-path:<path>` to EVERY cacheable response (measured on the wire
  // — see src/pages/sitemap.xml.ts's header). So the correct, meaningful contract
  // is that the header carries ONLY that Astro-internal tag and NONE of the tags
  // apps/api/src/cache/purge.ts ever purges by.
  const cacheTag = response.headers()["cache-tag"];
  expect(cacheTag).toContain("astro-path:");
  expect(cacheTag).not.toContain("listing");
  expect(cacheTag).not.toContain("author:");
});

# Content Deletion + Media Reclamation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author hard-delete their own post, and add a daily reclaimer that frees media (DB rows + R2 objects) referenced by no post.

**Architecture:** `DELETE /posts/:id` follows the existing mutation discipline (owner-auth in the SQL `WHERE`, cascade, `purgeTags`), never touching R2. A cron reclaimer derives the referenced-image set by scanning all `posts.markdown_source`, deletes unreferenced media past a 24h grace, then dedup-safe-deletes the R2 objects (an object goes only when no `media` row still holds its key). Deletion is offered on the post page (owner-only client island) and in the editor.

**Tech Stack:** Cloudflare Workers (api + Astro web), Postgres 18 via Hyperdrive, R2 (`env.MEDIA`), vitest (`cloudflare:test`), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-13-content-deletion-media-reclamation-design.md`

## Global Constraints

- **Hard delete** — `DELETE FROM posts`; no soft-delete/tombstone. Comments/reactions/notifications/tag-joins cascade (all `ON DELETE CASCADE` on `posts(id)`).
- **Owner-auth in the WHERE clause:** `DELETE FROM posts WHERE id = $1 AND author_id = $me` — zero rows → **404** (indistinguishable no-such/not-yours). Malformed id (22P02) → 404.
- **Read tag slugs BEFORE the delete** (the cascade removes `post_tags`); purge `["post:"+id, "author:"+authorId, "listing", ...tagSlugs.map(s=>"tag:"+s)]`, awaited, only on a hit, below the 404 (purge-quota ordering).
- **Verified-email gated** via `runMutatingPipeline(..., { requireVerifiedEmail: true })`.
- **Reclaimer:** referenced set from `regexp_matches(markdown_source, 'media/post/([0-9a-f]{64})\.webp', 'g')`; delete media unreferenced **and** `created_at < now() - interval '24 hours'`, bounded `LIMIT` (`REAP_BATCH = 500`); **dedup-safe** R2 delete (object deleted only when no `media` row keeps its `r2_key`); cron `"15 4 * * *"`; all DB via `HYPERDRIVE_FRESH`.
- **No client dialogs** (no `confirm()`); inline two-step confirm; the post page stays `script-src 'self'`.
- **No migration** — no schema change.
- **Branch:** `content-deletion-media-reclamation` (off main).

---

## File Structure

**api (`apps/api/src/`)**
- `routes/posts.ts` — add `handleDeletePost` (MODIFY).
- `routes.ts` — register `DELETE /posts/:id` + the `/__test/reap-orphan-media` wrapper (MODIFY).
- `media/reap-orphan-media.ts` — `reapOrphanMedia` (CREATE).
- `index.ts` — dispatcher branch for `"15 4 * * *"` (MODIFY).
- `routes/__test.ts` — `POST /__test/reap-orphan-media` hook (MODIFY).
- `wrangler.jsonc` — add the `"15 4 * * *"` cron (MODIFY).

**web (`apps/web/src/`)**
- `pages/api/post-delete.ts` — same-origin delete proxy (CREATE).
- `scripts/post-delete.ts` — post-page owner delete island (CREATE).
- `pages/[handle]/[slug].astro` — hidden owner delete control + mount the island (MODIFY).
- `pages/new-post.astro` — editor delete button + server-side delete handler (MODIFY).

**tests**
- `apps/api/test/posts-delete.test.ts` (CREATE).
- `apps/api/test/reap-orphan-media.test.ts` (CREATE).
- `apps/web/test/*` — source-text tests for the proxy/island/editor (matching the repo's Astro-page test style).
- `e2e/publish.spec.ts` or a delete spec (MODIFY).

---

## Task 1: `DELETE /posts/:id` — api handler + route

**Files:**
- Modify: `apps/api/src/routes/posts.ts`
- Modify: `apps/api/src/routes.ts`
- Test: `apps/api/test/posts-delete.test.ts`

**Interfaces:**
- Consumes: `runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true })` → returns `Response | { session: { userId } }`; `readTagSlugs(client, postId): Promise<string[]>`; `usernameFor(client, authorId): Promise<string>`; `notFound(): Response`; `isInvalidTextRepresentation(err)`; `purgeTags(env, tags)`; `withClient(env.HYPERDRIVE_FRESH, ctx, fn)` — all already in `posts.ts`.
- Produces: `handleDeletePost(request, env, ctx, params: { id: string }): Promise<Response>` — `200 { username }` on success.

- [ ] **Step 1: Write the failing tests** in `apps/api/test/posts-delete.test.ts`. Follow `posts.test.ts` for the harness (a verified author, a published post with a tag + a comment + a reaction; a `purgeTags` spy per `purge-wiring.test.ts`). Cases:
```ts
it("owner deletes their post → 200, post then 404s, comment+reaction gone (cascade)", async () => {
  const { postId } = await publishPostWithCommentAndReaction(/* helpers */);
  const res = await del(`/posts/${postId}`, ownerHeaders);
  expect(res.status).toBe(200);
  expect((await res.json()).username).toBe(ownerHandle);
  // gone:
  expect((await getPostRow(postId))).toBeUndefined();
  expect((await countComments(postId))).toBe(0);   // ON DELETE CASCADE
  expect((await countReactions(postId))).toBe(0);
});
it("purges post:/author:/listing/tag: on delete", async () => {
  // assert the purge spy saw the four tag families (same idiom as purge-wiring.test.ts)
});
it("a non-owner delete → 404 and purges nothing", async () => {
  const res = await del(`/posts/${postId}`, otherUserHeaders);
  expect(res.status).toBe(404);
  expect(purgeSpy).not.toHaveBeenCalled();
});
it("delete by an UNVERIFIED user → 403", async () => { /* EMAIL_NOT_VERIFIED */ });
it("malformed id → 404 (not 500)", async () => {
  const res = await del(`/posts/not-a-uuid`, ownerHeaders);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run — expect FAIL** (no handler/route). `pnpm --filter api test posts-delete`.

- [ ] **Step 3: Implement `handleDeletePost`** in `posts.ts`:
```ts
export async function handleDeletePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: { id: string },
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const authorId = result.session.userId;

  let deleted: { username: string; tagSlugs: string[] } | null;
  try {
    deleted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // ⚠️ Read tags BEFORE the delete — the DELETE cascades post_tags away, so
      // reading them afterward (as the edit path does) would return nothing.
      // Tags are public, so a wasted read on a not-owner/nonexistent id leaks
      // nothing; it is one cheap SELECT, discarded on the 404 below.
      const tagSlugs = await readTagSlugs(c, params.id);
      const { rows } = await c.query<{ slug: string }>(
        `DELETE FROM posts WHERE id = $1 AND author_id = $2 RETURNING slug`,
        [params.id, authorId],
      );
      if (rows[0] === undefined) return null; // no such post, or not this author's
      return { username: await usernameFor(c, authorId), tagSlugs };
    });
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return notFound(); // WHERE id='not-a-uuid' throws 22P02
    throw err;
  }
  if (deleted === null) return notFound();

  // Mirror the edit handler's purge. Awaited, never throws, below the 404.
  await purgeTags(env, [
    `post:${params.id}`,
    `author:${authorId}`,
    "listing",
    ...deleted.tagSlugs.map((s) => `tag:${s}`),
  ]);

  return new Response(JSON.stringify({ username: deleted.username }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 4: Register the route** in `routes.ts` (import `handleDeletePost`, add near the other `/posts` routes):
```ts
{ method: "DELETE", pattern: "/posts/:id", handler: handleDeletePost },
```

- [ ] **Step 5: Run — expect PASS** (new cases + full api suite green). `pnpm --filter api test`.

- [ ] **Step 6: Commit** — `git commit -m "feat(api): DELETE /posts/:id (owner hard-delete + cascade + purge)"`

---

## Task 2: Post-page delete — proxy + owner island

**Files:**
- Create: `apps/web/src/pages/api/post-delete.ts`
- Create: `apps/web/src/scripts/post-delete.ts`
- Modify: `apps/web/src/pages/[handle]/[slug].astro`
- Test: `apps/web/test/post-delete.test.ts` (source-text, matching the repo's island/page test style)

**Interfaces:**
- Consumes: Task 1's `DELETE /posts/:id`; `apiFetch`/`applyCookies` (`../../lib/api`); `markPrivate` (`../../lib/cache`); the post page's existing `data-post-id` + `data-post-author-id`; `/api/me` → `{ userId, csrfToken }`.
- Produces: `POST /api/post-delete` proxy; `initPostDelete()` island.

- [ ] **Step 1: Write the failing tests** (`post-delete.test.ts`): the proxy forwards a DELETE to `/posts/<id>` with cookie+Origin+CSRF and is `markPrivate`; the island reads `data-post-author-id`, fetches `/api/me`, reveals the control only when `me.userId` matches, uses an inline confirm (no `confirm(`), and redirects to `/@<handle>` on success. Assertions are source-text against the two new files (mirror `notify-bell.test.ts` / `nav.test.ts` style), e.g.:
```ts
const proxy = read("apps/web/src/pages/api/post-delete.ts");
expect(proxy).toMatch(/method:\s*"DELETE"/);
expect(proxy).toContain("/posts/");
expect(proxy).toContain("markPrivate");
const island = read("apps/web/src/scripts/post-delete.ts");
expect(island).toContain("/api/me");
expect(island).toMatch(/data-post-author-id|dataset\.postAuthorId/);
expect(island).not.toContain("confirm(");         // no browser dialog
expect(island).toContain("/api/post-delete");
expect(island).toMatch(/location\.href|location\.assign/);
```

- [ ] **Step 2: Run — expect FAIL** (files absent).

- [ ] **Step 3: Implement the proxy** `apps/web/src/pages/api/post-delete.ts` — clone `apps/web/src/pages/api/comment-delete.ts` exactly, changing only the api path and the id field:
```ts
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";
import type { APIRoute } from "astro";
export const prerender = false;
export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });
  let body: unknown;
  try { body = await context.request.json(); }
  catch { return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers }); }
  const { postId } = body as { postId?: unknown };
  if (typeof postId !== "string") {
    return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
  }
  const response = await apiFetch<{ username?: string }>("/posts/" + encodeURIComponent(postId), {
    method: "DELETE",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};
```

- [ ] **Step 4: Implement the island** `apps/web/src/scripts/post-delete.ts` (follow `comments.ts` for the `/api/me` fetch + `data-*` reads):
```ts
interface Me { userId: string | null; csrfToken: string | null; }
async function me(): Promise<Me> {
  try { const r = await fetch("/api/me"); if (!r.ok) return { userId: null, csrfToken: null };
        const m = await r.json() as { userId: string | null; csrfToken: string | null };
        return { userId: m.userId, csrfToken: m.csrfToken }; }
  catch { return { userId: null, csrfToken: null }; }
}
export function initPostDelete(): void {
  const root = document.querySelector<HTMLElement>("[data-post-delete]");
  if (root === null) return;
  const postId = root.dataset.postId ?? "";
  const authorId = root.dataset.postAuthorId ?? "";
  const handle = root.dataset.handle ?? "";
  void me().then((m) => {
    if (m.userId === null || m.userId !== authorId || m.csrfToken === null) return;
    root.hidden = false;                       // reveal for the owner only
    // build: [Delete] → [Really delete? Confirm | Cancel] inline, via
    // createElement/textContent only (no innerHTML). Confirm handler:
    //   fetch("/api/post-delete", { method:"POST", headers:{ "content-type":"application/json",
    //     "X-CSRF-Token": m.csrfToken }, body: JSON.stringify({ postId }) })
    //   → if res.ok: location.href = "/@" + handle;  else show an inline error.
  });
}
```
Add the delete control markup to `[handle]/[slug].astro` — a hidden `<div data-post-delete data-post-id={post.id} data-post-author-id={post.authorId} data-handle={handle} hidden>` near the post header, and mount `initPostDelete()` in the page's client `<script>` (alongside the comment island mount). Use the same `[hidden]` handling the nav bell fix established (ensure `hidden` actually hides — no author `display` override on the control).

- [ ] **Step 5: Run — expect PASS**; `pnpm --filter web typecheck`.

- [ ] **Step 6: Commit** — `git commit -m "feat(web): delete a post from the post page (owner island + proxy)"`

---

## Task 3: Editor delete button

**Files:**
- Modify: `apps/web/src/pages/new-post.astro`
- Test: `apps/web/test/new-post-delete.test.ts` (source-text)

**Interfaces:**
- Consumes: Task 1's `DELETE /posts/:id`; `apiFetch`/`applyCookies`; the editor's existing `?post=<id>` edit mode + its known post id.

- [ ] **Step 1: Write the failing test**: in edit mode (`?post=<id>`), the page renders a Delete control (inline confirm, no `confirm(`), and a server-side POST branch forwards `DELETE /posts/:id` via `apiFetch` and redirects to `/@<handle>`:
```ts
const s = read("apps/web/src/pages/new-post.astro");
expect(s).toMatch(/Delete/);
expect(s).toMatch(/method:\s*"DELETE"/);
expect(s).not.toContain("confirm(");
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** In `new-post.astro`'s edit mode, add a Delete `<form method="POST">` with a hidden intent field (e.g. `intent=delete`) and an inline two-step confirm (a details/summary or a two-button reveal — no JS dialog). In the page's server frontmatter, when `POST` carries `intent=delete` and a `post` id, call `apiFetch("/posts/" + id, { method: "DELETE", request: Astro.request, origin: Astro.request.headers.get("Origin") ?? "", csrfToken: <the page's CSRF token> })`; on `200`, `return Astro.redirect("/@" + username)`; surface non-200 as an inline error. (Follow how the editor already forwards its save/publish to the api.)

- [ ] **Step 4: Run — expect PASS**; `pnpm --filter web typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): delete a post from the editor"`

---

## Task 4: Media reclaimer

**Files:**
- Create: `apps/api/src/media/reap-orphan-media.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/routes/__test.ts`, `apps/api/src/routes.ts`, `apps/api/wrangler.jsonc`
- Test: `apps/api/test/reap-orphan-media.test.ts`

**Interfaces:**
- Consumes: `withClient(env.HYPERDRIVE_FRESH, ctx, fn)`; `env.MEDIA` (R2 bucket; `.delete(key)`); the reaper's `/__test/reap-unverified` pattern (handle-at-signup Task 8) to mirror.
- Produces: `reapOrphanMedia(env, ctx): Promise<{ rows: number; objects: number }>`; cron `"15 4 * * *"`; `POST /__test/reap-orphan-media` → `{ rows, objects }`.

- [ ] **Step 1: Write the failing test** `apps/api/test/reap-orphan-media.test.ts`. Use the real `cloudflare:test` `env` (R2 `env.MEDIA` is bound, `r2Buckets: ["MEDIA"]`), `createExecutionContext`/`waitOnExecutionContext`, and `withClient`. Seed rows with explicit `created_at`/`r2_key`/`sha256` and put/get R2 objects; clean up in `afterEach`. Cases:
```ts
// helper: seed a media row (owner, sha256, ageHours) + put its R2 object
async function seedMedia(c, { sha256, ageHours }) {
  const key = `media/post/${sha256}.webp`;
  await env.MEDIA.put(key, new Uint8Array([1,2,3]));
  const { rows } = await c.query(
    `INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height, created_at)
     VALUES ($1,$2,$3,3,1,1, now() - ($4 || ' hours')::interval) RETURNING id`,
    [ownerId, key, sha256, String(ageHours)]);
  return { id: rows[0].id, key };
}

it("reaps an unreferenced media row >24h old and deletes its R2 object", async () => {
  const { id, key } = await seedMedia(c, { sha256: A /* 64 hex */, ageHours: 25 });
  const out = await reapOrphanMedia(env, ctx);
  expect(out.rows).toBeGreaterThanOrEqual(1);
  expect(await mediaExists(id)).toBe(false);
  expect(await env.MEDIA.get(key)).toBeNull();
});
it("keeps a media row whose sha256 appears in a post's markdown", async () => {
  const { id, key } = await seedMedia(c, { sha256: B, ageHours: 25 });
  await insertPost(c, { markdown: `body ![](https://cdn.thinkersjournal.com/${key})` });
  await reapOrphanMedia(env, ctx);
  expect(await mediaExists(id)).toBe(true);
  expect(await env.MEDIA.get(key)).not.toBeNull();
});
it("keeps an unreferenced upload younger than 24h (grace)", async () => {
  const { id, key } = await seedMedia(c, { sha256: C, ageHours: 1 });
  await reapOrphanMedia(env, ctx);
  expect(await mediaExists(id)).toBe(true);
  expect(await env.MEDIA.get(key)).not.toBeNull();
});
it("DEDUP-SAFE: an object is kept while any media row still holds its key", async () => {
  // Two rows share one key/sha256 (content-addressed): one >24h (reaped), one
  // <24h (grace-kept). The reaped row's object must survive because the sibling
  // still references the key. (NOTE: two rows sharing a key share a sha256, so
  // they share referenced-status — the correct dedup scenario is the GRACE
  // sibling, not "one referenced one not", which is impossible.)
  const old = await seedMedia(c, { sha256: D, ageHours: 25 }); // reaped
  const young = await seedMedia(c, { sha256: D, ageHours: 1 }); // same key, grace
  await reapOrphanMedia(env, ctx);
  expect(await mediaExists(old.id)).toBe(false);
  expect(await mediaExists(young.id)).toBe(true);
  expect(await env.MEDIA.get(old.key)).not.toBeNull(); // object kept — young still holds it
});
```

- [ ] **Step 2: Run — expect FAIL** (module absent).

- [ ] **Step 3: Implement `reap-orphan-media.ts`:**
```ts
import { withClient } from "../db/client";

const REAP_BATCH = 500;

/**
 * Free media referenced by no post. "Referenced" = the sha256 appears in some
 * post's markdown (published OR draft) — conservative (a mention keeps it). The
 * grace window means an in-progress compose is never raced. R2 objects are
 * content-addressed and shareable, so an object is deleted ONLY when no media
 * row still holds its key (dedup-safe).
 */
export async function reapOrphanMedia(env: Env, ctx: ExecutionContext): Promise<{ rows: number; objects: number }> {
  const orphanKeys = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ r2_key: string }>(
      `WITH referenced AS (
         SELECT DISTINCT (regexp_matches(markdown_source, 'media/post/([0-9a-f]{64})\\.webp', 'g'))[1] AS sha256
           FROM posts
       ),
       orphans AS (
         SELECT m.id FROM media m
          WHERE m.created_at < now() - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM referenced r WHERE r.sha256 = m.sha256)
          ORDER BY m.created_at
          LIMIT $1
       )
       DELETE FROM media WHERE id IN (SELECT id FROM orphans) RETURNING r2_key`,
      [REAP_BATCH],
    );
    return rows.map((r) => r.r2_key);
  });

  const distinctKeys = [...new Set(orphanKeys)];
  let objects = 0;
  if (distinctKeys.length > 0) {
    const stillHeld = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ r2_key: string }>(
        `SELECT DISTINCT r2_key FROM media WHERE r2_key = ANY($1::text[])`, [distinctKeys]);
      return new Set(rows.map((r) => r.r2_key));
    });
    for (const key of distinctKeys) {
      if (stillHeld.has(key)) continue;         // a surviving row still references the object
      try { await env.MEDIA.delete(key); objects++; }
      catch (err) { console.error("reap-orphan-media: R2 delete failed for", key, err); }
    }
  }
  if (orphanKeys.length > 0) console.log(`reap-orphan-media: ${orphanKeys.length} row(s), ${objects} object(s)`);
  return { rows: orphanKeys.length, objects };
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire cron + dispatcher.** `wrangler.jsonc`: `"crons": ["*/2 * * * *", "0 14 * * *", "30 3 * * *", "15 4 * * *"]`. `index.ts` `scheduled` — add a branch after the reaper branch:
```ts
if (controller.cron === "15 4 * * *") {
  ctx.waitUntil(reapOrphanMedia(env, ctx));
  return;
}
```
(Import `reapOrphanMedia`.)

- [ ] **Step 6: Test hook.** Add `POST /__test/reap-orphan-media` mirroring `/__test/reap-unverified` EXACTLY (handle-at-signup Task 8): the handler inside `handleTestRoute` (after the `TEST_ROUTES !== "1"` gate + `checkOrigin`), returning `{ rows, objects }`; and the `routes.ts` wrapper entry + `PIPELINE_EXEMPT` membership so the route-inventory suites stay green.
```ts
// in __test.ts, after the reap-unverified hook:
if (request.method === "POST" && pathname === "/__test/reap-orphan-media") {
  const result = await reapOrphanMedia(env, ctx);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 7: Run the full api suite + a dispatcher check** that `controller.cron === "15 4 * * *"` routes to the reclaimer (mirror the reaper's dispatcher test / `EXPECTED_DISPATCHER_BODY` snapshot if present). Expect PASS.

- [ ] **Step 8: Commit** — `git commit -m "feat(api): daily orphan-media reclaimer (reference scan + dedup-safe R2 delete)"`

---

## Task 5: e2e — publish-with-image → delete → 404

**Files:**
- Modify: `e2e/publish.spec.ts` (or a new `e2e/delete.spec.ts`) + `e2e/helpers.ts` if a delete helper helps
- Test: the e2e suite itself

**Interfaces:** Consumes the shipped `signUpAndVerify` (returns `{ email, username }`), `publishPost`, and the new post-page delete control (Task 2).

- [ ] **Step 1: Write the e2e test:**
```ts
test("author deletes their post from the post page → it 404s", async ({ page, request }) => {
  await signUpAndVerify(page, request);
  const { url } = await publishPost(page, { title: "Delete Me", markdownSource: "body" });
  await page.goto(url);
  // the owner delete control reveals via the island; click + inline confirm:
  await page.locator("[data-post-delete] [data-delete-start]").click();
  await page.locator("[data-post-delete] [data-delete-confirm]").click();
  // redirected to the author profile; the post URL now 404s:
  const resp = await page.goto(url);
  expect(resp?.status()).toBe(404);
});
```
(Use whatever stable selectors the Task-2 markup exposes — name them in Task 2, e.g. `data-delete-start` / `data-delete-confirm`.)

- [ ] **Step 2: Run the e2e suite** if the harness comes up (two Workers + Postgres); otherwise `tsc -p tsconfig.e2e.json` + inspection and defer full execution to CI (as handle-at-signup Task 9 did). Note which.

- [ ] **Step 3: Commit** — `git commit -m "test(e2e): delete a post from the post page → 404"`

---

## Final (controller): whole-branch adversarial review

Run the whole-branch review over `main...content-deletion-media-reclamation`. Focus: the delete handler's owner-auth + cascade + purge-on-hit-only + 404-purges-nothing ordering; the reclaimer's reference-scan correctness (conservative keep), the 24h grace, and the dedup-safe object deletion (object kept while any row holds the key); the `/__test/reap-orphan-media` hook is prod-unreachable (TEST_ROUTES + checkOrigin) exactly like the reaper; and the post-page island reveals the delete control ONLY to the owner. Then finish via `finishing-a-development-branch` (push + PR; CI runs e2e).

---

## Self-Review

**Spec coverage:** §1 delete handler → Task 1; §2 post-page island → Task 2; §3 editor → Task 3; §4 delete proxy → Task 2; §5 reclaimer (+cron+dispatcher+hook) → Task 4; §Testing → Tasks 1/4/5. All covered.

**Placeholder scan:** every code step has real code or an exact clone target (`comment-delete.ts`, the reaper hook). The astro-markup steps point at the exact file + the data-attributes/selectors and reference the established island/`[hidden]` patterns rather than restating them.

**Type consistency:** `handleDeletePost(request, env, ctx, params: {id})` (Task 1) consumed by the `routes.ts` DELETE entry (Task 1) and the proxy → api path (Task 2). `reapOrphanMedia(env, ctx): Promise<{rows, objects}>` defined Task 4, consumed by the dispatcher + hook (Task 4). The proxy `POST /api/post-delete` (Task 2) is consumed by the island (Task 2) and the e2e (Task 5). `{ username }` delete response (Task 1) drives the island/editor redirect (Tasks 2/3).

**Spec deviation noted:** the spec's reclaimer test case (d) ("two rows, one referenced one not") is impossible (shared key ⇒ shared sha256 ⇒ shared referenced-status); Task 4 uses the correct dedup scenario (a grace-aged sibling keeps the object). Design requirement (dedup-safe deletion) unchanged.

# M2.3b-live — Per-post live comments & reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone comments or reacts on a post, every open post-page tab (logged in or not) sees it live — new comments splice in, edits swap in place, deletes tombstone, reaction counts tick — with a content-free WebSocket nudge and client-side reconcile.

**Architecture:** A per-post, content-free WebSocket relay Durable Object (`PostLiveDO`, keyed on `postId`) reached through an **unauthed, Origin-checked** `api` upgrade route and a `web` 101-reconstruction proxy. The comment/reaction write handlers push a `{type:"comment"|"reaction"}` nudge (via `ctx.waitUntil`, gated on a real write, swallowed). The client reconciles by comment id against a freshly-rendered window fetched from a new `web` `/api/comments-fragment` endpoint (same sanitize-first `renderMarkdown` pipeline as the SSR); reactions just refetch counts.

**Tech Stack:** existing only — TS 6.0.3, Cloudflare Durable Objects (Hibernation API), `@astrojs/cloudflare`, Postgres via Hyperdrive, Playwright, vitest (`cloudflare:test` pool + node). No new deps.

**Branch:** `m2-3b-live` off `main` (already created; the spec is committed there).

**Spec:** `docs/superpowers/specs/2026-07-29-m2-3b-live-per-post-live-engagement-design.md`.

## Global Constraints

- **Reuse the shipped M2.3b patterns verbatim where they apply** — read these files and mirror them; do not reinvent:
  - `apps/api/src/durable-objects/NotifyDO.ts` — the hibernating content-free relay (`ctx.acceptWebSocket`, `getWebSockets()`, per-socket try/catch, no-op `webSocketMessage`, case-insensitive `Upgrade`, 101/426).
  - `apps/api/src/routes/notifications-ws.ts` — the inline-authed GET upgrade route shape (`isAllowedOrigin` first, then forward to `getByName(...).fetch(request)`).
  - `apps/api/src/notifications/create.ts` — the push seam: `ctx.waitUntil((async () => { try { await …push(kind); } catch (err) { console.error(…); } })())`, gated on a real write, NEVER throws.
  - `apps/web/src/pages/api/notifications-ws.ts` — the hand-reconstructed 101 proxy (`new Response(null, {status:101, webSocket})`; wholesale `context.request.headers`; `markPrivate` on non-101; bare-101→502; `import { env } from "cloudflare:workers"`; NO `apiFetch`).
  - `apps/api/test/notify-do.test.ts` — the `cloudflare:test` DO test patterns (`connect()` helper, 101/426, content-free assertions, multi-socket broadcast, `evictDurableObject` hibernation).
  - `apps/web/test/notify-ws-proxy.test.ts` — the source-structure proxy test (co-located anti-vacuity regexes).
  - `e2e/notifications-realtime.spec.ts` + `e2e/helpers.ts` — Task-7 WS-e2e discipline: arm `page.waitForEvent("websocket")` BEFORE the actor acts (the content-free nudge is not replayed), assert **observable DOM** never frame contents, key resilience off `data-` attributes not text.
- **Content-free wire:** every push and every frame carries only `{type:"comment"|"reaction"}` — no ids, bodies, or counts.
- **The client's ONLY HTML sink** is the `/api/comments-fragment` endpoint's `renderMarkdown` output (same safety class as the three existing `set:html` sinks). All other DOM is `createElement`/`textContent`. Never `innerHTML` anything else.
- **Push never throws / never rolls back** the triggering write; delivered via `ctx.waitUntil`; gated on a real row change (a no-op edit/delete/react pushes nothing).
- **Origin guard = `isAllowedOrigin`** (from `apps/api/src/auth/csrf.ts`), NOT `checkOrigin` (which bypasses GET). The post-live route has **no session read**.
- **Bindings rule:** edit `apps/api/wrangler.jsonc` → `pnpm --filter @thinkersjournal/api exec wrangler types ./src/worker-configuration.d.ts` → COMMIT the regen. New DO = `new_sqlite_classes` + a new migration `tag`. Export the DO class from `apps/api/src/index.ts`.
- **Commit messages:** plain `git commit -m "…"` (single line) or `-F <file>`. NEVER a PowerShell `@'…'@` heredoc (injects a literal `@`).
- **Baseline that must never regress** (main @ `31c52ba`): `pnpm typecheck` 0 · shared 58 · markdown 93 · `check:workerd` clean · api 609 · web 555/6skip · e2e 17/17. Docker Postgres required for api + e2e.

---

### Task 1: `PostLiveDO` — per-post hibernating content-free relay + binding + migration

**Files:**
- Create: `apps/api/src/durable-objects/PostLiveDO.ts`
- Modify: `apps/api/src/index.ts` (export `PostLiveDO`)
- Modify: `apps/api/wrangler.jsonc` (binding `POST_LIVE` + migration tag)
- Modify: `apps/api/src/worker-configuration.d.ts` (regenerated, committed)
- Test: `apps/api/test/post-live-do.test.ts`

**Interfaces:**
- Produces: `class PostLiveDO extends DurableObject` with `push(kind: "comment" | "reaction"): void` (broadcasts `JSON.stringify({ type: kind })` to all sockets) and `fetch(request): Promise<Response>` (101 + client webSocket, or 426). Binding `POST_LIVE: DurableObjectNamespace<PostLiveDO>` on `Env`.

- [ ] **Step 1: Write the failing test.** Mirror `apps/api/test/notify-do.test.ts` exactly, but against `env.POST_LIVE` and `push("comment")`/`push("reaction")`. `apps/api/test/post-live-do.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

/** Open a hibernatable client socket to a post's PostLiveDO and collect frames. */
async function connect(postId: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const stub = env.POST_LIVE.getByName(postId);
  const resp = await stub.fetch("https://do/live", { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("expected a webSocket");
  ws.accept();
  const messages: string[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(e.data as string);
  });
  return { ws, messages };
}

describe("PostLiveDO", () => {
  it("101s a websocket upgrade and broadcasts a content-free {type} frame to all sockets", async () => {
    const a = await connect("post-1");
    const b = await connect("post-1");
    await env.POST_LIVE.getByName("post-1").push("comment");
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages).toEqual([JSON.stringify({ type: "comment" })]);
    expect(b.messages).toEqual([JSON.stringify({ type: "comment" })]);
    a.ws.close();
    b.ws.close();
  });

  it("frames carry NOTHING user-derived (no ids/bodies/counts)", async () => {
    const a = await connect("post-2");
    await env.POST_LIVE.getByName("post-2").push("reaction");
    await new Promise((r) => setTimeout(r, 50));
    const frame = a.messages[0] ?? "";
    // content-free: exactly {type}, nothing user-derived (no post id, body, or count)
    expect(JSON.parse(frame)).toEqual({ type: "reaction" });
    expect(frame).not.toContain("post-2");
    a.ws.close();
  });

  it("426s a non-upgrade request", async () => {
    const resp = await env.POST_LIVE.getByName("x").fetch("https://do/live");
    expect(resp.status).toBe(426);
  });

  it("accepts a mixed-case Upgrade token (case-insensitive per RFC 6455)", async () => {
    const resp = await env.POST_LIVE.getByName("casing").fetch("https://do/live", {
      headers: { Upgrade: "WebSocket" },
    });
    expect(resp.status).toBe(101);
    resp.webSocket?.accept();
    resp.webSocket?.close();
  });

  it("survives hibernation: a socket connected before eviction still receives a push after", async () => {
    const { ws, messages } = await connect("hiber");
    const stub = env.POST_LIVE.getByName("hiber");
    await evictDurableObject(stub);
    await stub.push("comment");
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual([JSON.stringify({ type: "comment" })]);
    ws.close();
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api exec vitest run test/post-live-do.test.ts` → FAIL (no `POST_LIVE` binding / no class).

- [ ] **Step 3: Implement `PostLiveDO`.** Copy `apps/api/src/durable-objects/NotifyDO.ts` to `PostLiveDO.ts` and change only: the class name → `PostLiveDO`; the `push` param type → `"comment" | "reaction"`; the doc comment to describe the per-post, UNAUTHED, content-free channel (auth happens at the route as origin-only; the DO relays). Keep `ctx.acceptWebSocket`, `getWebSockets()`, per-socket try/catch, no-op `webSocketMessage`, the case-insensitive `Upgrade` check, and `new Response(null, {status:101, webSocket: client})`.

- [ ] **Step 4: Wire the binding.** In `apps/api/src/index.ts` add `export { PostLiveDO } from "./durable-objects/PostLiveDO";`. In `apps/api/wrangler.jsonc` add a `durable_objects.bindings` entry `{ "name": "POST_LIVE", "class_name": "PostLiveDO" }` and a NEW migration entry `{ "tag": "v<next>", "new_sqlite_classes": ["PostLiveDO"] }` (bump the tag past the existing NotifyDO one). Then regenerate types: `pnpm --filter @thinkersjournal/api exec wrangler types ./src/worker-configuration.d.ts`.

- [ ] **Step 5: Run → PASS + typecheck.** `pnpm --filter @thinkersjournal/api exec vitest run test/post-live-do.test.ts` → 5 pass. `pnpm --filter @thinkersjournal/api typecheck` → 0.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(m2.3b-live): PostLiveDO — per-post hibernating content-free WS relay + binding/migration"`

---

### Task 2: `GET /posts/live` — unauthed, Origin-checked upgrade route

**Files:**
- Create: `apps/api/src/routes/posts-live.ts`
- Modify: `apps/api/src/routes.ts` (add to `ROUTES`)
- Test: `apps/api/test/posts-live.test.ts`; `apps/api/test/error-envelope.test.ts` (+CASES)

**Interfaces:**
- Consumes: `isAllowedOrigin(env, request)` (`../auth/csrf`), `errorResponse` (`../http/errors`), `env.POST_LIVE`.
- Produces: `handlerPostsLive` at `GET /posts/live?postId=<uuid>` — 403 bad origin, 400 bad/missing postId, 426 non-upgrade, else forwards the upgrade to `env.POST_LIVE.getByName(postId).fetch(request)`. NO session read.

- [ ] **Step 1: Write the failing test.** `apps/api/test/posts-live.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

const ALLOWED_ORIGIN = "http://localhost:8787";
const POST = "018f0000-0000-7000-8000-000000000001";
function wsReq(url: string, origin = ALLOWED_ORIGIN): Request {
  return new Request(url, { headers: { Upgrade: "websocket", Origin: origin } });
}

describe("GET /posts/live (unauthed, origin-checked)", () => {
  it("403s a cross-site Origin even without a session", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(wsReq(`https://api.test/posts/live?postId=${POST}`, "https://evil.example"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
  });

  it("400s a missing or malformed postId", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(wsReq("https://api.test/posts/live?postId=not-a-uuid"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
  });

  it("426s a non-upgrade GET (valid origin + postId)", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request(`https://api.test/posts/live?postId=${POST}`, { headers: { Origin: ALLOWED_ORIGIN } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(426);
  });

  it("101s a valid upgrade with NO session (anonymous allowed) and forwards to the post's DO", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(wsReq(`https://api.test/posts/live?postId=${POST}`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(101);
    resp.webSocket?.accept();
    resp.webSocket?.close();
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api exec vitest run test/posts-live.test.ts`.

- [ ] **Step 3: Implement the route.** `apps/api/src/routes/posts-live.ts` — mirror `notifications-ws.ts` but drop the session read and validate `postId`:

```ts
/**
 * GET /posts/live?postId=<uuid> — the UNAUTHENTICATED per-post live channel.
 * Origin-checked (WS carries cookies, bypasses CORS) but no session: the post is
 * public, its comments/reactions are public, and the frames are content-free
 * ({type} only). Forwards the upgrade to the post's own PostLiveDO.
 */
import { isAllowedOrigin } from "../auth/csrf";
import { errorResponse } from "../http/errors";

import type { RouteHandler } from "./routing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handlerPostsLive: RouteHandler = async (request, env) => {
  if (!isAllowedOrigin(env, request)) return errorResponse("FORBIDDEN", 403);

  const postId = new URL(request.url).searchParams.get("postId") ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("INVALID_INPUT", 400, { fields: ["postId"] });

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  return env.POST_LIVE.getByName(postId).fetch(request);
};
```

*(Confirm `RouteHandler`'s exact signature in `apps/api/src/routes/routing.ts` and match it, as `notifications-ws.ts` does. If the handler name convention differs, follow the existing one.)*

- [ ] **Step 4: Register the route.** In `apps/api/src/routes.ts` add `{ method: "GET", pattern: "/posts/live", handler: handlerPostsLive }` to `ROUTES` (import it). This changes the route-protection inventory — if `route-protection.test.ts` snapshots `ROUTES`, update the snapshot to include ONLY this addition.

- [ ] **Step 5: Add error-envelope CASES.** In `apps/api/test/error-envelope.test.ts` add cases mirroring the notifications-ws entry: `403 bad origin` (build a `wsReq` with a cross-site Origin) and `400 bad postId`.

- [ ] **Step 6: Run → PASS + typecheck.** `pnpm --filter @thinkersjournal/api exec vitest run test/posts-live.test.ts test/error-envelope.test.ts test/route-protection.test.ts` → green. `pnpm --filter @thinkersjournal/api typecheck` → 0.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(m2.3b-live): GET /posts/live — unauthed, origin-checked upgrade to the post's PostLiveDO"`

---

### Task 3: `web` `posts-live.ts` proxy (hand-reconstructed 101)

**Files:**
- Create: `apps/web/src/pages/api/posts-live.ts`
- Test: `apps/web/test/posts-live-proxy.test.ts`

**Interfaces:**
- Produces: `GET /api/posts-live?postId=<id>` — forwards the browser's upgrade to `api`'s `/posts/live?postId=` over the `API` Service Binding, hand-reconstructs the 101.

- [ ] **Step 1: Write the failing source test.** Mirror `apps/web/test/notify-ws-proxy.test.ts` (readFileSync + stripComments + co-located anti-vacuity regexes). `apps/web/test/posts-live-proxy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const code = stripComments(readFileSync(join(DIR, "posts-live.ts"), "utf8"));

describe("posts-live proxy", () => {
  it("forwards to /posts/live over the API Service Binding, carrying postId + wholesale headers", () => {
    expect(code).toContain("/posts/live");
    expect(code).toContain("API.fetch");
    expect(code).toMatch(/headers:\s*context\.request\.headers/);
    expect(code).toContain("Upgrade");
    expect(code).toMatch(/postId/); // forwards the query param
  });
  it("hand-reconstructs the 101 and coerces a bare 101 to 502", () => {
    expect(code).toMatch(/new Response\(\s*null[\s\S]{0,160}status:\s*101[\s\S]{0,160}webSocket/);
    expect(code).toMatch(/upstream\.status === 101 \? 502/);
  });
  it("is prerender=false, declares markPrivate, and never uses apiFetch", () => {
    expect(code).toContain("export const prerender = false");
    expect(code).toContain("markPrivate");
    expect(code).not.toContain("apiFetch");
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/web test posts-live-proxy`.

- [ ] **Step 3: Implement.** Copy `apps/web/src/pages/api/notifications-ws.ts` to `posts-live.ts` and change only the upstream URL to carry `postId`: read `const postId = new URL(context.request.url).searchParams.get("postId") ?? ""` and fetch `` `https://api.internal/posts/live?postId=${encodeURIComponent(postId)}` ``. Keep everything else identical (the hand-reconstructed 101, wholesale `context.request.headers`, `markPrivate` on non-101, bare-101→502, `import { env } from "cloudflare:workers"`, `prerender = false`, no `apiFetch`). Update the doc comment to say per-post live channel.

- [ ] **Step 4: Run → PASS + build + typecheck.** `pnpm --filter @thinkersjournal/web test posts-live-proxy page-cache-inventory` (SWEEP A must stay green — the `markPrivate` satisfies it). `pnpm --filter @thinkersjournal/web build`. `pnpm --filter @thinkersjournal/web typecheck` → 0.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(m2.3b-live): web posts-live proxy — forwards the per-post upgrade over the Service Binding"`

---

### Task 4: `notifyPostLive()` seam + push from the four write handlers

**Files:**
- Create: `apps/api/src/notifications/post-live.ts`
- Modify: `apps/api/src/routes/comments.ts` (`handleCreateComment`, `handleUpdateComment`, `handleDeleteComment`)
- Modify: `apps/api/src/routes/reactions.ts` (`handleAddReaction`, `handleRemoveReaction`)
- Test: `apps/api/test/post-live-push.node.test.ts` (seam) + additions to `apps/api/test/comments.test.ts` and `apps/api/test/reactions.test.ts` (Worker-level wiring)

**Interfaces:**
- Produces: `notifyPostLive(env: PostLiveEnv, ctx: PostLiveCtx, postId: string, kind: "comment" | "reaction"): void` — schedules `env.POST_LIVE.getByName(postId).push(kind)` inside `ctx.waitUntil`, swallowing failures. `PostLiveEnv`/`PostLiveCtx` are structural (same reason as `NotifyEnv`/`NotifyCtx`).

- [ ] **Step 1: Write the seam.** `apps/api/src/notifications/post-live.ts` — mirror the delivery half of `create.ts`:

```ts
/**
 * PER-POST LIVE PUSH SEAM. Fires a content-free {type} nudge at a post's
 * PostLiveDO so every open post-page tab refetches. Same discipline as
 * notify() (create.ts): delivered via ctx.waitUntil (an unawaited DO RPC is
 * canceled once the Response returns), failure swallowed, NEVER throws / never
 * rolls back the triggering write. Callers gate on a REAL row change — a no-op
 * write must not push. Structural env/ctx for the same tsconfig reason as
 * NotifyEnv/NotifyCtx.
 */
interface PostLiveEnv {
  POST_LIVE: { getByName(id: string): { push(kind: "comment" | "reaction"): void } };
}
export interface PostLiveCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export function notifyPostLive(
  env: PostLiveEnv,
  ctx: PostLiveCtx,
  postId: string,
  kind: "comment" | "reaction",
): void {
  ctx.waitUntil(
    (async () => {
      try {
        await env.POST_LIVE.getByName(postId).push(kind);
      } catch (err) {
        console.error("post-live push failed", { kind, err });
      }
    })(),
  );
}
```

- [ ] **Step 2: Write the failing seam test.** `apps/api/test/post-live-push.node.test.ts` (node project — no workerd needed; drive `notifyPostLive` with stubs):

```ts
import { describe, expect, it } from "vitest";
import { notifyPostLive } from "../src/notifications/post-live";

const fakeCtx = { waitUntil: (p: Promise<unknown>) => { void p; } };

describe("notifyPostLive()", () => {
  it("pushes the kind to the post's channel", () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const env = { POST_LIVE: { getByName: (id: string) => ({ push: (k: string) => pushed.push({ id, kind: k }) }) } };
    notifyPostLive(env, fakeCtx, "post-9", "comment");
    expect(pushed).toEqual([{ id: "post-9", kind: "comment" }]);
  });
  it("never throws when the push fails", () => {
    const env = { POST_LIVE: { getByName: () => ({ push: () => { throw new Error("do down"); } }) } };
    expect(() => notifyPostLive(env, fakeCtx, "post-9", "reaction")).not.toThrow();
  });
});
```

Run → FAIL, then it passes once the seam file exists. `pnpm --filter @thinkersjournal/api exec vitest run test/post-live-push.node.test.ts`.

- [ ] **Step 3: Wire the three comment handlers.** In `apps/api/src/routes/comments.ts`, add `import { notifyPostLive } from "../notifications/post-live";`. Then, **immediately after each existing `await purgeTags(env, [\`post:${…}\`])`**, add `notifyPostLive(env, ctx, <thatPostId>, "comment");`:
  - `handleCreateComment`: after `await purgeTags(env, [\`post:${postId}\`]);` → `notifyPostLive(env, ctx, postId, "comment");` (the insert already passed its guards — a real new row).
  - `handleUpdateComment`: `postId` is the `RETURNING post_id` result and is non-null past the `if (postId === null) return 404` guard → after its `purgeTags`, `notifyPostLive(env, ctx, postId, "comment");`.
  - `handleDeleteComment`: after `await purgeTags(env, [\`post:${outcome.purged}\`]);` → `notifyPostLive(env, ctx, outcome.purged, "comment");` (only in the `"purged" in outcome` branch — a real tombstone).

- [ ] **Step 4: Wire the two reaction handlers.** In `apps/api/src/routes/reactions.ts`, add the import. Reactions do NOT purge; gate the push on a REAL row change:
  - `handleAddReaction`: the INSERT is `ON CONFLICT DO NOTHING`. Capture its `rowCount` (destructure the `c.query(...)` result), and only `notifyPostLive(env, ctx, notifPostId, "reaction")` when `rowCount > 0` (a genuinely new reaction). `notifPostId` already resolves to the post (post target → `postId`; comment target → the comment's `post_id`).
  - `handleRemoveReaction`: the DELETE currently deletes by `post_id` OR `comment_id` without resolving the post for a comment target. Change the two DELETEs to `RETURNING post_id`, capture `{ rows }`, and if a row was returned (`rows[0]`), `notifyPostLive(env, ctx, rows[0].post_id, "reaction")`. For the post-target branch, `RETURNING post_id` returns the post itself; for the comment-target branch it returns the comment's post_id. No row returned → nothing was removed → no push.

- [ ] **Step 5: Worker-level wiring tests.** Add to `apps/api/test/comments.test.ts` a `describe("comment post-live push")` mirroring the M2.3b `notify push` suites (spread `env`, override `POST_LIVE` with a spy, `createExecutionContext` + `waitOnExecutionContext`): a create pushes `{id: postId, kind:"comment"}` exactly once; a no-op-guarded case pushes nothing. Add to `apps/api/test/reactions.test.ts`: an add-reaction on a POST pushes `reaction` on that post; an add-reaction on a COMMENT pushes `reaction` on the **comment's post** (seed a comment, react to it, assert the spy's id == the post id, not the comment id); a duplicate add (ON CONFLICT no-op) pushes nothing.

- [ ] **Step 6: Run → PASS + typecheck.** `pnpm --filter @thinkersjournal/api exec vitest run test/comments.test.ts test/reactions.test.ts test/post-live-push.node.test.ts` → green. Full api `pnpm --filter @thinkersjournal/api test` (expect 609 + the new tests). `pnpm --filter @thinkersjournal/api typecheck` → 0.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(m2.3b-live): push a content-free post-live nudge from the comment/reaction write handlers"`

---

### Task 5: `GET /api/comments-fragment` — server-rendered comment window

**Files:**
- Create: `apps/web/src/pages/api/comments-fragment.ts`
- Test: `apps/web/test/comments-fragment.test.ts`

**Interfaces:**
- Produces: `GET /api/comments-fragment?postId=<id>&cursor=<path>` → `{ comments: Array<{ id, parentId, depth, path, authorUsername, authorName, createdAt, edited, deleted, html }>, nextCursor }`. `html` is `renderMarkdown(bodyMarkdown)` output (empty string for a tombstone). Same window the SSR shows for that cursor. `markPrivate`, no-store.

- [ ] **Step 1: Write the failing source test.** `apps/web/test/comments-fragment.test.ts` (source-structure — the render logic mirrors `[slug].astro`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const DIR = join(__dirname, "..", "src", "pages", "api");
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const code = stripComments(readFileSync(join(DIR, "comments-fragment.ts"), "utf8"));

describe("comments-fragment endpoint", () => {
  it("fetches the public comment window from api and renders each via renderMarkdown", () => {
    expect(code).toContain("/public/comments"); // the api read (confirm the real path in comments-public.ts / routes.ts)
    expect(code).toContain("renderMarkdown");
    expect(code).toMatch(/cursor|comments=/); // forwards the window cursor
  });
  it("renders a tombstone as empty html, never rendering a deleted body", () => {
    expect(code).toMatch(/deleted\s*\?\s*""\s*:\s*(await\s*)?renderMarkdown/);
  });
  it("is prerender=false, markPrivate, no apiFetch-body-consume issue (JSON read is fine)", () => {
    expect(code).toContain("export const prerender = false");
    expect(code).toContain("markPrivate");
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/web test comments-fragment`.

- [ ] **Step 3: Implement.** `apps/web/src/pages/api/comments-fragment.ts` — an Astro APIRoute that mirrors how `[slug].astro` builds `renderedComments` (`import { renderMarkdown } from "@thinkersjournal/markdown"`), but as a JSON endpoint. Read `postId` + `cursor` from the query; fetch the window from `api`'s public comments read (confirm the exact path — `/public/comments?postId=&cursor=` per `comments-public.ts`, likely via `apiFetch` since it reads a JSON body, which is fine here — only WS upgrades must avoid `apiFetch`); map each comment to `{ id, parentId, depth, path, authorUsername, authorName, createdAt, edited: editedAt != null, deleted, html: deleted ? "" : await renderMarkdown(bodyMarkdown) }`; return `{ comments, nextCursor }` as JSON with `markPrivate` headers + `prerender = false`. Match the field names the client (Task 7) will consume.

- [ ] **Step 4: Run → PASS + build + typecheck.** `pnpm --filter @thinkersjournal/web test comments-fragment page-cache-inventory` (markPrivate keeps SWEEP A green). `pnpm --filter @thinkersjournal/web build`. `pnpm --filter @thinkersjournal/web typecheck` → 0.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(m2.3b-live): GET /api/comments-fragment — server-rendered comment window for live reconcile"`

---

### Task 6: Factor per-comment affordance wiring out of `comments.ts`

**Files:**
- Modify: `apps/web/src/scripts/comments.ts` (extract `wireCommentAffordances`)
- Test: `apps/web/test/comments-island.test.ts` (stays green; add a source assertion for the exported helper)

**Interfaces:**
- Produces: `export function wireCommentAffordances(li: HTMLElement, opts: { csrfToken: string; viewerId: string; postId: string; postAuthorId: string }): void` — the Reply/Edit/Delete wiring for ONE comment `<li>`, extracted verbatim from the existing per-comment loop body in `initCommentsIsland`. `initCommentsIsland` now calls it per `<li>`; Task 7's live client calls it for freshly-inserted `<li>`s.

- [ ] **Step 1: Write/adjust the test.** In `apps/web/test/comments-island.test.ts` add a source assertion that the per-comment affordances are a reusable export: `expect(code).toContain("export function wireCommentAffordances")` and that `initCommentsIsland` calls it. Keep all existing assertions (behavior unchanged).

- [ ] **Step 2: Run → FAIL** on the new assertion.

- [ ] **Step 3: Extract.** In `apps/web/src/scripts/comments.ts`, lift the body of the `for (const li of …)` loop in `initCommentsIsland` (the Reply/Edit/Delete button wiring, lines ~170–243) into `export function wireCommentAffordances(li, { csrfToken, viewerId, postId, postAuthorId })`, using the same `buildForm`/`postJson`/`fetchSource`/`MAX_DEPTH` helpers (keep them module-scoped so both callers share them). `initCommentsIsland` keeps its `loadMe()` gating and the form-slot logic, and its loop becomes `for (const li of …) wireCommentAffordances(li, { csrfToken, viewerId, postId, postAuthorId });`. No behavior change.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test comments-island`. `pnpm --filter @thinkersjournal/web typecheck` → 0.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(m2.3b-live): extract wireCommentAffordances for reuse by the live client"`

---

### Task 7: `comments-live.ts` — socket lifecycle + reconcile-by-id client

**Files:**
- Create: `apps/web/src/scripts/comments-live.ts`
- Modify: `apps/web/src/scripts/reactions.ts` (export `refreshReactionCounts`)
- Modify: the post page's client entry (wherever `initCommentsIsland`/`initReactionsIsland` are called — likely a `<script>` in `[slug].astro` or a bundled entry) to also call `initCommentsLive()`
- Test: `apps/web/test/comments-live.test.ts`

**Interfaces:**
- Consumes: `wireCommentAffordances` (Task 6), `GET /api/comments-fragment` (Task 5), `GET /api/posts-live` (Task 3), `refreshReactionCounts` (this task).
- Produces: `export function initCommentsLive(): void`. `export function refreshReactionCounts(): void` (from `reactions.ts` — the existing fetch-and-applyState logic, callable on demand).

- [ ] **Step 1: Export the reaction refetch.** In `apps/web/src/scripts/reactions.ts`, lift the `/api/reactions` fetch-and-`applyState` logic (currently inside `initReactionsIsland`) into `export function refreshReactionCounts(): void`, and have `initReactionsIsland` call it (plus its one-time click wiring). No behavior change.

- [ ] **Step 2: Write the failing source test.** `apps/web/test/comments-live.test.ts` (source-structure + co-located anti-vacuity regexes):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const code = readFileSync(join(__dirname, "..", "src", "scripts", "comments-live.ts"), "utf8");
function strip(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const stripped = strip(code);

describe("comments-live client", () => {
  it("opens a WebSocket to /api/posts-live with the post id, only when the comments section exists", () => {
    expect(stripped).toMatch(/location\.protocol === "https:" \? "wss" : "ws"[\s\S]{0,200}\/api\/posts-live/);
    expect(stripped).toContain("new WebSocket(");
    expect(stripped).toMatch(/postId/);
    expect(stripped).toMatch(/data-comments/); // gated on the section
  });
  it("nudge is content-free: onmessage switches on {type}, never renders event.data", () => {
    expect(stripped).toMatch(/onmessage[\s\S]{0,200}type/);
    expect(stripped).not.toMatch(/onmessage[\s\S]{0,300}innerHTML\s*=\s*[^;]*event\.data/);
    // reaction nudge → refetch counts; comment nudge → fetch the fragment window
    expect(stripped).toMatch(/refreshReactionCounts\(\)/);
    expect(stripped).toContain("/api/comments-fragment");
  });
  it("reconciles by id: inserts new, tombstones deletes, swaps edited, NEVER removes a node, skips open forms", () => {
    expect(stripped).toMatch(/querySelector[\s\S]{0,80}data-comment-id/); // looks up existing by id
    expect(stripped).toMatch(/data-deleted|tombstone/); // delete → tombstone
    expect(stripped).not.toContain(".remove()"); // never live-remove
    expect(stripped).toMatch(/form|data-open/); // do-not-disrupt: skip a comment with an open form
    expect(stripped).toContain("wireCommentAffordances"); // re-wire inserted comments
  });
  it("the ONLY html sink is the fragment's rendered html, and there is a single live socket", () => {
    // innerHTML is used solely for the comment body from the fragment endpoint
    expect(stripped).toMatch(/comment-body[\s\S]{0,120}innerHTML/);
    expect(stripped).toMatch(/if \(ws !== null\) return/);
  });
});
```

- [ ] **Step 3: Run → FAIL.** `pnpm --filter @thinkersjournal/web test comments-live`.

- [ ] **Step 4: Implement `comments-live.ts`.** Write `initCommentsLive()`:
  - Bail unless `document.querySelector("[data-comments]")` exists; read `postId` from `[data-comments].dataset.postId`, and `postAuthorId` from `dataset.postAuthorId`. Fetch `/api/me` once (reuse the island's shape) for `{ csrfToken, userId }` so freshly-inserted comments can be affordance-wired for the viewer (skip wiring if logged out / no token).
  - **Socket:** derive `wss?://host/api/posts-live?postId=<id>`. Single socket (`if (ws !== null) return`), open on init. `onclose`/`onerror` → drop the ref + a bounded reconnect: a short delayed retry with a small cap (e.g. retry up to 5 times with 1→2→4→8→16s, then stop; a navigation re-establishes). No poll here (unlike the bell), so the cap is the whole reconnect story.
  - **`onmessage`:** parse `{ type }` ONLY. `type==="reaction"` → `refreshReactionCounts()`. `type==="comment"` → `void reconcile()`.
  - **`reconcile()`:** read the page's window cursor from `new URLSearchParams(location.search).get("comments")`; `fetch(\`/api/comments-fragment?postId=${postId}${cursor ? \`&cursor=${encodeURIComponent(cursor)}\` : ""}\`)`; for each returned comment, find `section.querySelector(\`[data-comment-id="${id}"]\`)`:
    - **exists + has an open form** (`li.querySelector("form")` present) → skip this cycle.
    - **exists + deleted now** → replace body with the `[deleted]` tombstone `<p>` (createElement/textContent), remove its actions/chips.
    - **exists + edited** (fragment `edited` true and DOM lacks the edited marker, or body differs) → set `li.querySelector(".comment-body").innerHTML = fragment.html` (the ONLY html sink) + add the "(edited)" marker span (createElement).
    - **missing** → build the `<li>` (mirror the SSR structure from `[slug].astro`: `data-comment-id`, `data-depth`, `data-author-id`, the meta line via createElement/textContent, `<div class="comment-body">` with `.innerHTML = fragment.html`, an empty `[data-comment-actions]`, and a `ReactionChips`-equivalent placeholder the reactions island can fill on the next `refreshReactionCounts()`); insert at the **path-ordered position** (iterate existing `[data-comment-id]` in DOM order comparing `dataset.path`/`data-path` — add `data-path` to the SSR + inserted `<li>`s so the client can order; if the SSR `<li>` lacks `data-path`, add it in `[slug].astro`); add `data-new`; then `wireCommentAffordances(li, { csrfToken, viewerId, postId, postAuthorId })` if the viewer is eligible.
    - **never** call `.remove()`.
  - After a reconcile that inserted/changed comments, call `refreshReactionCounts()` so new comments' chips populate.
  - ⚠️ Add `data-path={c.path}` to each comment `<li>` in `[slug].astro` (Task 7 depends on it for ordering) and to inserted `<li>`s.
  - Register `initCommentsLive()` in the same client entry that calls `initCommentsIsland()`/`initReactionsIsland()`.

- [ ] **Step 5: Run → PASS + build + typecheck + full web.** `pnpm --filter @thinkersjournal/web test comments-live comments-island reactions`. `pnpm --filter @thinkersjournal/web build`. `pnpm --filter @thinkersjournal/web test` (full). `pnpm --filter @thinkersjournal/web typecheck` → 0.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(m2.3b-live): comments-live client — reconcile-by-id insert/edit/tombstone on a content-free nudge"`

---

### Task 8: E2E realtime spine — two tabs on one post

**Files:**
- Create: `e2e/post-live.spec.ts`
- Test: itself (Playwright)

- [ ] **Step 1: Write the spec.** `e2e/post-live.spec.ts` — mirror `e2e/notifications-realtime.spec.ts`'s discipline. Flow:
  1. Author A: `signUpAndVerify` → `publishPost` → get the post `url`.
  2. Viewer V opens the post `url` in a SECOND context (anonymous is fine — the channel is unauthed). Arm `const wsOpened = v.waitForEvent("websocket")` BEFORE `v.goto(url)`, assert the comments section visible, then `await wsOpened` (the post-live socket must be open before B acts — the content-free nudge is not replayed).
  3. Commenter B (third context): `signUpAndVerify` → `chooseUsername` → `goto(url)` → submit a comment via `[data-comment-form-slot] form` → assert B sees its own comment.
  4. **Live assert (V did NOTHING since step 2):** `await expect(v.locator('[data-comments] [data-comment-id]', { hasText: '<B\'s comment text>' })).toBeVisible({ timeout: 8000 })` — 8s ≪ any refresh; V never navigated → only the WS push could have delivered it. State this isolation in a comment.
  5. **Live reaction:** B reacts on the post (`[data-reactions] button[data-kind]`); assert V's matching count ticks to 1 within 8s.
  6. **Live edit + delete** (since v1 includes them): B edits its comment → V's body updates; B deletes → V sees `[data-deleted]`/tombstone. (If a step is flaky under the dev-harness WS accumulation, apply the Task-7 lesson — a `toggleFollowTo`-style resilient interaction keyed off `data-` attributes; do NOT assert on frames.)
  7. `finally` close the B and V contexts.

- [ ] **Step 2: Run (fresh dev DB).** `docker exec thinkersjournal-db psql -U postgres -d thinkersjournal -c "TRUNCATE ... RESTART IDENTITY CASCADE"` (reset per the M2.3b flake learnings — a polluted dev DB breaks global-text assertions) → `pnpm --filter @thinkersjournal/api run migrate` → `pnpm run test:e2e`. Target 18/18 (17 baseline + 1). **Two consecutive clean runs.** Auto-waiting only; no fixed sleeps.

- [ ] **Step 3: Reconcile** any flake by scoping selectors / applying the WS-e2e resilience discipline — never weaken an assertion.

- [ ] **Step 4: Commit.** `git add e2e/post-live.spec.ts && git commit -m "test(m2.3b-live): e2e — comment/reaction/edit/delete appear live on an open post page"`

---

## Milestone-end (controller, not a task)

Green sweep: `pnpm typecheck` · fresh web build then `pnpm -r test` · `pnpm --filter @thinkersjournal/markdown check:workerd` · `pnpm run test:e2e` ×2 (fresh dev DB) · docker healthy. Then the whole-branch adversarial review (ultracode Workflow; lenses: **per-post WS isolation** [content-free; unauthed-but-origin-checked is intended; can a frame leak?], **origin/WS-hijack on the unauthed route**, **push-never-throws + gated-on-real-write**, **the client's single set:html sink is renderMarkdown output only** [no other innerHTML; no path where a nudge renders user data], **reconcile correctness** [never-remove, path-order, do-not-disrupt-open-forms, comment-reaction→post-channel resolution], **DO lifecycle/hibernation**, **cache-leak** [markPrivate on the proxy + fragment; the post page's SSR cache is untouched]). Fix wave, then CI-gated PR to `origin/main`.

## Self-review notes (applied)

- **Spec coverage:** §3 channel → Tasks 1–3; §3 push trigger → Task 4; §4 reconcile + fragment → Tasks 5–7; §4 reactions → Task 7 (refreshReactionCounts); §5 lifecycle → Task 7; §6 security woven (origin-only route T2, content-free DO T1, single set:html sink T7, gated push T4); §8 tests per-task + T8 e2e; the §3 comment-reaction→post-channel resolution is Task 4 Step 4.
- **Type consistency:** `push(kind)` is `"comment" | "reaction"` everywhere (DO, seam, handlers, tests); the route addresses `getByName(postId)`; the client hits `/api/posts-live` (proxy) which forwards to `/posts/live` (api); `wireCommentAffordances` / `refreshReactionCounts` names match across Tasks 6/7.
- **Placeholder scan:** the one genuinely deferred detail (the exact `RouteHandler` signature and the exact public-comments read path) is pinned to "confirm in <file>", not left vague in an implementation step.
- **⚠️ Pre-flight for the executor:** Task 4 changes `handleRemoveReaction`'s DELETEs to `RETURNING post_id` — confirm no other caller depends on the old void return. Task 7 adds `data-path` to the SSR comment `<li>` in `[slug].astro` — a small SSR change bundled into Task 7's deliverable.

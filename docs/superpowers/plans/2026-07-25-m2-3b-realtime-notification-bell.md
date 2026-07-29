# M2.3b — Realtime notification bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the M2.3a notification bell from a 60s poll to a live WebSocket push via a per-user `NotifyDO` (Hibernation API), keeping the poll as fallback, per the approved spec `docs/superpowers/specs/2026-07-24-m2-3b-realtime-notification-bell-design.md`.

**Architecture:** a per-user `NotifyDO` (`getByName(userId)`) holds hibernating WebSockets and relays content-free "refresh" nudges. `api`'s `notify()` (write seam) and `handleMarkRead` ping the recipient's/caller's DO; an authed `GET /notifications/ws` on `api` (session→userId) forwards the upgrade to that DO; a `web` proxy forwards the browser's upgrade over the Service Binding. The bell opens the socket, refreshes on a nudge, reconnects with backoff, and keeps polling as a fallback.

**Tech Stack:** existing only — TS 6.0.3, Cloudflare Durable Objects (Hibernation API), Astro 7 + `@astrojs/cloudflare`, Playwright. No new deps.

**Branch:** `m2-3b-realtime-bell` off `main`.

> **⚠️ AS-BUILT DEVIATIONS (post-implementation, PR #8).** This plan is a point-in-time planning artifact; two items below shipped differently and this note governs where they conflict:
> 1. **Origin guard — `isAllowedOrigin`, NOT `checkOrigin`.** Every step below that says `checkOrigin` (arch summary, §Cross-cutting, Task 2) is superseded. Task 2's implementer found `checkOrigin` returns `true` for GET/HEAD *before* the allowlist, and a WS upgrade is a GET — reusing it would make the WS-hijack 403 a silent no-op. Task 2 extracted `isAllowedOrigin` (no method bypass) and the route uses that.
> 2. **Client reconnect — poll-driven, NOT exponential backoff.** "Reconnects with backoff" (arch summary + Task 6) was replaced after the whole-branch review AND Copilot both found a bespoke backoff/cap/latch error-prone (expired session reconnecting forever / recovered session never re-arming). The signed-in poll is the single (re)connect trigger; `onclose`/`onerror` just drop the socket ref and the next signed-in poll re-arms.
> (Endpoint note: the `api` upgrade route is `/notifications/ws`; the browser hits the `web` proxy at `/api/notifications-ws`. Both are correct as written per their side.)

## ⚠️ TASK 0 IS A HARD GATE

Task 0 is a **connectivity spike**, not a normal build task. It resolves the one unverified platform fact — whether a WebSocket upgrade forwards across the `web → api` Service Binding (and whether an Astro route can return a `101`+`webSocket`). **The controller reviews Task 0's outcome and confirms the topology BEFORE dispatching Task 1.** The rest of this plan is written for the **DO-in-`api`** outcome (the primary path). If Task 0 shows the Service Binding will not carry a WS, the controller re-scopes Tasks 1/2/5 for the **DO-in-`web` + cross-script-binding** pivot (the DO logic, push wiring, client, and tests in Tasks 3/4/6/7 are identical either way) before continuing.

## Global Constraints

- Baseline that must never regress (main @ `27237da` + spec `e582e39`): typecheck 0 · shared 58 · markdown 93 · api 583 · web 540/6skip · `check:workerd` clean · e2e 16/16. Docker Postgres up.
- **Bindings rule:** edit `apps/api/wrangler.jsonc` → `pnpm --filter @thinkersjournal/api exec wrangler types` (note: needs the explicit `./src/worker-configuration.d.ts` path arg, per the M2.2 lesson) → COMMIT the regenerated `src/worker-configuration.d.ts`. Never hand-edit `Env`. New DO namespaces use `new_sqlite_classes` + a fresh migration `tag` (KV-backed `new_classes` is blocked for new namespaces; the `UserSecurityDO` `v1` tag is the precedent).
- **DO exports:** a DO class must be `export`ed from the Worker entry `apps/api/src/index.ts` (see the existing `export { UserSecurityDO }`).
- **`notify()` never throws** — a push failure must not fail or slow (beyond bounded ping latency) the comment/reaction/follow. The DO ping is wrapped/swallowed exactly like the DB write.
- **`api` has NO public origin** — the browser only ever talks to `web`. Every client WS goes `browser → web → (Service Binding) → api → DO`.
- **Per-user isolation is server-side:** the WS route derives `userId` from the session (`readCurrentSession`), never a client param, so a caller can only attach to their own `NotifyDO`.
- **WS-hijack guard:** the upgrade validates `Origin` (`checkOrigin`, `src/auth/csrf.ts`) — WebSocket connections carry cookies and are not covered by CORS.
- **Route table rule:** every route in `src/routes.ts`'s `ROUTES`; `/notifications/ws` is a GET that authenticates inline (like `/auth/csrf`), so it is NOT in the mutating pipeline; add a `CASES` entry to `error-envelope.test.ts` (401 no session). `route-protection.test.ts` imports `ROUTES` and must stay green.
- **Nav bell is a client island** — no per-viewer state in the edge-cached nav HTML (unchanged). The WS is client-initiated; the nudge is content-free, so nothing user-derived is rendered from it. DOM stays `createElement`/`textContent`.
- **Vitest split (api):** DO/WS tests use `cloudflare:test` (real workerd) in the pool project — `test/**/*.test.ts` (NOT `.db.test.ts`/`.node.test.ts`). `test/user-security-do.test.ts` is the DO-test precedent; `evictDurableObject` from `cloudflare:test` exercises hibernation.
- **Web test style:** source/structure (`readFileSync` + `stripComments` + regex) + built-manifest greps; no in-vitest render. Anti-vacuity: positive before negative.

**Documented deviations / decisions** (carry through):
1. **Inline DO ping, no Queue** (spec decision 6) — reviewers may note the architecture doc's Queue; it is a deferred scale item.
2. The DO holds no durable state / no content (spec decision 7) — it is a relay, `new_sqlite_classes` is used for the platform requirement, not for storage.

---

## File Structure

**Create**
- `apps/api/src/durable-objects/NotifyDO.ts`
- `apps/api/src/routes/notifications-ws.ts` — the authed WS-upgrade route
- `apps/api/test/notify-do.test.ts`, `test/notifications-ws.test.ts`
- `apps/web/src/pages/api/notifications-ws.ts` — the web WS proxy (form per Task 0)
- `apps/web/test/notify-ws-proxy.test.ts`
- `e2e/notifications-realtime.spec.ts`
- `docs/superpowers/spikes/2026-07-25-ws-topology-spike.md` — Task 0's recorded outcome

**Modify**
- `apps/api/wrangler.jsonc` (+NOTIFY DO binding, +migration tag), `src/worker-configuration.d.ts` (regen), `src/index.ts` (+export NotifyDO)
- `apps/api/src/routes.ts` (+`GET /notifications/ws`), `test/error-envelope.test.ts` (+CASES)
- `apps/api/src/notifications/create.ts` (notify gains `env` + DO push), `src/routes/{comments,reactions,follows}.ts` (pass `env` to notify), `src/routes/notifications.ts` (mark-read DO push)
- `apps/api/test/{comments,reactions,follows,notifications}.test.ts` (push-spy assertions)
- `apps/web/src/scripts/notify-bell.ts` (WS lifecycle), `apps/web/test/notify-bell.test.ts` (WS assertions)

---

### Task 0: Connectivity spike — settle the WS topology (GATE, not TDD)

**Files:** Create `docs/superpowers/spikes/2026-07-25-ws-topology-spike.md`; throwaway/minimal scaffolding in `apps/api` + `apps/web` that either becomes Task 1/2/5's foundation (if DO-in-api works) or is documented and reverted (if pivot).

**Goal:** Prove, end to end, that a browser WebSocket reaches a Durable Object through the two-Worker topology, and that a server-initiated push reaches the browser — **under `wrangler dev`** (the e2e environment), for the **DO-in-`api`** design.

- [ ] **Step 1: Minimal NotifyDO stub** in `apps/api/src/durable-objects/NotifyDO.ts`: `fetch()` → if `Upgrade: websocket`, `const [client, server] = Object.values(new WebSocketPair()); this.ctx.acceptWebSocket(server); return new Response(null, { status: 101, webSocket: client });`. Add a `webSocketMessage(ws, msg)` that echoes, and a `push()` RPC that sends `{type:"notification"}` to every `this.ctx.getWebSockets()`. Export it from `src/index.ts`. Add the `NOTIFY` binding + `new_sqlite_classes: ["NotifyDO"]` migration (tag `v2`) to `wrangler.jsonc`; run `wrangler types`.
- [ ] **Step 2: Minimal api route** `GET /notifications/ws` (temporarily unauthed for the spike) → `return env.NOTIFY.getByName("spike-user").fetch(request)`. Register in `ROUTES`.
- [ ] **Step 3: Minimal web proxy** `apps/web/src/pages/api/notifications-ws.ts` → forward the upgrade to `api` over the Service Binding: `return env.API.fetch(...)` with the `Upgrade` request. Determine the exact Astro form that returns a `101`+`webSocket` (this is the Astro-side unknown).
- [ ] **Step 4: Prove it.** Start the two-Worker `wrangler dev` (the `playwright.config.ts` webServer commands, or run manually). From a browser console (or a tiny Playwright script) at `http://127.0.0.1:8787`: `const ws = new WebSocket("ws://127.0.0.1:8787/api/notifications-ws"); ws.onmessage = e => console.log("recv", e.data)`. Confirm: (a) the socket OPENs (101 round-tripped browser→web→SB→api→DO), (b) an echo returns when the client sends, (c) a **server-initiated** `push()` (trigger it via a temporary api route or a DO alarm) arrives at the browser.
- [ ] **Step 5: Record the outcome** in the spike doc: DID the Service Binding carry the WS? DID Astro return the 101? Latency? Any wrangler-dev quirks. **Decision: DO-in-`api` (proceed as written) or PIVOT (DO-in-`web` + cross-script binding).** If pivot, document the exact reason (which hop failed) and the adjusted topology.
- [ ] **Step 6: Hand back to the controller.** Report the decision + the working minimal code. The controller confirms the topology and (if DO-in-api) keeps the scaffolding as Task 1/2/5's starting point; if pivot, re-scopes those tasks. Do NOT proceed to Task 1 without controller confirmation.

**No commit gate:** commit the spike doc; keep or revert scaffolding per the controller's call. This task's "test" is the manual round-trip proof recorded in the spike doc.

---

### Task 1: `NotifyDO` (real) + binding + migration + tests

**Files:**
- Finalize: `apps/api/src/durable-objects/NotifyDO.ts`
- Modify: `apps/api/wrangler.jsonc`, `src/worker-configuration.d.ts` (regen), `src/index.ts`
- Test: `apps/api/test/notify-do.test.ts`

**Interfaces:**
- Produces: `class NotifyDO extends DurableObject<Env>` with `fetch(request): Promise<Response>` (WS upgrade → 101) and `push(kind: "notification" | "read"): void` (RPC — sends `{type:kind}` to every open socket). Binding `NOTIFY` (`DurableObjectNamespace<NotifyDO>`), addressed `env.NOTIFY.getByName(userId)`.

- [ ] **Step 1: Write the failing DO test.** `apps/api/test/notify-do.test.ts` (pool project; mirror `test/user-security-do.test.ts` for the DO harness + the cloudflare docs' WS pattern):

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Open a hibernatable client socket to a user's NotifyDO and collect messages. */
async function connect(userId: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const stub = env.NOTIFY.getByName(userId);
  const resp = await stub.fetch("https://do/ws", { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("expected a webSocket");
  ws.accept();
  const messages: string[] = [];
  ws.addEventListener("message", (e) => messages.push(e.data as string));
  return { ws, messages };
}

describe("NotifyDO", () => {
  it("101s a WebSocket upgrade and pushes a content-free nudge to a connected socket", async () => {
    const { ws, messages } = await connect("user-a");
    await env.NOTIFY.getByName("user-a").push("notification");
    // allow the frame to arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toContain(JSON.stringify({ type: "notification" }));
    expect(messages.join()).not.toContain("actor"); // no content on the wire
    ws.close();
  });

  it("broadcasts to MULTIPLE sockets on the same user's DO", async () => {
    const a = await connect("multi");
    const b = await connect("multi");
    await env.NOTIFY.getByName("multi").push("read");
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages).toContain(JSON.stringify({ type: "read" }));
    expect(b.messages).toContain(JSON.stringify({ type: "read" }));
    a.ws.close(); b.ws.close();
  });

  it("426s a non-upgrade request", async () => {
    const resp = await env.NOTIFY.getByName("x").fetch("https://do/ws");
    expect(resp.status).toBe(426);
  });
});
```
(If `runInDurableObject`/`evictDurableObject` fits better for the eviction case, add a hibernation-survival test: connect → `evictDurableObject(stub)` → `push` → the socket still receives — the cloudflare docs' `test/eviction-websockets.test.ts` pattern.)

- [ ] **Step 2: Run → FAIL** (`NOTIFY` binding / class not present). `pnpm --filter @thinkersjournal/api test notify-do`

- [ ] **Step 3: Implement the DO.** `apps/api/src/durable-objects/NotifyDO.ts`:

```ts
/**
 * NotifyDO (M2.3b) — one Durable Object per USER (getByName(userId)). A dumb,
 * content-free relay for realtime notification nudges. It holds hibernating
 * WebSockets (Hibernation API → ~zero idle cost) and, on a push() RPC from the
 * api handlers, sends a tiny {type} frame to every open socket. It is NOT a
 * security boundary (auth happens at the /notifications/ws route before the DO)
 * and stores NOTHING — new_sqlite_classes is a platform requirement, not storage.
 */
import { DurableObject } from "cloudflare:workers";

export class NotifyDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    // acceptWebSocket (NOT server.accept()) so the DO can hibernate with the
    // socket open and still deliver push() after eviction.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by api handlers (same-worker RPC). Content-free: no ids, no counts. */
  push(kind: "notification" | "read"): void {
    const frame = JSON.stringify({ type: kind });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        /* a dead socket is harmless; hibernation/close-reply reaps it */
      }
    }
  }

  // The client only sends keepalives; nothing to do. (No addEventListener — the
  // hibernation API uses these handler methods.)
  webSocketMessage(): void {}
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // auto-reply-to-close handles the protocol; nothing to persist.
  }
}
```

Add to `wrangler.jsonc` (beside `USER_SECURITY`): the `NOTIFY` binding and a `migrations` entry `{ "tag": "v2", "new_sqlite_classes": ["NotifyDO"] }`. Run `wrangler types` (explicit `./src/worker-configuration.d.ts`), stage the regen. Add `export { NotifyDO } from "./durable-objects/NotifyDO";` to `src/index.ts`.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test notify-do` + `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/durable-objects/NotifyDO.ts apps/api/src/index.ts apps/api/wrangler.jsonc apps/api/src/worker-configuration.d.ts apps/api/test/notify-do.test.ts
git commit -m "feat(m2.3b): NotifyDO — per-user hibernating WebSocket relay + binding/migration"
```

---

### Task 2: `GET /notifications/ws` — authed upgrade route

**Files:**
- Create: `apps/api/src/routes/notifications-ws.ts`, `apps/api/test/notifications-ws.test.ts`
- Modify: `apps/api/src/routes.ts`, `apps/api/test/error-envelope.test.ts`

**Interfaces:**
- Consumes: `readCurrentSession` (`../auth/pipeline`), `checkOrigin` (`../auth/csrf`), `errorResponse`, `env.NOTIFY`.
- Produces: `handleNotificationsWs` at `GET /notifications/ws` — origin-checked, session-authed; forwards the upgrade to `env.NOTIFY.getByName(session.userId).fetch(request)`. 403 bad origin, 401 no session, 426 no upgrade.

- [ ] **Step 1: Write failing tests.** `apps/api/test/notifications-ws.test.ts` (pool; use the actor fixtures + a spy on the DO stub via a modified `env`, mirroring `purge-wiring.test.ts`'s `{...env, WEB: stub}` idiom):

```ts
// … cloudflare:test imports, worker, createVerifiedActor/onboardedActor …

function wsReq(actor?: { cookie: string }, origin = "http://localhost:8787"): Request {
  const h: Record<string, string> = { Upgrade: "websocket", Origin: origin };
  if (actor) h.Cookie = actor.cookie;
  return new Request("https://api.test/notifications/ws", { headers: h });
}

describe("GET /notifications/ws", () => {
  it("401s LOGIN_REQUIRED without a session", async () => {
    const r = await fetchWorker(wsReq());
    expect(r.status).toBe(401);
  });
  it("403s a cross-site Origin (WS-hijack guard)", async () => {
    const actor = await onboardedActor();
    const r = await fetchWorker(wsReq(actor, "https://evil.example"));
    expect(r.status).toBe(403);
  });
  it("426s a valid session without an Upgrade header", async () => {
    const actor = await onboardedActor();
    const r = await fetchWorker(
      new Request("https://api.test/notifications/ws", {
        headers: { Cookie: actor.cookie, Origin: "http://localhost:8787" },
      }),
    );
    expect(r.status).toBe(426);
  });
  it("routes a valid upgrade to the caller's OWN DO (getByName(session.userId))", async () => {
    const actor = await onboardedActor();
    // Spy: replace env.NOTIFY with a stub recording the name it was addressed by.
    let addressed: string | null = null;
    const notify = { getByName: (id: string) => { addressed = id; return { fetch: async () => new Response(null, { status: 101 }) }; } };
    const ctx = createExecutionContext();
    const r = await worker.fetch(wsReq(actor), { ...env, NOTIFY: notify } as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(101);
    expect(addressed).toBe(actor.userId); // never a client-supplied id
  });
});
```

- [ ] **Step 2: Run → FAIL** (route unregistered → 404), then **Step 3: implement** `apps/api/src/routes/notifications-ws.ts`:

```ts
/**
 * GET /notifications/ws — the authenticated WebSocket upgrade for the realtime
 * bell (M2.3b). Resolves userId from the SESSION only (never a client param), so
 * a caller can attach to none but their OWN NotifyDO. Origin-checked because a
 * WebSocket carries cookies and is not covered by CORS (WS-hijack guard). NOT in
 * the mutating pipeline — it is a GET that authenticates inline, like /auth/csrf.
 */
import { checkOrigin } from "../auth/csrf";
import { readCurrentSession } from "../auth/pipeline";
import { errorResponse } from "../http/errors";

export async function handleNotificationsWs(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!checkOrigin(request)) return errorResponse("FORBIDDEN", 403);
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  return env.NOTIFY.getByName(session.userId).fetch(request);
}
```
(Confirm `checkOrigin`'s exact signature/return in `src/auth/csrf.ts` — it may take `(request)` or `(request, env)`; match it. If it returns a Response rather than a boolean, adapt.)

Register in `src/routes.ts` (beside `/notifications/unread-count`, a session-read GET):
```ts
  // Realtime bell upgrade (M2.3b) — authed WS, forwarded to the caller's NotifyDO.
  { method: "GET", pattern: "/notifications/ws", handler: handleNotificationsWs },
```
Add the `error-envelope.test.ts` CASES entry (401 no session):
```ts
  { name: "401 notifications ws no session", route: "GET /notifications/ws",
    build: () => new Request("https://api.test/notifications/ws", { headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN } }) },
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test notifications-ws error-envelope route-protection`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/notifications-ws.ts apps/api/src/routes.ts apps/api/test/notifications-ws.test.ts apps/api/test/error-envelope.test.ts
git commit -m "feat(m2.3b): GET /notifications/ws — origin+session-authed upgrade to the caller's NotifyDO"
```

---

### Task 3: `notify()` seam extension — push on write

**Files:**
- Modify: `apps/api/src/notifications/create.ts`, `src/routes/{comments,reactions,follows}.ts`
- Test: `apps/api/test/{comments,reactions,follows}.test.ts` (additive push-spy assertions)

**Interfaces:**
- `notify(client, env, ev): Promise<void>` — gains `env`; after the row `INSERT`, fire-and-forget `env.NOTIFY.getByName(ev.recipientId).push("notification")`, swallowed on failure. Self-events still return early (no insert, no push).

- [ ] **Step 1: Write failing tests.** In each of `comments/reactions/follows.test.ts`, add a case driving the Worker with a spied `NOTIFY` and asserting the recipient's DO `push("notification")` was called (and NOT for a self-event). Pattern (comments):

```ts
it("pushes a realtime nudge to the recipient's NotifyDO after a comment", async () => {
  const pushed: Array<{ id: string; kind: string }> = [];
  const notify = { getByName: (id: string) => ({ push: (kind: string) => { pushed.push({ id, kind }); }, fetch: async () => new Response() }) };
  const poster = await onboardedActor();
  const commenter = await onboardedActor();
  const p = await insertPost(poster.userId, "published");
  const ctx = createExecutionContext();
  await worker.fetch(
    new Request("https://api.test/comments", { method: "POST", headers: mutatingHeaders(commenter), body: JSON.stringify({ postId: p, markdownSource: "hi" }) }),
    { ...env, NOTIFY: notify } as never, ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(pushed).toEqual([{ id: poster.userId, kind: "notification" }]);
});
```
(Follows/reactions analogous. Add a self-action case asserting `pushed` is empty.)

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.** In `create.ts`:
```ts
interface NotifyEnv { NOTIFY: { getByName(id: string): { push(kind: "notification" | "read"): void } } }

export async function notify(client: NotifyClient, env: NotifyEnv, ev: NotifyEvent): Promise<void> {
  if (ev.recipientId === ev.actorId) return;
  try {
    await client.query(/* … unchanged INSERT … */);
  } catch (err) {
    console.error("notify failed", { kind: ev.kind, err });
    return; // if the row didn't persist, don't push a phantom nudge
  }
  try {
    env.NOTIFY.getByName(ev.recipientId).push("notification");
  } catch (err) {
    console.error("notify push failed", { kind: ev.kind, err });
  }
}
```
(Type `env` minimally so a test stub satisfies it; the real `Env.NOTIFY` is assignable. If TS friction, type it `Env`.) Update the four call sites to `await notify(c, env, {...})` — `env` is in scope in all three handlers.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test comments reactions follows purge-wiring notifications` + `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/notifications/create.ts apps/api/src/routes/comments.ts apps/api/src/routes/reactions.ts apps/api/src/routes/follows.ts apps/api/test/comments.test.ts apps/api/test/reactions.test.ts apps/api/test/follows.test.ts
git commit -m "feat(m2.3b): notify() pushes a realtime nudge to the recipient's NotifyDO"
```

---

### Task 4: mark-read cross-tab read-sync push

**Files:** Modify `apps/api/src/routes/notifications.ts` (`handleMarkRead`); test in `apps/api/test/notifications.test.ts`.

**Interfaces:** after the mark-read `UPDATE`, `env.NOTIFY.getByName(session.userId).push("read")` (swallowed) so the caller's other tabs refresh.

- [ ] **Step 1: Failing test** — mark-read drives the Worker with a spied `NOTIFY`; assert `push("read")` on the caller's own id.
- [ ] **Step 2: Run → FAIL,** **Step 3: implement** — after the `withClient` UPDATE in `handleMarkRead`, add (swallowed):
```ts
  try { env.NOTIFY.getByName(userId).push("read"); } catch (err) { console.error("read push failed", err); }
```
- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test notifications error-envelope` + the FULL api suite + `pnpm typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat(m2.3b): mark-read nudges the caller's NotifyDO for cross-tab read-sync"`

---

### Task 5: web WS proxy (form per Task 0)

**Files:** Create `apps/web/src/pages/api/notifications-ws.ts`, `apps/web/test/notify-ws-proxy.test.ts`.

**Interfaces:** forwards the browser's WS upgrade to `api`'s `/notifications/ws` over the `API` Service Binding, carrying `Cookie` + `Origin`, returning the `101`+`webSocket`. Exact form set by Task 0 (Astro route vs hand-written passthrough).

- [ ] **Step 1: Failing source test.** `apps/web/test/notify-ws-proxy.test.ts`:
```ts
const code = stripComments(readFileSync(join(DIR, "notifications-ws.ts"), "utf8"));
it("forwards the upgrade to /notifications/ws over the API binding, carrying cookie + origin", () => {
  expect(code).toContain("/notifications/ws");
  expect(code).toContain("Upgrade");        // preserves the upgrade
  expect(code).toContain("Cookie");         // forwards the session cookie
  expect(code).toContain("Origin");         // forwards the origin for the WS-hijack guard
});
it("is prerender=false", () => { expect(code).toContain("export const prerender = false"); });
```
- [ ] **Step 2: Run → FAIL,** **Step 3: implement** per Task 0's proven form. Representative (Astro route returning the api's 101 verbatim):
```ts
import type { APIRoute } from "astro";
export const prerender = false;
export const ALL: APIRoute = async (context) => {
  // Forward the upgrade to api over the Service Binding, preserving Upgrade +
  // Cookie + Origin so api can auth the session and origin-check the WS. Return
  // the api's 101 + webSocket verbatim to the browser.
  const env = context.locals.runtime.env as { API: { fetch: typeof fetch } };
  return env.API.fetch("https://api.internal/notifications/ws", {
    headers: context.request.headers, // carries Upgrade, Cookie, Origin
  });
};
```
(⚠️ The exact `locals.runtime.env.API` access + whether Astro returns the 101 is what Task 0 pins; adapt to the proven form. If Task 0 required a hand-written passthrough instead of an Astro route, this file is that.)
- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test notify-ws-proxy page-cache-inventory` (the inventory guard: a WS proxy returns a 101 and calls no cache helper — if SWEEP A requires exactly one cache helper per `src/pages` file, add an allowlist entry OR a defensive `markPrivate` guarded to the non-101 path; resolve per the guard's actual rule, do not weaken it). `pnpm --filter @thinkersjournal/web build` + `pnpm typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat(m2.3b): web WS proxy — forwards the bell upgrade to api over the Service Binding"`

---

### Task 6: client WS lifecycle in the bell

**Files:** Modify `apps/web/src/scripts/notify-bell.ts`; test in `apps/web/test/notify-bell.test.ts`.

**Interfaces:** the bell opens a WS to `/api/notifications-ws` when signed in; `onmessage` → `refreshCount` (+ reload the list if the dropdown is open); reconnect with exponential backoff; the poll is retained as fallback.

- [ ] **Step 1: Failing source tests** (append to `notify-bell.test.ts`):
```ts
it("opens a WebSocket to the notifications WS endpoint", () => {
  expect(code).toContain("WebSocket("); // positive anchor
  expect(code).toContain("/api/notifications-ws");
});
it("refreshes on a pushed nudge and keeps the poll as fallback", () => {
  expect(code).toContain("onmessage"); // or addEventListener("message"
  expect(code).toContain("setInterval"); // poll retained
});
it("reconnects with backoff and still builds DOM safely", () => {
  expect(code).toContain("reconnect"); // greppable intent
  expect(code).not.toContain("innerHTML");
});
```
- [ ] **Step 2: Run → FAIL,** **Step 3: implement.** Add a socket lifecycle to `initNotifyBell()`: derive the ws URL from `location` (`location.protocol === "https:" ? "wss" : "ws"` + host + `/api/notifications-ws`); open only after the first count-200 (signed-in signal); `ws.onmessage` → `void refreshCount(bell, badge)` and, if `!panel.hidden`, reload the list; `ws.onclose`/`onerror` → schedule a reconnect with exponential backoff (start ~1s, cap ~30s), guarded so only one socket is live. Keep the existing `poll()` on load / visibility / interval (the fallback). No change to the content-free handling — the nudge triggers a refetch, never a render.
- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test notify-bell` + `pnpm --filter @thinkersjournal/web build` (island externalizes) + full web + `pnpm typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat(m2.3b): bell opens a WebSocket, refreshes on push, reconnects; poll retained as fallback"`

---

### Task 7: E2E — the realtime spine

**Files:** Create `e2e/notifications-realtime.spec.ts`.

**Interfaces:** two browser contexts across both Workers + real Postgres + the DO, under the `wrangler dev` setup Task 0 proved.

- [ ] **Step 1: Write the spec.** A logs in on any page (the bell mounts + the WS connects); B logs in, chooses a handle, comments on A's post; **A's badge shows "1" within a few seconds** — asserted with a short Playwright timeout (e.g. `expect(...).toHaveText("1", { timeout: 8000 })`), which resolves far faster than the 60s poll and with no tab-visibility change, so only the WS push could have delivered it. Then read-sync: open a SECOND A context (second tab, same session cookie — or assert on the first), A reads in one, the other's badge clears live. Keep the poll-delivered discipline note in the header (miniflare has no Workers Cache; these are no-store).
  > ⚠️ The "faster than the poll proves it was the WS" isolation: the interval poll is 60s and no `visibilitychange` fires on an already-open focused tab, so a badge appearing in <8s could only be the push. State this in a comment.
- [ ] **Step 2: Run.** `docker compose up -d db` → `pnpm --filter @thinkersjournal/api run migrate` (no NEW pg migration this milestone — 0005 already covers notifications; the DO migration is a wrangler migration wrangler-dev applies) → `pnpm run test:e2e`. Target 17/17 (16 baseline + 1). Two consecutive clean runs. Auto-waiting only.
- [ ] **Step 3: Reconcile** any baseline collision by scoping selectors, never weakening.
- [ ] **Step 4: Commit.** `git commit -m "test(m2.3b): e2e realtime spine — comment → recipient's bell updates live via WebSocket"`

---

## Milestone-end (controller, not a task)

Green sweep (controller runs it): `pnpm typecheck` · fresh web build then `pnpm -r test` · `check:workerd` · `pnpm run test:e2e` ×2 · docker healthy. Then the whole-branch adversarial review (lenses: **WS auth / per-user isolation** [can a caller reach another user's DO?], **origin / WS-hijack**, **notify-never-throws + push-failure-isolation**, **content-leak on the wire** [does any frame carry ids/counts?], **DO lifecycle / hibernation correctness**, **cache-leak on the bell island**), fix wave, CI-gated PR.

## Self-review notes (already applied)

- **Spec coverage:** §4 spike → Task 0 (gate); §5 DO → Task 1; §6 WS route → Task 2, notify push → Task 3, mark-read push → Task 4; §7 web proxy → Task 5, client → Task 6; §8 security woven (origin+session in Task 2, isolation test, content-free assertion in Task 1); §9 tests per-task + Task 7 e2e.
- **Topology risk:** Task 0 is a hard gate; the plan commits to DO-in-api and flags the DO-in-web pivot points (Tasks 1/2/5) for controller re-scoping if the spike fails. Tasks 3/4/6/7 are topology-independent.
- **Type consistency:** `push(kind)` signature is `"notification" | "read"` everywhere (DO, notify, mark-read, tests); the WS route addresses `getByName(session.userId)`; the client hits `/api/notifications-ws` matching the web proxy filename.
- **Placeholder scan:** the one genuinely deferred detail (the exact Astro-vs-passthrough form of the web proxy, and the `checkOrigin` signature) is explicitly pinned to Task 0 / a one-line confirmation, not left vague in an implementation step.

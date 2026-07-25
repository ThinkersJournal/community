# M2.3b Task 0 — WebSocket topology connectivity spike

**Date:** 2026-07-25
**Branch:** `m2-3b-realtime-bell`
**Status:** DONE — decision reached.
**Design it gates:** `docs/superpowers/specs/2026-07-24-m2-3b-realtime-notification-bell-design.md` §4.

---

## DECISION: **DO-in-`api` — proceed as planned. No pivot.**

The full production-shaped round-trip works end to end under `wrangler dev`, **including
the server-initiated push**. The pivot to DO-in-`web` is unnecessary — the one fact that
would have forced it (the Service Binding refusing to carry a WebSocket) is disproven.

---

## The one question, answered

> Can a browser WebSocket reach a Durable Object through the two-Worker topology, and does
> a server-initiated push reach the browser — under `wrangler dev`, for the DO-in-`api` design?

**Yes to all three legs.** Verified with a real Chromium browser (Playwright) driving the full
path, repeated across 4 back-to-back runs with identical results:

```
browser (ws://127.0.0.1:8787/api/notifications-ws)
  → web Worker :8787  (Astro APIRoute)
    → env.API.fetch(...)  (Service Binding, cross-process dev registry)
      → api Worker :8788  GET /notifications/ws
        → env.NOTIFY.getByName("spike-user").fetch(request)
          → NotifyDO.fetch → acceptWebSocket(server) → 101 + webSocket(client)
  ← 101 relayed back out through both Workers to the browser
```

| Leg | Result | Latency (warm) |
|---|---|---|
| **(a) Socket OPEN** — 101 round-trips browser→web→SB→api→DO→back | ✅ works | ~14–60 ms (first/cold ~160 ms) |
| **(b) Echo** — client sends, DO echoes from `webSocketMessage` | ✅ works | a few ms |
| **(c) Server push** — plain HTTP `GET :8788/notifications/ws-push` triggers `NotifyDO.push()`, frame reaches the still-open browser socket **through the whole topology** | ✅ works | ~21 ms from HTTP trigger to browser frame |

Push was verified arriving **on its own** (idle socket, no client activity) — not merely
flushed by a later client message.

---

## Findings hop by hop

### 1. Service Binding carries the WebSocket — both directions, including async server frames
`env.API.fetch()` (the `web → api` Service Binding, resolved cross-process by wrangler's dev
registry) forwards a WS **upgrade** to the api, and the api's `env.NOTIFY.getByName(...).fetch()`
forwards it again to the DO. The 101 + `webSocket` comes back out through the binding. Crucially,
a **server-initiated** `ws.send()` from a *separate* DO invocation (the `push()` RPC, triggered by
an unrelated HTTP request) also traverses the binding back to the browser. This is the platform
fact the docs did not explicitly confirm for the cross-Worker hop — it holds under `wrangler dev`.

### 2. The Astro-101 finding — **reconstruction required, passthrough fails**
`@astrojs/cloudflare@14.1.3` on `astro@7.0.9` will **not** return a raw upstream `101`+`webSocket`
Response verbatim. Returning `upstream` straight through produced:

```
WebSocket handshake: Unexpected response code: 500
```

even though the proxy logged `upstream.status=101 hasWebSocket=true` (i.e. the Service Binding *did*
hand back a valid 101 with a client socket). The adapter reconstructs the outgoing Response and
loses the `webSocket` field.

**What works:** hand-reconstruct a fresh 101 carrying the client socket:

```ts
const ws = (upstream as unknown as { webSocket?: unknown }).webSocket;
if (upstream.status === 101 && ws) {
  return new Response(null, { status: 101, webSocket: ws } as ResponseInit);
}
return upstream;
```

This is the exact form in `apps/web/src/pages/api/notifications-ws.ts`. `export const prerender = false;`
is set. `env` is imported from `cloudflare:workers` (NOT `Astro.locals.runtime.env`, removed in Astro v6+),
matching `apps/web/src/lib/api.ts`. `apiFetch` from `src/lib/api.ts` **cannot** be reused here because it
reads the whole response body as text, which would consume/destroy the 101.

### 3. The DO — Hibernation API works as documented
`acceptWebSocket(server)` + `return new Response(null, { status: 101, webSocket: client })` for the
upgrade; `webSocketMessage` for the echo; `push(kind)` iterates `this.ctx.getWebSockets()` and
`ws.send(JSON.stringify({ type: kind }))`. `getWebSockets()` correctly returns the accepted socket
from the separate `push()` invocation (`length === 1`), and the send is delivered.

---

## `wrangler dev` quirks & red herrings (recorded so the e2e author is not misled)

The push initially *appeared* to fail. It did not — the topology was fine the whole time. Two
**test-harness** artifacts produced false negatives; both are easy to hit when writing the E2E:

1. **Baseline-capture race.** If the test snapshots the socket's received-frame count *after*
   triggering the push, the ~21 ms delivery has often already landed, so a "only look at frames
   after the baseline" assertion looks *past* the frame and times out. Capture the baseline
   **before** triggering the push. (This single mistake accounted for every "push failed" run.)
2. **Socket GC.** A `WebSocket` held only in a local variable inside a `page.evaluate` promise is
   eligible for garbage collection once that evaluate returns — Chromium then closes it, and a
   later push has nowhere to arrive. Pin it (`window.__ws = ws`) for the life of the test.

Neither is a platform limitation; both are properties of how the Playwright harness was written.

Other notes:
- The api's WS upgrade coming *in over the Service Binding* is **not** logged as a normal
  `GET /notifications/ws 101` line in the api's wrangler output (the request table doesn't surface
  it). Don't treat the missing log line as "the request never arrived" — the echo/push prove it did.
- Two-Worker startup order is load-bearing exactly as `playwright.config.ts` documents: api first
  (:8788), then web (:8787), or web's `API` binding comes up `[not connected]`. Confirmed: web
  logged `env.API (thinkersjournal-api) Worker local [connected]`.
- A source edit auto-reloads that Worker and **drops all DO state + open sockets** — expected; each
  test opens a fresh socket. Rebuilding `web` (`astro build`) must NOT run while any wrangler dev is
  alive (the build's workerd children disturb the dev registry) — the same trap the playwright
  config's header describes; the spike killed both Workers before every `web` rebuild.

---

## What was built (kept in the tree as Task 1/2/5's foundation)

Minimal, production-shaped scaffolding — **not** reverted, per the plan (controller confirms):

- `apps/api/src/durable-objects/NotifyDO.ts` — the DO (fetch/upgrade, echo `webSocketMessage`,
  `push(kind)` relay, no-op `webSocketClose`). Exported from `apps/api/src/index.ts`.
- `apps/api/wrangler.jsonc` — `NOTIFY` binding + migration `{ tag: "v2", new_sqlite_classes: ["NotifyDO"] }`;
  `src/worker-configuration.d.ts` regenerated (`NOTIFY: DurableObjectNamespace<NotifyDO>`).
- `apps/api/src/routes/notifications-ws.ts` + `ROUTES` entries — `GET /notifications/ws` and the
  spike-only `GET /notifications/ws-push`.
- `apps/web/src/pages/api/notifications-ws.ts` — the reconstruction proxy over the Service Binding.

Both `apps/api` (`tsc --noEmit`) and `apps/web` (`astro check`) typecheck clean (0 errors).

### ⚠️ Spike shortcuts that Tasks 1/2/5 MUST replace before this ships
- **`GET /notifications/ws` is UNAUTHED** and hard-wired to a fixed `"spike-user"` DO. Task 2 must
  resolve `userId` from the session (`readCurrentSession`) + an `Origin` check (WS-hijack guard) and
  route to the caller's **own** DO — no client-supplied id may reach `getByName`.
- **`GET /notifications/ws-push` is a spike-only trigger** — delete it; Task 5 wires the real push
  from `notify()` / `handleMarkRead`.
- The echo `webSocketMessage` becomes a keepalive no-op in the real DO.
- These spike routes are **not** in the mutating pipeline and were not added to
  `route-protection.test.ts` / `error-envelope.test.ts` inventories (the compensating-control tests
  were not run for the spike); Task 2 gives `/notifications/ws` its `CASES` / route-protection
  treatment as a session-read GET.

### Note for the E2E (design §9)
The live-badge assertion is observable locally — the push delivers in ~21 ms under `wrangler dev`.
Write it to capture the pre-push state first and keep the socket referenced (see the two red
herrings above), and it will resolve well inside a poll interval.

# M2.3b — Realtime notification bell (design)

**Date:** 2026-07-24
**Status:** approved design; feeds into an implementation plan (`docs/superpowers/plans/`).
**Milestone context:** third slice of the M2.3 (Notifications) decomposition:

- **M2.3a — Notification core (poll-delivered)** — ✅ merged (PR #6).
- **M2.3b — Realtime notification bell** ← *this doc*. Upgrades the M2.3a bell from a 60s poll to a live WebSocket push, per-user, via a Durable Object using the Hibernation API. Establishes the shared WS topology.
- **M2.3b-live — Live post engagement** — the founder wants live comments/reactions on the *post page* too (a per-**post** DO, distinct from this per-**user** DO, with its own edge-cache/anonymity interplay). Decomposed out as its own spec→plan→build; it reuses the WS topology this milestone proves.
- **M2.3c — Email notifications** — instant high-signal + Cron digests.

The founder chose to build the two realtime surfaces as separate sub-milestones (bell first): the bell is smaller, consumes the existing `notify()` seam directly, and de-risks the WS plumbing before the harder per-post work.

---

## 1. Goal

Someone engages with your content (comment / reply / reaction / follow) → your nav bell updates within *moments*, not up to the 60 seconds the M2.3a poll allows. Reading notifications in one tab clears the badge live in your other open tabs. The bell continues to work (via the existing poll) when the socket is unavailable.

## 2. Scope (what ships in M2.3b)

1. **`NotifyDO`** — one Durable Object per user (`getByName(userId)`), holding hibernating WebSocket connections and relaying tiny "refresh" nudges.
2. **An authed WS endpoint** — `GET /notifications/ws` on `api` (session → userId → the caller's own DO), fronted by a `web` proxy that forwards the upgrade over the Service Binding.
3. **Push wiring** — `notify()` pings the recipient's DO after writing the row; `handleMarkRead` pings the caller's DO (cross-tab read-sync).
4. **Client** — the bell opens a WS, refreshes on a nudge, reconnects with backoff, and **keeps the 60s poll as a fallback**.

Explicitly **out of scope** (see §10): the Queue (inline DO ping suffices pre-launch), presence/"who's online", live comments/reactions on the post page (M2.3b-live), email (M2.3c), pushing notification *content* over the wire.

## 3. Locked decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| 1 | **Decompose** the two realtime surfaces; bell first | Per-user notification push and per-post live engagement are independent subsystems (different DO keying, client, audience, cache interplay). Bell is smaller, reuses `notify()`, and proves the WS topology. |
| 2 | The DO pushes a **bare nudge**; the client refetches | The DO stays a dumb stateless relay; the client remains fully authoritative via the existing `GET /notifications*` reads. One cheap count-fetch per event. No notification content on the wire → nothing to leak. |
| 3 | **Mark-read also nudges** the caller's DO | Reading in one tab drops the badge in the others within moments — reuses the same nudge mechanism (one channel for new-notification push *and* read-sync). |
| 4 | **Poll stays as the fallback** | Standing decision #10: "DO + WebSocket (Hibernation) push + poll fallback; polling-only is an acceptable schedule-saver." WS drop → poll keeps working; no-WS environments degrade to exactly today's behavior. The bell works without the socket. |
| 5 | **Spike the topology first** (Task 0) | Whether a WS upgrade forwards across the `web → api` Service Binding is the one unverified platform fact and it decides where the DO lives. Prove it end-to-end (incl. local `wrangler dev`) before building the milestone. |
| 6 | **Inline DO ping**, no Queue | Architecture §9 assumed a Queue; at pre-launch volume `notify()` calling the DO directly is simpler and sufficient. Queue is a measured-scale item (§10). |
| 7 | The DO holds **no durable state / no content** | It is a WS relay, not a store and not a security boundary. Auth happens at the api route before the DO; a nudge carries no data. `new_sqlite_classes` per platform rules even though storage is unused. |

Inherited invariants still in force: `api` has **no public origin** — the browser only ever talks to `web`; `notify()` **never throws** (a push failure must not fail the comment/reaction/follow); the nav bell is a **client island** (no per-viewer state in the edge-cached nav HTML); all mutations run origin → session → CSRF → epoch; new DO namespaces use `new_sqlite_classes` + a migration `tag` (the `UserSecurityDO` precedent).

## 4. Topology — and the load-bearing spike (Task 0)

The browser connects only to `web`. The `NotifyDO` naturally belongs in `api` (hand-written TS Worker, matches `UserSecurityDO`, and `notify()` already runs there). That requires a **WebSocket upgrade to forward across the `web → api` Service Binding** — a fact the Cloudflare docs confirm for *same-Worker* Worker→DO forwarding but do **not** explicitly confirm for the cross-Worker hop.

**Task 0 is a ~half-day connectivity spike** proving, end to end:
`browser → web (WS upgrade) → env.API.fetch (Service Binding) → api /notifications/ws → NotifyDO.fetch → 101 + webSocket` round-trips, **and** a server-initiated `NotifyDO.push()` reaches the browser — verified **locally under `wrangler dev`** (so the e2e can exercise it) and consistent with the deploy model.

- **If it works → `NotifyDO` in `api`** (the primary design below). One Worker, clean, session auth already lives there.
- **If the Service Binding will not carry a WS → pivot to `NotifyDO` in `web`**: the client WS is then same-Worker forwarding (proven), and `api`'s `notify()` reaches the DO via a **cross-script DO binding** (`script_name: "thinkersjournal-web"`, officially supported). The wrinkle is defining a raw DO class inside the Astro `web` Worker; the spike's fallback branch settles how. Auth in that branch: `web` resolves the session's userId via a non-WS Service-Binding call to `api` before routing to the DO.

The rest of this spec assumes the **DO-in-`api`** outcome; the plan's Task 0 gate decides, and only the routing/binding location changes if it pivots — the DO logic, client, and push wiring are identical either way.

## 5. `NotifyDO` (`apps/api/src/durable-objects/NotifyDO.ts`)

A per-user relay addressed `env.NOTIFY.getByName(userId)`. It is **not** a security boundary and holds **no** notification content or durable state.

- `fetch(request)` — validates `Upgrade: websocket`, creates a `WebSocketPair`, `this.ctx.acceptWebSocket(server)` (Hibernation API → ~zero idle cost; hibernates across eviction), returns `new Response(null, { status: 101, webSocket: client })`. Multiple tabs/devices → multiple sockets on the one DO.
- `push(kind: "notification" | "read"): void` — RPC method called by `api` handlers; iterates `this.ctx.getWebSockets()` and `ws.send(JSON.stringify({ type: kind }))` to each open socket. Tiny, content-free.
- `webSocketMessage(ws, msg)` — the client sends only keepalive pings; ignore or no-op (the runtime handles pong at the protocol layer; a `web_socket_auto_response` ping/pong pair may be configured to keep hibernation cheap).
- `webSocketClose(ws, ...)` — no-op cleanup (hibernation + auto-close-reply handle it).
- No `constructor` storage seeding needed (unlike `UserSecurityDO`) — there is nothing to persist.

## 6. api surface (`apps/api`)

| Route / call | Auth | Notes |
|---|---|---|
| `GET /notifications/ws` (WS upgrade) | session via `readCurrentSession` + origin check | Resolves `userId` from the **session only** (never a client param), then `return env.NOTIFY.getByName(userId).fetch(request)` — forwards the upgrade to the caller's own DO. 401 `LOGIN_REQUIRED` without a session; 426 if not a WS upgrade; 403 on a bad Origin (WS-hijack guard). This is a GET that authenticates inline (like `/auth/csrf`, `/verify-email`) — it is **not** in the mutating pipeline. |
| `notify(client, env, ev)` (seam extension) | — | After the row `INSERT`, fire-and-forget `env.NOTIFY.getByName(ev.recipientId).push("notification")`, wrapped so a DO failure is swallowed (the write already committed; the M2.3a never-throws rule extends to the push). Signature gains `env`; the three callers (`handleCreateComment`, `handleAddReaction`, `handleFollow`) already have it. |
| `POST /notifications/read` (existing) | mutating pipeline (no verified-email) | After the mark-read `UPDATE`, `env.NOTIFY.getByName(userId).push("read")` so other tabs refresh. Same swallow-on-failure discipline. |

Wrangler: add the `NOTIFY` DO binding + a migration entry (`new_sqlite_classes: ["NotifyDO"]`, a new `tag`) to `apps/api/wrangler.jsonc`, then regenerate + commit `worker-configuration.d.ts` (the standing bindings rule). No new error codes; `LOGIN_REQUIRED` covers the WS auth failure. `/notifications/ws` needs its route-protection/error-envelope treatment: it is a GET that 401s without a session, so it gets a `CASES` entry like the other session-read GETs. The origin check **must NOT reuse `checkOrigin`** — *(as built, Task 2)* `checkOrigin` returns `true` for GET/HEAD before the allowlist, and a WS upgrade is a GET, so it would make the hijack guard a silent no-op. Task 2 extracted `isAllowedOrigin` (no method bypass) and the WS route uses that.

## 7. web proxy + client

- **`apps/web/src/pages/api/notifications-ws.ts`** (or the framework's WS-capable route): forwards the incoming WS upgrade to `api`'s `/notifications/ws` over the `API` Service Binding, carrying the `Cookie` (so `api` can resolve the session) and the `Origin`. Returns the `101` + `webSocket`. `markPrivate`/no-store is moot for a 101, but the file still declares `prerender = false`. ⚠️ **Whether an Astro API route on `@astrojs/cloudflare` can return a `101`+`webSocket` Response at all is itself part of the Task-0 spike** — if the adapter swallows/rejects a 101, the pivot is a hand-written passthrough in the web Worker (or the DO-in-`web` branch, where the WS never crosses the Astro boundary as a proxied 101). This route is the concrete exercise of the Task-0 capability, on the web side as well as the Service-Binding hop.
- **`apps/web/src/scripts/notify-bell.ts`** gains a socket lifecycle *(as built)*:
  - When signed in (the count-200 signal), open `new WebSocket` to the same-origin **`/api/notifications-ws`** (the web proxy route; `ws(s)://` derived from `location`). The `api`-side upgrade route is `/notifications/ws`; the browser only ever hits the web proxy.
  - `onmessage` → `refreshCount(...)` immediately; if the dropdown is open, reload the list.
  - `onclose`/`onerror` → **just drop the socket ref**; the signed-in poll re-arms it. *(Deviation from the original "exponential backoff" plan: the whole-branch review + Copilot both found a bespoke backoff/cap/latch error-prone — an expired session could reconnect forever, or a recovered one never re-arm. The poll is the single (re)connect trigger, gated on a FRESH signed-in count, so anonymous/dead sessions never open a socket and a recovered one re-arms within a poll interval.)*
  - **Poll fallback retained**: keep the on-load / on-visibility / interval poll — it is now also the reconnect driver, so it never stops.
  - All DOM stays `textContent`/`createElement` (unchanged); the WS message is a content-free nudge, so nothing user-derived is rendered from it.

## 8. Security & integrity

- **Per-user isolation is server-side**: the WS route derives `userId` from the session, so a caller can only ever attach to their *own* `NotifyDO`. No client-supplied id reaches `getByName`.
- **Nothing sensitive on the wire**: pushes are `{type:"notification"|"read"}` — no actor, no content, no counts. Even a mis-routed socket would learn only "something changed."
- **WS-hijack guard**: the upgrade validates `Origin` (cross-site WebSocket requests otherwise bypass CORS); use `isAllowedOrigin` — NOT `checkOrigin`, which bypasses GET (see §6, as built Task 2).
- **The push never affects the write**: `notify()`'s DO ping is swallowed on failure — a DO outage cannot fail or slow a comment/reaction/follow beyond the ping's own bounded latency.
- No per-viewer state enters cached HTML (unchanged — the bell is an island; the socket is client-initiated).

## 9. Testing strategy (TDD, per the SDD methodology)

- **Task 0 spike** is itself the first proof (a throwaway or minimal harness verifying the round-trip locally); its result gates the topology.
- **`NotifyDO`** (`cloudflare:test`, which supports WS + `evictDurableObject`): a connected socket receives a `push("notification")`; multiple sockets all receive; `push("read")` distinct type; a socket survives eviction (hibernation) and still receives; close cleans up.
- **WS route**: 401 without a session; 426 without an upgrade header; 403 on a bad Origin; a valid session routes to `getByName(session.userId)` (spy the DO stub).
- **Push wiring**: after `notify()`, the recipient's DO `push("notification")` is called (stub); a self-event pushes nothing (self-suppression already returns early); after mark-read, `push("read")` on the caller's DO.
- **Client**: source-structure tests — opens a WS to `/api/notifications/ws`, refreshes on message, reconnects with backoff, retains the poll fallback; DOM still `textContent`-only.
- **E2E**: two browser contexts — A on any page with the bell (WS connected) → B comments on A's post → **A's badge shows 1 live** (assert without relying on the 60s poll — the assertion resolves faster than a poll interval); then A opens the dropdown → reads → and (read-sync) a second A-tab's badge clears. Runs under the two-Worker `wrangler dev` setup the spike proved.

## 10. Deferred / roadmap

- **Cloudflare Queue** between `notify()` and the DO push — a scale decoupling (architecture §9); add only if the inline ping shows cost/latency under real traffic.
- **Presence / "who's online"** — not needed for notifications.
- **M2.3b-live — live comments/reactions on the post page** — the per-post realtime channel, its own spec (edge-cache/anonymity interplay), built on this milestone's proven WS topology.
- **M2.3c — email** — instant high-signal + Cron digests, preferences, unsubscribe, the `notify.` subdomain.
- **Pushing notification content** over the WS (vs the nudge) — only if a measured refetch cost justifies it.

## 11. Open questions

None outstanding — the one true unknown (Service-Binding WS forwarding) is explicitly resolved by the Task-0 spike gate, with a documented pivot, before the milestone builds on it.

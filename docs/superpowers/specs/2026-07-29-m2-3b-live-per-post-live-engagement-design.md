# M2.3b-live — Per-post live comments & reactions — Design

**Status:** approved design → spec (this doc)
**Milestone:** M2.3b-live (the deferred second half of M2.3b; the notification bell shipped as PR #8, merge `31c52ba`).
**Depends on:** M2.2 comments/reactions (data + islands + purge-on-write) · M2.3b realtime infra (the `NotifyDO` hibernating-relay pattern, the WS upgrade route shape, the `web` 101-reconstruction proxy, the `ctx.waitUntil`-delivered push seam) · M1 sanitize-first `renderMarkdown` (web-worker read-time rendering).

## 1. Goal

When someone comments or reacts on a post, **everyone currently viewing that post page** — logged in or not — sees it happen live, without reloading:

- A **new comment** slides into the thread at its correct position.
- An **edited comment**'s body updates in place (and shows "(edited)").
- A **deleted comment** becomes a `[deleted]` tombstone in place.
- **Reaction counts** (post and per-comment) tick up/down.

The client stays authoritative: the wire carries only a content-free nudge; the client fetches the real (server-rendered, sanitized) content itself.

## 2. Approved decisions

1. **Live-comment UX = auto-append/reconcile** (not a "refresh" banner). New comments appear automatically; edits/deletes reflect in place.
2. **Audience = everyone viewing, including anonymous.** The post is public, so its comments/reactions are public; the live channel is **unauthed but Origin-checked**, and nudges are content-free.
3. **DO topology = a separate `PostLiveDO`** (new class + binding + migration), NOT a reuse of `NotifyDO` — keeps the unauthed per-post channel isolated from the authed per-user bell and leaves shipped auth-critical code untouched.
4. **Edit + delete are live in v1** (reconcile-by-id, below), not deferred.

## 3. Architecture

```
 browser (post page, N viewers) ──WS──▶ web /api/posts-live ──SB──▶ api GET /posts/live?postId ──▶ PostLiveDO(postId)
                                                                                                         ▲
 comment/reaction write ──▶ api handler ──(after write+purge)──▶ ctx.waitUntil( POST_LIVE.getByName(postId).push(kind) )
```

- **`PostLiveDO`** (`apps/api/src/durable-objects/PostLiveDO.ts`) — a per-post, content-free WebSocket relay. Same Hibernation pattern as `NotifyDO`: `ctx.acceptWebSocket`, `push(kind: "comment" | "reaction"): void` broadcasts `JSON.stringify({type: kind})` to `this.ctx.getWebSockets()` (per-socket try/catch), `webSocketMessage` is a no-op (clients only keepalive), `fetch()` returns the 101 (or 426). Holds **no durable state** (relay only). New binding `POST_LIVE`; `new_sqlite_classes: ["PostLiveDO"]` + a new migration `tag`; exported from `src/index.ts`; `wrangler types` regenerated + committed.
- **`GET /posts/live?postId=<uuid>`** (`apps/api/src/routes/posts-live.ts`) — the WS upgrade, authenticating **inline like `/notifications/ws`** but **origin-only**:
  - `if (!isAllowedOrigin(env, request)) return errorResponse("FORBIDDEN", 403)` — the WS-hijack guard (WS carries cookies, bypasses CORS). Reuse `isAllowedOrigin` (NOT `checkOrigin`, which bypasses GET).
  - **No session read** — anyone may connect.
  - 426 if not a WebSocket upgrade (normalize the `Upgrade` token, case-insensitive).
  - `postId` from the query string; validate it is a well-formed uuid (400 `INVALID_INPUT` otherwise — do not forward a garbage name to the DO).
  - `return env.POST_LIVE.getByName(postId).fetch(request)`.
  - Route table: add to `ROUTES` (a GET that authenticates inline, not the mutating pipeline); add a `CASES` entry to `error-envelope.test.ts` (403 bad origin; 400 bad postId). `route-protection.test.ts` stays green.
- **`web` proxy `apps/web/src/pages/api/posts-live.ts`** — mirrors `notifications-ws.ts` exactly: `env.API.fetch("https://api.internal/posts/live?postId=…", { headers: context.request.headers })`, **hand-reconstruct the 101** (`new Response(null, {status:101, webSocket})`; the adapter won't pass a raw 101 through), forward headers wholesale, `markPrivate` on the non-101 paths, coerce a bare-101-without-webSocket to 502. `prerender = false`. The client passes `postId` as a query param on the WS URL.
- **Push trigger.** The four write handlers already own the post id and already `purgeTags(post:<id>)`:
  - `handleCreateComment`, `handleUpdateComment`, `handleDeleteComment` → `push("comment")`
  - `handleAddReaction`, `handleRemoveReaction` → `push("reaction")` — ⚠️ a reaction may target a **comment**, not the post; the channel is keyed on `postId`, so a comment-target reaction pushes to the **comment's post** channel. The handler already knows/derives that post id (a comment carries `post_id`); resolve it rather than pushing to the comment id.
  - Wrapped exactly like the M2.3b `notify()` seam: `ctx.waitUntil((async () => { try { await env.POST_LIVE.getByName(postId).push(kind); } catch (err) { console.error(...); } })())`, **gated on a real write** (only push when the mutation actually changed a row), never throws / never rolls back the write. Factor a tiny `notifyPostLive(env, ctx, postId, kind)` helper so the four sites stay one-liners.

## 4. Client: reconcile-by-id (the nuanced part)

The comment thread is server-rendered in **materialized-path order** (`ORDER BY c.path` — parents before children, path order IS thread order), cursor-paginated (`?comments=<path>`), PAGE_SIZE per page. Comment bodies are `renderMarkdown` output via `set:html` (the "third and FINAL set:html sink") — **the client must never render markdown itself.**

**A new `web` read endpoint `GET /api/comments-fragment?postId=<id>&cursor=<path>`** returns the *same window the page is currently showing* (the SSR used the page's `?comments=` cursor), but **rendered**: it fetches the window's comments (markdown) from `api`'s `comments-public` and runs each through the **same `renderMarkdown` pipeline the SSR uses**, returning per comment: `{ id, parentId, depth, path, authorUsername, authorName, createdAt, edited, deleted, html }`. `markPrivate`/no-store; public (no auth — public post). This is the ONLY new HTML source the client trusts, and it is the same sanitize-first output class as the existing `set:html` sinks.

**On a `comment` nudge**, a new client (`apps/web/src/scripts/comments-live.ts`, initialized alongside the existing comments island) fetches that fragment window and **reconciles by comment id** against the DOM (`[data-comment-id]` under `[data-comments]`):

- **Not in DOM** (a new comment whose path is within the window) → build the `<li>` with `createElement`/`textContent` for the chrome (meta line, actions slot, reaction chips placeholder) and set the body via `set:html`-equivalent (`innerHTML`) carrying **only the fragment endpoint's `html`** — the tightly-bounded 4th sink. Insert at the correct **path-ordered position** (walk siblings; a new top-level lands at the thread's end, a reply right after its parent's subtree). Add a subtle `data-new` treatment.
- **In DOM, now `deleted`** → replace its body with the `[deleted]` tombstone (matches the SSR tombstone), drop its actions/chips.
- **In DOM, `edited` (body/edited-flag changed)** → swap the body `html` and add the "(edited)" marker.
- **In DOM, unchanged** → skip.
- **Never remove a node.** Deletes are tombstones, not removals; pagination reconciles on navigation. A comment pushed past the window boundary by an insertion simply stays visible for the session (harmless over-count; corrected on next navigation). New comments *beyond* the current window (a later page) are not shown live — consistent with pagination.

**Do-not-disrupt rule:** if a comment currently has an **open edit or reply form** on it (the viewer is mid-interaction), **skip its in-place update/tombstone** this cycle and retry on the next nudge/interaction end — a live change must never yank the body out from under someone typing. Insertion must not move the viewport or steal focus (insert nodes without scrolling; no `focus()`).

**After reconcile, re-run the affordance wiring** for any newly-inserted comments (Reply/Edit/Delete), reusing the existing comments-island logic — factor the per-comment affordance wiring out of `comments.ts` so both the initial pass and the live pass share it (a small, in-scope refactor).

**On a `reaction` nudge**, the existing reactions island simply refetches `/api/reactions?postId=` and re-applies counts (`applyState`) — post and per-comment counts tick. No new rendering, no new sink; a small hook to let the live client trigger it.

## 5. Connection lifecycle (reuse M2.3b learnings)

The post-live socket reuses the **poll-free** version of the bell's final design where it fits, but the post page has no count-poll, so:

- Open the socket on page load (the post page is where it's needed) — but only build the DO connection **once the comments section exists** (`[data-comments]` present).
- **Single live socket**; on `close`/`error` **drop the ref** and reconnect with a **bounded** strategy: a short delayed reconnect, and — because there is no signed-in poll to lean on here — a small capped backoff (retry a few times, then stop; a manual refresh re-establishes on next navigation). Anonymous-friendly (no session needed to reconnect).
- Content-free `onmessage`: never parse anything user-derived beyond the `{type}` discriminator; a nudge only ever triggers the reconcile fetch (comment) or the counts refetch (reaction).
- Close the socket on `pagehide` is unnecessary (the browser tears it down on navigation); do not add lifecycle we don't need.

## 6. Security & integrity

- **Unauthed but Origin-checked** WS (`isAllowedOrigin`, no session): a cross-site page cannot open the socket (WS-hijack guard); the post is public so even connecting to an arbitrary `postId` channel leaks nothing (content-free nudges only).
- **Content-free wire:** `{type:"comment"|"reaction"}` — no ids, no bodies, no counts. Nothing user-derived is rendered from a frame.
- **The only client HTML sink** is the `/api/comments-fragment` endpoint's `renderMarkdown` output — the same sanitize-first safety class as the three existing `set:html` sinks. The client never `innerHTML`s anything else; all chrome is `createElement`/`textContent`.
- **Push never throws / never rolls back** the triggering write; gated on a real row change (an edit/delete/react that changed nothing pushes nothing); delivered via `ctx.waitUntil`.
- **DO holds no state**; `getByName(postId)` addresses a public id (no per-user data).

## 7. Scope / non-goals (v1)

- In: live new-comment, live edit, live delete (tombstone), live reaction counts — for viewers on the **currently-loaded comment window**.
- Out: showing comments that belong to a **different pagination page** live (they appear on navigation); live-removing nodes; presence/"who's here"; typing indicators; live for the feed/profile lists (only the post page).

## 8. Testing

- **api:** `PostLiveDO` (cloudflare:test, mirroring `notify-do.test.ts`: 101 + case-insensitive Upgrade, 426, real multi-socket broadcast of a content-free frame, per-socket failure isolation, `evictDurableObject` hibernation survival) · the `GET /posts/live` route (origin-checked, **no session required**, bad-origin→403, bad-postId→400, forwards to `getByName(postId)`) · the write-handler push wiring (each of the four handlers pushes on the post channel via `waitUntil`, swallowed, gated on a real write — a no-op edit/react pushes nothing).
- **web:** `/api/comments-fragment` (renders markdown → sanitized HTML for the window, `markPrivate`) · `posts-live.ts` proxy (source-structure: hand-reconstructed 101, wholesale headers, markPrivate, bare-101→502, no apiFetch) · `comments-live.ts` (source-structure + behavior where testable: content-free onmessage, reconcile-by-id insert/edit/tombstone, path-ordered insertion, `set:html` ONLY for fragment `html`, no innerHTML elsewhere, do-not-disrupt-open-forms, single-socket) · reactions live hook.
- **e2e:** two browser contexts on the **same** post page — B comments → A (no navigation) sees the comment appear live; B reacts → A's count ticks; B edits → A's body updates; B deletes → A sees the tombstone. Arm `waitForEvent("websocket")` before B acts (the content-free nudge is not replayed); assert observable DOM, never frame contents. Reuse Task 7's WS-e2e discipline + the `data-`-attribute-keyed resilience lesson from `toggleFollowTo`.

## 9. Build order (for the plan)

1. `PostLiveDO` + binding + migration + types + index export (spike-free — the WS topology is already proven by M2.3b).
2. `GET /posts/live` unauthed origin-checked route + route-protection/error-envelope.
3. `web` `posts-live.ts` proxy (finalize the proven 101 form).
4. `notifyPostLive()` seam + wire the four write handlers (push, gated, waitUntil).
5. `GET /api/comments-fragment` web endpoint (renders the window).
6. Factor per-comment affordance wiring out of `comments.ts` (shared by initial + live).
7. `comments-live.ts` — socket lifecycle + reconcile-by-id + do-not-disrupt + reaction hook.
8. e2e realtime spine (two tabs on one post).

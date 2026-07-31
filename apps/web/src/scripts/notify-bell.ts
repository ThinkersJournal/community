/**
 * THE NAV BELL ISLAND — hydrates the hidden `[data-notify-bell]` placeholder
 * that ships with every cached page (Nav.astro). The placeholder's SSR default
 * is HIDDEN (cache-safe: the nav is shared across every viewer, so it can
 * carry no per-viewer state). This runs client-side and:
 *
 *  1. Detects "signed in" via `/api/notifications-count`'s status code alone
 *     (200 → signed in, anything else → anonymous/degraded) — deliberately
 *     NOT an extra `/api/me` round trip just to check login state (deviation
 *     2, see the task brief). Reveals the bell + badge only on 200.
 *  2. On click, loads `/api/notifications`, collapses it with
 *     `collapseNotifications` and renders each group's copy with
 *     `notificationLabel`, linked to its target via `notificationHref` — ALL
 *     THREE from `@thinkersjournal/shared` — so this dropdown and the
 *     `/notifications` page can never disagree on wording OR on where a
 *     notification links (the post for engagement kinds, the actor's profile
 *     for `follow`, plain text when the post is gone).
 *  3. (M2.3c) On open, advances the SEEN watermark (`POST
 *     /api/notifications-seen`, no body) — which clears the badge but does NOT
 *     mark any row read. Only a CLICK-THROUGH on a rendered group marks THAT
 *     group read (`POST /api/notifications-read {ids}`), the sole thing that
 *     sets read_at (it drives email suppression, not the badge). Both use a
 *     CSRF token fetched once from `/api/me` (same idiom as nav-auth.ts) and
 *     cached in a module var. A live-nudge re-render threads that SAME memoized
 *     token (so the re-wired click-throughs stay authenticatable) but never
 *     re-POSTs seen.
 *  4. Re-polls the count on load, on tab-visible, and every 60s — this is the
 *     FALLBACK, kept even now that push exists, in case the socket is down, AND
 *     it is the WebSocket's single (re)connect trigger (see below).
 *  5. (M2.3b) Opens a WebSocket to `/api/notifications-ws` once signed in and
 *     refetches on every pushed nudge. The nudge is CONTENT-FREE
 *     ({type:"notification"|"read"}, see NotifyDO) — this file never parses
 *     `event.data`; it only ever triggers a GET refetch, same as the poll. A
 *     single live socket; on close/error the ref is dropped and the next
 *     signed-in poll (4) re-arms it — there is NO bespoke backoff/cap/latch
 *     (two reviews found that error-prone; the poll is the reconnect driver).
 *
 * Talks ONLY to same-origin /api/* (the api Worker has no public origin).
 * DOM is built with createElement/textContent only — no raw-markup DOM
 * writes anywhere — because a rendered group carries a user-derived actor
 * name and (via notificationLabel's `rest`) an interpolated post title.
 */
import { collapseNotifications, notificationHref, notificationLabel } from "@thinkersjournal/shared";

import type { NotificationsPage } from "@thinkersjournal/shared";

interface MeResponse {
  csrfToken: string | null;
}

/** Cached across the bell's lifetime — "the single /api/me call for the bell". */
let csrfTokenPromise: Promise<string | null> | null = null;

function getCsrfToken(): Promise<string | null> {
  if (csrfTokenPromise === null) {
    csrfTokenPromise = fetch("/api/me")
      .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
      .then((me) => (me === null ? null : me.csrfToken))
      .catch(() => null);
  }
  return csrfTokenPromise;
}

/**
 * `null` on any non-200 (401/anonymous, a degraded api) OR a network failure —
 * NEVER throws. Callers invoke this fire-and-forget (`void refreshCount(...)`
 * from the WS nudge and the poll), so a `fetch()` rejection on a transient
 * network blip must be swallowed here or it surfaces as an unhandled rejection.
 */
async function fetchUnreadCount(): Promise<number | null> {
  try {
    const resp = await fetch("/api/notifications-count");
    if (resp.status !== 200) return null;
    const data = (await resp.json()) as { count: number };
    return data.count;
  } catch {
    return null; // network error / abort — degraded, not a throw
  }
}

function applyBadge(badge: HTMLElement, count: number): void {
  if (count === 0) {
    badge.hidden = true;
    badge.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 9 ? "9+" : String(count);
}

/**
 * Fires on load, on tab-visible, and every 60s. Only ever REVEALS the bell
 * (never hides it once shown) — a transient/degraded response mid-session
 * should not yank a control the viewer may be mid-interaction with. Returns
 * whether the viewer is signed in (the count came back 200); the poll uses this
 * fresh signal to (re)arm the WebSocket.
 */
async function refreshCount(bell: HTMLElement, badge: HTMLElement): Promise<boolean> {
  const count = await fetchUnreadCount();
  if (count === null) return false;
  bell.hidden = false;
  applyBadge(badge, count);
  return true;
}

/**
 * Renders collapsed groups into the panel via createElement/textContent only.
 * `csrfForClick` is the token attached to each linked group's click-through
 * mark-read POST. Linked rows are ALWAYS wired; a `null` token only occurs in
 * the degraded/logged-out path (the mark-read cannot authenticate there anyway).
 * Both real callers — open and live-nudge — pass the real memoized token.
 */
function renderPanel(panel: HTMLElement, page: NotificationsPage, csrfForClick: string | null): void {
  const groups = collapseNotifications(page.notifications);
  panel.replaceChildren();

  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notify-empty";
    empty.textContent = "No notifications yet.";
    panel.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const label = notificationLabel(group);
    const href = notificationHref(group);
    const row = document.createElement("p");
    row.className = group.read ? "notify-row" : "notify-row unread";

    // The whole row links to the notification's TARGET (the post for
    // engagement kinds, the actor's profile for `follow`) as ONE anchor over
    // the full label — never a nested anchor. `href === null` only when the
    // post is gone (hard-deleted): render the label as plain text instead of
    // a dead link.
    const text = label.leadName + label.rest;
    if (href !== null) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = text;
      // Click-through is the ONLY thing that marks a group read (sets read_at,
      // which drives email suppression). `keepalive: true` so the write is not
      // aborted when this anchor's navigation tears the document down mid-flight
      // (the {ids} body is far under the 64 KB keepalive cap; same-origin).
      // Every caller (open AND live-nudge) threads a real CSRF token so this
      // POST authenticates — a null token only occurs in the degraded/logged-out
      // path, where a mark-read could not authenticate anyway.
      link.addEventListener("click", () => {
        void fetch("/api/notifications-read", {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json", "X-CSRF-Token": csrfForClick ?? "" },
          body: JSON.stringify({ ids: group.ids }),
        }).catch(() => {}); // fire-and-forget; navigation proceeds regardless
      });
      row.appendChild(link);
    } else {
      row.appendChild(document.createTextNode(text));
    }

    // NOT panel.append(...): worker-configuration.d.ts (wrangler's ambient
    // globals for the HTMLRewriter API) declares its own global `Element`
    // with an `append(content, options?)` overload that merges into DOM's
    // `Element`/`HTMLElement`, making `.append()` fail to typecheck here for
    // any arity. appendChild is unaffected (see nav-auth.ts:46-50).
    panel.appendChild(row);
  }
}

/**
 * Fetches `/api/notifications` and renders it into the panel — no seen-advance,
 * no visibility change. Used both by `openPanel` (below) and by a pushed nudge
 * arriving while the panel is already open. BOTH thread the memoized CSRF token
 * so the re-wired click-through mark-reads can authenticate; the nudge path
 * differs only in that it never advances seen. Returns whether it loaded (a
 * non-200 is a no-op, matching `fetchUnreadCount`'s degraded-mode contract).
 */
async function loadList(panel: HTMLElement, csrfForClick: string | null): Promise<boolean> {
  try {
    const resp = await fetch("/api/notifications");
    if (!resp.ok) return false;
    const page = (await resp.json()) as NotificationsPage;
    renderPanel(panel, page, csrfForClick);
    return true;
  } catch {
    return false; // network error — degraded, never throw (called fire-and-forget on a nudge)
  }
}

/**
 * Loads the list (wiring each rendered group's click-through mark-read with the
 * CSRF token), shows the panel, then advances the SEEN watermark (M2.3c) which
 * clears the badge WITHOUT marking any row read. Skips the seen POST — panel
 * still renders — if no CSRF token is available, per the brief's degraded-mode
 * note. The token is fetched BEFORE render so it can be threaded into the click
 * handlers.
 */
async function openPanel(panel: HTMLElement, badge: HTMLElement): Promise<void> {
  const token = await getCsrfToken();
  const loaded = await loadList(panel, token);
  if (!loaded) return;
  panel.hidden = false;

  if (token === null) return; // degraded/logged-out: panel stays read-optimistic, no write

  try {
    const seenResp = await fetch("/api/notifications-seen", {
      method: "POST",
      headers: { "content-type": "application/json", "X-CSRF-Token": token },
      body: "{}",
    });
    if (seenResp.ok) {
      badge.hidden = true;
      badge.textContent = "";
    }
  } catch {
    // Network error advancing the seen watermark — leave the badge; the poll reconciles.
    // openPanel is invoked fire-and-forget, so this must not reject.
  }
}

export function initNotifyBell(): void {
  const bell = document.querySelector<HTMLElement>("[data-notify-bell]");
  const toggle = document.querySelector<HTMLButtonElement>("[data-notify-toggle]");
  const badge = document.querySelector<HTMLElement>("[data-notify-badge]");
  const panel = document.querySelector<HTMLElement>("[data-notify-panel]");
  if (bell === null || toggle === null || badge === null || panel === null) return;

  // --- M2.3b realtime WS lifecycle ------------------------------------
  // The nav bell holds ONE WebSocket to /api/notifications-ws for live pushes,
  // and the POLL (below) is its single (re)connect trigger AND the fallback
  // while the socket is down: on each FRESH signed-in count (200) it arms the
  // socket if one isn't already live. Three properties we want — two bespoke
  // reconnect designs kept getting one or the other wrong:
  //   • Anonymous / signed-out viewers never open a socket (refreshCount returns
  //     false on a non-200), so the web proxy never sees a doomed handshake.
  //   • A dead/expired session (count keeps 401ing) never re-arms — no endless
  //     reconnect loop against a session that will never authenticate.
  //   • A recovered session/network re-arms within one poll interval (≤60s, and
  //     immediately on tab-focus via visibilitychange) — no permanent latch.
  // A pushed nudge is content-free ({type} only) — it only triggers a refetch
  // (refreshCount + a list reload if the panel is open), never a render from it.
  //
  // `connect`/`poll` are const arrows (NOT `function` declarations): TS's
  // null-narrowing of `bell`/`badge`/`panel` from the guard above only survives
  // into `const`-bound function expressions.
  let ws: WebSocket | null = null;

  const wsUrl = (): string => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/api/notifications-ws`;
  };

  const connect = (): void => {
    if (ws !== null) return; // single live socket
    const socket = new WebSocket(wsUrl());
    ws = socket;
    socket.onmessage = () => {
      // Content-free nudge ({type:"notification"|"read"}) — never parse
      // event.data; a nudge only ever triggers a refetch, same as poll().
      void refreshCount(bell, badge);
      // A nudge re-renders an OPEN panel, which RE-WIRES each row's
      // click-through mark-read — so it must thread the REAL CSRF token, never
      // null: an empty token would make every re-rendered row's mark-read 403
      // (runMutatingPipeline) and read_at would never be set. getCsrfToken() is
      // memoized (already resolved once the panel was opened), so this adds no
      // extra /api/me hop; re-check panel.hidden after the await since the panel
      // may have closed in the meantime.
      if (!panel.hidden) {
        void getCsrfToken().then((t) => {
          if (!panel.hidden) void loadList(panel, t);
        });
      }
    };
    // On close/error just drop the reference; the next signed-in poll re-arms.
    // Guard on identity so a stale socket's late event can't clear a newer one.
    const drop = (): void => {
      if (ws === socket) ws = null;
    };
    socket.onclose = drop;
    socket.onerror = drop;
  };

  const poll = (): void => {
    void refreshCount(bell, badge).then((signedIn) => {
      // (Re)arm the socket ONLY on a fresh signed-in count — never off a latched
      // flag or historical state — and only when one isn't already live
      // (connect() double-guards on `ws`).
      if (signedIn) connect();
    });
  };

  poll(); // on load — reveals the bell only once /api/notifications-count answers 200

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });

  setInterval(poll, 60_000);

  toggle.addEventListener("click", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    void openPanel(panel, badge);
  });
}

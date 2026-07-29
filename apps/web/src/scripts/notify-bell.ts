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
 *  3. Marks everything read (`POST /api/notifications-read {all:true}`) right
 *     after a successful render, using a CSRF token fetched once from
 *     `/api/me` (same idiom as nav-auth.ts) and cached in a module var.
 *  4. Re-polls the count on load, on tab-visible, and every 60s — this is the
 *     FALLBACK, kept even now that push exists, in case the socket is down.
 *  5. (M2.3b) Opens a WebSocket to `/api/notifications-ws` once signed in
 *     (the first count-200) and refetches on every pushed nudge. The nudge is
 *     CONTENT-FREE ({type:"notification"|"read"}, see NotifyDO) — this file
 *     never parses `event.data`; it only ever triggers a GET refetch, same as
 *     the poll. Reconnects with exponential backoff (~1s → 30s cap, reset on
 *     a successful open), single socket held across reconnects.
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

/** `null` on any non-200 (401/anonymous, or a degraded api) — never throws. */
async function fetchUnreadCount(): Promise<number | null> {
  const resp = await fetch("/api/notifications-count");
  if (resp.status !== 200) return null;
  const data = (await resp.json()) as { count: number };
  return data.count;
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
 * should not yank a control the viewer may be mid-interaction with.
 */
async function refreshCount(bell: HTMLElement, badge: HTMLElement): Promise<void> {
  const count = await fetchUnreadCount();
  if (count === null) return;
  bell.hidden = false;
  applyBadge(badge, count);
}

/** Renders collapsed groups into the panel via createElement/textContent only. */
function renderPanel(panel: HTMLElement, page: NotificationsPage): void {
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
 * Fetches `/api/notifications` and renders it into the panel — no mark-read,
 * no visibility change. Used both by `openPanel` (below) and by a pushed
 * nudge arriving while the panel is already open (so a live refresh doesn't
 * re-POST mark-read on every nudge). Returns whether it loaded (a non-200 is
 * a no-op, matching `fetchUnreadCount`'s degraded-mode contract).
 */
async function loadList(panel: HTMLElement): Promise<boolean> {
  const resp = await fetch("/api/notifications");
  if (!resp.ok) return false;
  const page = (await resp.json()) as NotificationsPage;
  renderPanel(panel, page);
  return true;
}

/**
 * Loads the list, renders it, shows the panel, then marks everything read
 * (skipping the POST — panel still renders read-optimistically — if no CSRF
 * token is available, per the brief's degraded-mode note).
 */
async function openPanel(panel: HTMLElement, badge: HTMLElement): Promise<void> {
  const loaded = await loadList(panel);
  if (!loaded) return;
  panel.hidden = false;

  const token = await getCsrfToken();
  if (token === null) return; // degraded/logged-out: panel stays read-optimistic, no write

  const markResp = await fetch("/api/notifications-read", {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ all: true }),
  });
  if (markResp.ok) {
    badge.hidden = true;
    badge.textContent = "";
  }
}

export function initNotifyBell(): void {
  const bell = document.querySelector<HTMLElement>("[data-notify-bell]");
  const toggle = document.querySelector<HTMLButtonElement>("[data-notify-toggle]");
  const badge = document.querySelector<HTMLElement>("[data-notify-badge]");
  const panel = document.querySelector<HTMLElement>("[data-notify-panel]");
  if (bell === null || toggle === null || badge === null || panel === null) return;

  // --- M2.3b realtime WS lifecycle ------------------------------------
  // Opened only once signed in (the first count-200 — anonymous viewers
  // never flip `bell.hidden`, so they never get a socket, which matters:
  // the web proxy would fail the handshake for them → reconnect storm).
  // A pushed nudge is content-free — it only ever triggers a refetch via
  // `refreshCount` (+ a list reload if the panel is open), never a render
  // from the message payload. Reconnects with exponential backoff, single
  // socket held live across reconnects.
  let ws: WebSocket | null = null;
  let wsStarted = false;
  let reconnectDelay = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Arrow-function consts (NOT `function` declarations): TS's null-narrowing
  // of `bell`/`badge`/`panel` from the guard above only survives into nested
  // closures for `const`-bound function expressions, not hoisted function
  // declarations. `connect` and `scheduleReconnect` reference each other —
  // safe as a mutual-const idiom because each reference is inside a callback
  // body evaluated later, by which point both are already initialized.
  const wsUrl = (): string => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/api/notifications-ws`;
  };

  const scheduleReconnect = (): void => {
    ws = null;
    if (reconnectTimer !== null) return; // already scheduled — guards close+error double-firing
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (ws !== null) return; // single-socket guard, holds across reconnects
    const socket = new WebSocket(wsUrl());
    ws = socket;
    socket.onopen = () => {
      reconnectDelay = 1000; // reset backoff after a successful open
    };
    socket.onmessage = () => {
      // Content-free nudge ({type:"notification"|"read"}) — never parse
      // event.data; a nudge only ever triggers a refetch, same as poll().
      void refreshCount(bell, badge);
      if (!panel.hidden) void loadList(panel);
    };
    socket.onclose = scheduleReconnect;
    socket.onerror = scheduleReconnect;
  };

  const poll = (): void => {
    void refreshCount(bell, badge).then(() => {
      // The first successful count (the bell revealed) is the signed-in
      // signal — open the socket exactly once from it.
      if (wsStarted || bell.hidden) return;
      wsStarted = true;
      connect();
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

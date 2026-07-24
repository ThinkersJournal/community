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
 *  4. Re-polls the count on load, on tab-visible, and every 60s — so a viewer
 *     who signs in in another tab (or receives a new notification) sees the
 *     bell/badge update without a full page reload.
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
 * Loads the list, renders it, shows the panel, then marks everything read
 * (skipping the POST — panel still renders read-optimistically — if no CSRF
 * token is available, per the brief's degraded-mode note).
 */
async function openPanel(panel: HTMLElement, badge: HTMLElement): Promise<void> {
  const resp = await fetch("/api/notifications");
  if (!resp.ok) return;
  const page = (await resp.json()) as NotificationsPage;
  renderPanel(panel, page);
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

  const poll = (): void => {
    void refreshCount(bell, badge);
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

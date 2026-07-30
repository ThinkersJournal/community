/**
 * THE LIVE COMMENTS CLIENT (M2.3b-live) — the centerpiece of the milestone.
 * Holds ONE WebSocket to `/api/posts-live?postId=<id>` for the open post page
 * and, on each pushed nudge, brings the page's comment window up to date
 * WITHOUT a reload.
 *
 * ⚠️ THE NUDGE IS CONTENT-FREE. The per-post channel pushes `{type:"comment"}`
 * or `{type:"reaction"}` and NOTHING ELSE (see PostLiveDO). This file parses
 * ONLY `{ type }` and NEVER renders `event.data` — a reaction nudge triggers a
 * counts refetch (reactions.ts), a comment nudge triggers a fragment refetch +
 * reconcile. All content comes back through `/api/comments-fragment`, whose
 * `html` is server-sanitized `renderMarkdown` output — the SAME sanitize-first
 * pipeline the SSR page uses and the ONLY producer of comment HTML. That
 * fragment `html` is this script's ONE `innerHTML` sink; nothing else here ever
 * assigns innerHTML, and nothing ever innerHTMLs `event.data`.
 *
 * ⚠️ RECONCILE-BY-ID, NEVER DESTRUCTIVE. For each comment in the fragment
 * window we find the matching `<li>` by `data-comment-id` and:
 *   • has an OPEN edit/reply form → SKIP it this cycle (don't yank a form out
 *     from under the viewer);
 *   • newly deleted → convert IN PLACE to a `[deleted]` tombstone;
 *   • newly edited → swap the body html + add the "(edited)" marker;
 *   • missing → build the `<li>` (mirroring the SSR structure in
 *     [handle]/[slug].astro) and insert it at its path-ordered position.
 * We NEVER call `.remove()` on a node — a delete becomes a tombstone, exactly
 * like the SSR render. DOM is built with createElement/textContent EXCEPT the
 * `.comment-body`, whose only content is the sanitized fragment html.
 *
 * ⚠️ SINGLE SOCKET, BOUNDED RECONNECT. `if (ws !== null) return` keeps exactly
 * one live socket. Unlike the nav bell there is NO poll here to drive reconnect,
 * so a capped backoff (1→2→4→8→16s, then stop) IS the whole reconnect story; a
 * clean open resets the budget and a navigation re-establishes from scratch.
 *
 * Talks ONLY to same-origin /api/* (the api Worker has no public origin).
 */
import { REACTION_KINDS, REACTION_LABELS } from "@thinkersjournal/shared";

import { wireCommentAffordances } from "./comments";
import { refreshReactionCounts, wireReactionSection } from "./reactions";

/** One row of `/api/comments-fragment` (Task 5) — field-for-field its output. */
interface FragmentComment {
  id: string;
  parentId: string | null;
  depth: number;
  path: string;
  authorUsername: string;
  authorName: string | null;
  createdAt: string;
  edited: boolean;
  deleted: boolean;
  html: string;
}

interface Fragment {
  comments: FragmentComment[];
  nextCursor: string | null;
}

interface MeResponse {
  loggedIn: boolean;
  userId: string | null;
  username: string | null;
  usernameChosen: boolean;
  csrfToken: string | null;
}

/** Builds the disabled ReactionChips placeholder the reactions island fills on
 *  the next `refreshReactionCounts()` — mirrors ReactionChips.astro exactly. */
function buildReactionChips(commentId: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "reactions";
  wrap.setAttribute("data-reactions", "");
  wrap.dataset.targetComment = commentId;
  for (const kind of REACTION_KINDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.dataset.kind = kind;
    btn.setAttribute("aria-pressed", "false");
    btn.disabled = true;
    btn.textContent = `${REACTION_LABELS[kind]} `;
    const count = document.createElement("span");
    count.setAttribute("data-count", "");
    count.textContent = "—";
    btn.appendChild(count);
    wrap.appendChild(btn);
  }
  return wrap;
}

/** Builds a fresh comment `<li>` mirroring the SSR structure in [slug].astro.
 *  ⚠️ `data-author-id` is intentionally ABSENT — the fragment endpoint doesn't
 *  surface the author id, so it can't be set here. A live-inserted comment is by
 *  definition someone else's (the viewer's own writes reload the page), so the
 *  missing id only withholds the Edit affordance on it, which is correct; a
 *  navigation gives full fidelity. */
function buildComment(c: FragmentComment): HTMLElement {
  const li = document.createElement("li");
  li.className = `comment depth-${Math.min(c.depth, 6)}`;
  li.dataset.commentId = c.id;
  li.dataset.depth = String(c.depth);
  li.dataset.path = c.path;
  li.dataset.new = "";

  if (c.deleted) {
    li.dataset.deleted = "true";
    const p = document.createElement("p");
    p.className = "tombstone";
    p.textContent = "[deleted]";
    li.appendChild(p);
    return li;
  }

  const meta = document.createElement("p");
  meta.className = "meta";
  const a = document.createElement("a");
  a.className = "link";
  a.href = `/@${encodeURIComponent(c.authorUsername)}`;
  a.textContent = c.authorName ?? "";
  meta.appendChild(a);
  meta.appendChild(document.createTextNode(" · "));
  const time = document.createElement("time");
  time.setAttribute("datetime", c.createdAt);
  time.textContent = c.createdAt.slice(0, 10);
  meta.appendChild(time);
  if (c.edited) meta.appendChild(editedMarker());
  li.appendChild(meta);

  const body = document.createElement("div");
  body.className = "comment-body";
  body.innerHTML = c.html; // ⚠️ THE ONE html sink — server-sanitized fragment html.
  li.appendChild(body);

  li.appendChild(buildReactionChips(c.id));

  const actions = document.createElement("div");
  actions.setAttribute("data-comment-actions", "");
  li.appendChild(actions);

  return li;
}

function editedMarker(): HTMLElement {
  const edited = document.createElement("span");
  edited.className = "edited";
  edited.textContent = "(edited)";
  return edited;
}

/** Convert an existing `<li>` to a tombstone IN PLACE — replaceChildren clears
 *  the meta/body/chips/actions without ever calling `.remove()` on the node. */
function toTombstone(li: HTMLElement): void {
  li.dataset.deleted = "true";
  const p = document.createElement("p");
  p.className = "tombstone";
  p.textContent = "[deleted]";
  li.replaceChildren(p);
}

/** Insert `li` among the flat comment list at its path-ordered position — the
 *  server orders by materialized `path`, so lexicographic compare matches. */
function insertOrdered(list: HTMLElement, li: HTMLElement, path: string): void {
  for (const node of Array.from(list.querySelectorAll<HTMLElement>("[data-comment-id]"))) {
    if ((node.dataset.path ?? "") > path) {
      list.insertBefore(li, node);
      return;
    }
  }
  list.appendChild(li);
}

export function initCommentsLive(): void {
  const section = document.querySelector<HTMLElement>("[data-comments]");
  if (section === null) return;
  const postId = section.dataset.postId ?? "";
  const postAuthorId = section.dataset.postAuthorId ?? "";

  // Viewer identity, fetched ONCE (same shape + gating as initCommentsIsland) so
  // a freshly-inserted comment can be affordance-wired for the viewer. Held as a
  // PROMISE the reconcile AWAITS — a nudge that fires before /api/me resolves
  // must not permanently leave an inserted comment un-wired; it awaits the same
  // in-flight fetch instead. Logged out / degraded → resolves null and inserted
  // comments simply aren't wired.
  const viewerPromise: Promise<{ csrfToken: string; viewerId: string } | null> = fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
    .then((me) =>
      me !== null && me.loggedIn && me.usernameChosen && me.csrfToken !== null && me.userId !== null
        ? { csrfToken: me.csrfToken, viewerId: me.userId }
        : null,
    )
    .catch(() => null);

  // --- socket lifecycle: single socket + bounded reconnect (no poll here) ----
  let ws: WebSocket | null = null;
  let retries = 0;
  const MAX_RETRIES = 5;

  // Single-flight reconcile: at most one in-flight, with a trailing coalesced
  // re-run for any nudge that arrives mid-flight (see the `reconcile` wrapper).
  let reconciling = false;
  let pending = false;

  const wsUrl = (): string => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/api/posts-live?postId=${encodeURIComponent(postId)}`;
  };

  const scheduleReconnect = (): void => {
    if (retries >= MAX_RETRIES) return; // capped — a navigation re-establishes
    const delay = 1000 * 2 ** retries; // 1 → 2 → 4 → 8 → 16s
    retries += 1;
    setTimeout(connect, delay);
  };

  const connect = (): void => {
    if (ws !== null) return; // single live socket
    const socket = new WebSocket(wsUrl());
    ws = socket;

    socket.onopen = () => {
      retries = 0; // a clean open resets the backoff budget
    };

    socket.onmessage = (event) => {
      // Content-free nudge: parse ONLY { type }, NEVER render event.data.
      let type = "";
      try {
        type = (JSON.parse(event.data as string) as { type?: string }).type ?? "";
      } catch {
        return;
      }
      if (type === "reaction") refreshReactionCounts();
      else if (type === "comment") void reconcile();
    };

    // On close/error drop the ref (guarded on identity so a stale socket's late
    // event can't clear a newer one) and schedule a capped reconnect.
    const drop = (): void => {
      if (ws === socket) {
        ws = null;
        scheduleReconnect();
      }
    };
    socket.onclose = drop;
    socket.onerror = drop;
  };

  const runReconcile = async (): Promise<void> => {
    const cursor = new URLSearchParams(location.search).get("comments");
    const url = `/api/comments-fragment?postId=${encodeURIComponent(postId)}${
      cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;

    let fragment: Fragment;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      fragment = (await resp.json()) as Fragment;
    } catch {
      return; // network error — reconcile is fire-and-forget, never throw
    }

    const list = section.querySelector<HTMLElement>(".comment-list");
    if (list === null) return;

    // Await the one-shot viewer fetch so an early nudge still wires inserts once
    // it resolves (no permanent miss). Resolved after the first reconcile, so
    // this is a no-op await thereafter.
    const viewer = await viewerPromise;

    let changed = false;
    let inserted = false;
    for (const c of fragment.comments) {
      const existing = section.querySelector<HTMLElement>(`[data-comment-id="${c.id}"]`);

      if (existing !== null) {
        // Do-not-disrupt: a comment with an OPEN edit/reply form is mid-edit —
        // skip it entirely this cycle rather than clobber the viewer's input.
        if (existing.querySelector("form") !== null) continue;

        if (c.deleted && existing.dataset.deleted !== "true") {
          toTombstone(existing);
          changed = true;
        } else if (!c.deleted && c.edited) {
          const body = existing.querySelector<HTMLElement>(".comment-body");
          if (body !== null && (existing.querySelector(".edited") === null || body.innerHTML !== c.html)) {
            body.innerHTML = c.html; // ⚠️ THE ONE html sink — sanitized fragment html.
            const meta = existing.querySelector<HTMLElement>(".meta");
            if (meta !== null && existing.querySelector(".edited") === null) meta.appendChild(editedMarker());
            changed = true;
          }
        }
        continue;
      }

      // MISSING → build + insert at the path-ordered position, then wire.
      const li = buildComment(c);
      insertOrdered(list, li, c.path);
      changed = true;
      inserted = true;
      // Reaction chips are interactive for EVERYONE (a logged-out click routes to
      // /login, exactly like the SSR island), so wire them UNCONDITIONALLY — the
      // `refreshReactionCounts()` below enables the chips, and an enabled chip
      // MUST be clickable, not a dead affordance. Tombstone inserts carry no chip
      // row, so the query is null and this is skipped for them.
      const chips = li.querySelector<HTMLElement>("[data-reactions]");
      if (chips !== null) wireReactionSection(chips, postId);
      // Reply/Edit/Delete need the viewer's identity, so those stay gated.
      if (viewer !== null && !c.deleted) {
        wireCommentAffordances(li, {
          csrfToken: viewer.csrfToken,
          viewerId: viewer.viewerId,
          postId,
          postAuthorId,
        });
      }
    }

    // Retire the empty-state note once a live comment lands (hidden, NOT removed).
    if (inserted) {
      const empty = section.querySelector<HTMLElement>(".no-comments");
      if (empty !== null) empty.hidden = true;
    }

    // Repopulate chip counts so inserted comments' chips (and any that changed)
    // come alive on the next round trip.
    if (changed) refreshReactionCounts();
  };

  // Single-flight wrapper around runReconcile. `runReconcile`'s insert loop is
  // synchronous — it check-then-inserts by `data-comment-id` with NO await in
  // between — so JS run-to-completion already prevents duplicate inserts across
  // overlapping reconciles (the second call sees the first's inserts committed
  // and skips them). This wrapper adds two things on top: it collapses a BURST of
  // nudges (a lively thread) into at most one in-flight fetch plus one trailing
  // re-run — instead of one redundant /api/comments-fragment fetch per nudge —
  // and it keeps the no-duplicate guarantee explicit if the loop ever grows an
  // await. It COALESCES, never drops: runReconcile always refetches the full
  // current window, so a single trailing run captures every change that landed
  // while the previous one was in flight.
  const reconcile = async (): Promise<void> => {
    if (reconciling) {
      pending = true;
      return;
    }
    reconciling = true;
    try {
      await runReconcile();
    } finally {
      reconciling = false;
      if (pending) {
        pending = false;
        void reconcile();
      }
    }
  };

  connect();
}

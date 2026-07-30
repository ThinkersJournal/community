/**
 * THE REACTIONS ISLAND — hydrates every chip row on the post page (the post's
 * and each comment's) from ONE /api/reactions round trip: public counts always,
 * the viewer's own toggles + CSRF when signed in. Toggles are optimistic
 * (chip + count update immediately) and revert on a failed write. Reaction
 * state NEVER touches the cached HTML (spec decision 5) — chips ship disabled
 * with "—" counts and come alive only here.
 */
type Kind = "insightful" | "curious" | "agree" | "challenging";

interface ReactionsResponse {
  counts: { post: Record<Kind, number>; comments: Record<string, Record<Kind, number>> };
  mine: { post: Kind[]; comments: Record<string, Kind[]> } | null;
  viewerLoggedIn: boolean;
  csrfToken: string | null;
}

let csrfToken: string | null = null;

function applyState(section: HTMLElement, counts: Record<Kind, number>, mine: Kind[]): void {
  for (const btn of Array.from(section.querySelectorAll<HTMLButtonElement>("button[data-kind]"))) {
    const kind = btn.dataset.kind as Kind;
    const count = btn.querySelector<HTMLElement>("[data-count]");
    if (count !== null) count.textContent = String(counts[kind] ?? 0);
    btn.setAttribute("aria-pressed", mine.includes(kind) ? "true" : "false");
    btn.disabled = false;
  }
}

function toggle(btn: HTMLButtonElement, target: { postId?: string; commentId?: string }): void {
  if (csrfToken === null) {
    location.href = "/login";
    return;
  }
  const kind = btn.dataset.kind as Kind;
  const wasPressed = btn.getAttribute("aria-pressed") === "true";
  const count = btn.querySelector<HTMLElement>("[data-count]");
  const before = Number(count?.textContent ?? "0");

  // Optimistic flip…
  btn.setAttribute("aria-pressed", wasPressed ? "false" : "true");
  if (count !== null) count.textContent = String(wasPressed ? before - 1 : before + 1);

  const revert = (): void => {
    btn.setAttribute("aria-pressed", wasPressed ? "true" : "false");
    if (count !== null) count.textContent = String(before);
  };

  btn.disabled = true;
  void fetch(wasPressed ? "/api/unreact" : "/api/react", {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ ...target, kind }),
  })
    .then((resp) => {
      btn.disabled = false;
      if (!resp.ok) revert();
    })
    .catch(() => {
      btn.disabled = false;
      revert();
    });
}

/**
 * Refetches `/api/reactions` and re-applies counts + the viewer's pressed-state
 * onto EVERY `[data-reactions]` chip row currently in the DOM (the post's and
 * each comment's). Idempotent and callable on demand: `initReactionsIsland`
 * runs it once on load, and the live client (comments-live.ts, M2.3b-live) calls
 * it after a reconcile so a freshly-inserted comment's chips get their counts.
 * This refreshes COUNTS ONLY — it does not wire click handlers. Click-to-toggle
 * is wired separately by `wireReactionSection`: `initReactionsIsland` wires the
 * SSR chip rows at load, and the live client wires each inserted comment's row as
 * it arrives — so a live-inserted chip is clickable IMMEDIATELY, no navigation.
 */
export function refreshReactionCounts(): void {
  const root = document.querySelector<HTMLElement>("[data-comments]");
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-reactions]"));
  if (root === null || sections.length === 0) return;
  const postId = root.dataset.postId ?? "";

  void fetch(`/api/reactions?postId=${encodeURIComponent(postId)}`)
    .then(async (resp) => {
      if (!resp.ok) return; // chips stay disabled with "—" — an honest degraded state
      const data = (await resp.json()) as ReactionsResponse;
      csrfToken = data.csrfToken;
      for (const section of sections) {
        const commentId = section.dataset.targetComment;
        const isPost = section.dataset.targetPost !== undefined;
        const counts = isPost
          ? data.counts.post
          : (data.counts.comments[commentId ?? ""] ??
             { insightful: 0, curious: 0, agree: 0, challenging: 0 });
        const mine = isPost ? (data.mine?.post ?? []) : (data.mine?.comments[commentId ?? ""] ?? []);
        applyState(section, counts, mine);
      }
    })
    .catch(() => {
      /* degraded state: chips stay disabled */
    });
}

/**
 * Wires click-to-toggle onto ONE `[data-reactions]` chip row. Shared by
 * `initReactionsIsland` (the SSR set, once at load) and by the live client
 * (comments-live.ts, M2.3b-live) for a freshly-inserted comment's chip row —
 * extracted so a live-inserted row becomes fully INTERACTIVE, not merely
 * count-populated. Without this, `refreshReactionCounts` would enable an
 * inserted comment's chips (`btn.disabled = false`) while leaving them unwired —
 * a dead, enabled-but-unclickable affordance. Post rows carry `data-target-post`;
 * comment rows carry `data-target-comment`. A logged-out click routes to /login
 * (see `toggle`), matching the SSR chips exactly, so this is wired for EVERY
 * viewer, not only the signed-in ones.
 */
export function wireReactionSection(section: HTMLElement, postId: string): void {
  const commentId = section.dataset.targetComment;
  const isPost = section.dataset.targetPost !== undefined;
  for (const btn of Array.from(section.querySelectorAll<HTMLButtonElement>("button[data-kind]"))) {
    btn.addEventListener("click", () => {
      toggle(btn, isPost ? { postId } : { commentId: commentId ?? "" });
    });
  }
}

export function initReactionsIsland(): void {
  const root = document.querySelector<HTMLElement>("[data-comments]");
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-reactions]"));
  if (root === null || sections.length === 0) return;
  const postId = root.dataset.postId ?? "";

  // Populate counts + pressed-state from one round trip…
  refreshReactionCounts();

  // …then wire click-to-toggle ONCE per chip row that exists at load (the SSR set).
  for (const section of sections) wireReactionSection(section, postId);
}

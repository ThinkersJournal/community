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

export function initReactionsIsland(): void {
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
        for (const btn of Array.from(section.querySelectorAll<HTMLButtonElement>("button[data-kind]"))) {
          btn.addEventListener("click", () => {
            toggle(btn, isPost ? { postId } : { commentId: commentId ?? "" });
          });
        }
      }
    })
    .catch(() => {
      /* degraded state: chips stay disabled */
    });
}

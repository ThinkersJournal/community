/**
 * THE POST-VIEW HIDE CONTROL — hydrates the hidden `[data-post-visibility-view]`
 * placeholder that ships with every cached post page ([handle]/[slug].astro),
 * right alongside `[data-post-delete]`. Same reveal mechanics as
 * post-delete.ts's island (owner-only, via `/api/me`), for the same reason:
 * this page is fully anonymous, edge-cached SSR, so there is no viewer-
 * specific state to decide "is this viewer the author" server-side.
 *
 * ⚠️ HIDE ONLY — NEVER UNHIDE — ON THIS PAGE, AND THAT IS STRUCTURAL, NOT A
 * CHOICE. `[handle]/[slug].astro` reads `GET /public/posts`, which filters
 * `hidden_at IS NULL` (apps/api/src/routes/public.ts) — a hidden post 404s
 * here for EVERYONE, including its own author, before this script ever runs.
 * So a post this control can see is ALWAYS currently visible; there is no
 * "already hidden, offer Unhide" state reachable on this page at all. Unhide
 * lives ONLY on the editor (new-post.astro), the one page that can still
 * render a hidden post's own state to its author.
 *
 * ⚠️ REDIRECTS TO THE EDITOR ON SUCCESS, NOT BACK TO THIS PAGE. Hiding the
 * post makes THIS EXACT URL 404 for everyone, including the author who just
 * hid it (same "nothing left to reload back to" situation post-delete.ts's
 * redirect-to-profile comment describes) — but unlike delete, hide is
 * reversible, and the editor is the only place that reversal (Unhide) lives,
 * so that is where the author actually needs to land next.
 *
 * Talks ONLY to same-origin /api/* (the api Worker has no public origin).
 */
interface Me {
  userId: string | null;
  csrfToken: string | null;
}

async function me(): Promise<Me> {
  try {
    const r = await fetch("/api/me");
    if (!r.ok) return { userId: null, csrfToken: null };
    const m = (await r.json()) as { userId: string | null; csrfToken: string | null };
    return { userId: m.userId, csrfToken: m.csrfToken };
  } catch {
    return { userId: null, csrfToken: null };
  }
}

export function initPostVisibilityView(): void {
  const root = document.querySelector<HTMLElement>("[data-post-visibility-view]");
  if (root === null) return;
  const postId = root.dataset.postId ?? "";
  const authorId = root.dataset.postAuthorId ?? "";

  void me().then((m) => {
    // Owner-only, and only with a usable CSRF token — same gate as
    // post-delete.ts's island, same reasoning: a signed-in non-author (or a
    // degraded /api/me response) never sees the control at all.
    if (m.userId === null || m.userId !== authorId || m.csrfToken === null) return;
    const csrfToken = m.csrfToken;

    root.hidden = false; // reveal for the owner only

    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "btn btn-ghost";
    hideBtn.setAttribute("data-hide-btn", "");
    hideBtn.textContent = "Hide post";

    let errorNote: HTMLElement | null = null;
    const showError = (message: string): void => {
      if (errorNote === null) {
        errorNote = document.createElement("p");
        errorNote.className = "post-visibility-error";
        root.appendChild(errorNote);
      }
      errorNote.textContent = message;
    };

    hideBtn.addEventListener("click", () => {
      hideBtn.disabled = true;
      void fetch("/api/post-hide", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ postId }),
      })
        .then((res) => {
          if (res.ok) {
            // The post's own URL is about to 404 for everyone, including its
            // author — nothing left to reload back to. The editor is where
            // the hidden banner, the preview, and Unhide all live.
            location.href = "/new-post?post=" + encodeURIComponent(postId);
            return;
          }
          hideBtn.disabled = false;
          showError("Couldn't hide this post — try again.");
        })
        .catch(() => {
          hideBtn.disabled = false;
          showError("Network error — try again.");
        });
    });

    root.appendChild(hideBtn);
  });
}

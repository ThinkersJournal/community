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
 * ⚠️ REDIRECTS BACK TO THIS POST'S OWN URL ON SUCCESS (#78 item 2), NOT THE
 * EDITOR. Before #78, hiding made THIS EXACT URL 404 for everyone including
 * the author, so the editor was the only page left that could show the
 * hidden state and offer Unhide. Since #78, `[handle]/[slug].astro` itself
 * falls back to an authenticated owner view (OwnerPostView.astro) instead of
 * 404ing for the post's own author — so reloading THIS URL now shows the
 * hidden banner and the Unhide control directly, one hop closer than the
 * editor. `data-handle`/`data-slug` carry what's needed to rebuild the URL
 * (NOT the route's `handle` param, which still carries its `@` prefix — see
 * post-delete.ts's identical `data-handle` comment).
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
  const handle = root.dataset.handle ?? "";
  const slug = root.dataset.slug ?? "";

  void me().then((m) => {
    // Owner-only, and only with a usable CSRF token — same gate as
    // post-delete.ts's island, same reasoning: a signed-in non-author (or a
    // degraded /api/me response) never sees the control at all.
    if (m.userId === null || m.userId !== authorId || m.csrfToken === null) return;
    const csrfToken = m.csrfToken;

    root.hidden = false; // reveal for the owner only
    // #82 — also reveal the shared .owner-actions toolbar this control sits
    // in (see [handle]/[slug].astro's header): the wrapper is independently
    // SSR-hidden so an anonymous reader never pays even its collapsed-margin
    // dead space, and whichever island fires first is what un-hides it.
    root.closest<HTMLElement>(".owner-actions")?.removeAttribute("hidden");

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
            // #78 — this post's own URL now falls back to the owner view for
            // its author instead of 404ing, so reload right back to it: the
            // hidden banner and Unhide are there.
            location.href = "/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(slug);
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

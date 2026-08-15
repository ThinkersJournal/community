/**
 * THE POST-DELETE ISLAND — hydrates the hidden `[data-post-delete]` placeholder
 * that ships with every cached post page ([handle]/[slug].astro). The
 * placeholder's SSR default is HIDDEN (cache-safe: the post page is edge-cached
 * + fully anonymous, so it can carry no per-viewer state — see that page's
 * header). This runs client-side and:
 *
 *  1. Reads the post's author id + username off the placeholder's `data-*`
 *     attributes (already present for the comments island's ownership checks;
 *     this is a SEPARATE control, not folded into that one).
 *  2. Fetches `/api/me` and reveals the control ONLY when the viewer IS the
 *     author and has a CSRF token — never for anyone else, never on a
 *     degraded/tokenless response.
 *  3. Builds an inline two-step confirm — [Delete] -> "Really delete? [Confirm]
 *     [Cancel]" — with createElement/textContent ONLY. NO browser `confirm()`:
 *     a native dialog cannot be styled, blocks the main thread, and its OK/
 *     Cancel wording is out of this app's control.
 *  4. On confirm, POSTs `/api/post-delete` (the proxy — DELETE /posts/:id at
 *     the api) with the CSRF header. On success the post is GONE, so there is
 *     nothing to reload back to: redirect to the author's own profile. On
 *     failure, show an inline error and re-arm the confirm button.
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

export function initPostDelete(): void {
  const root = document.querySelector<HTMLElement>("[data-post-delete]");
  if (root === null) return;
  const postId = root.dataset.postId ?? "";
  const authorId = root.dataset.postAuthorId ?? "";
  const handle = root.dataset.handle ?? "";

  void me().then((m) => {
    // Owner-only, and only with a usable CSRF token — a signed-in non-author
    // (or a degraded /api/me response) never sees the control at all.
    if (m.userId === null || m.userId !== authorId || m.csrfToken === null) return;
    const csrfToken = m.csrfToken;

    root.hidden = false; // reveal for the owner only

    const start = document.createElement("button");
    start.type = "button";
    start.className = "btn btn-ghost";
    start.setAttribute("data-delete-start", "");
    start.textContent = "Delete post";

    const confirmRow = document.createElement("span");
    confirmRow.className = "post-delete-confirm";
    confirmRow.hidden = true;

    const prompt = document.createElement("span");
    prompt.textContent = "Really delete this post?";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn-primary";
    confirmBtn.setAttribute("data-delete-confirm", "");
    confirmBtn.textContent = "Confirm";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-ghost";
    cancelBtn.setAttribute("data-delete-cancel", "");
    cancelBtn.textContent = "Cancel";

    confirmRow.appendChild(prompt);
    confirmRow.appendChild(confirmBtn);
    confirmRow.appendChild(cancelBtn);

    let errorNote: HTMLElement | null = null;
    const showError = (message: string): void => {
      if (errorNote === null) {
        errorNote = document.createElement("p");
        errorNote.className = "post-delete-error";
        root.appendChild(errorNote);
      }
      errorNote.textContent = message;
    };

    start.addEventListener("click", () => {
      start.hidden = true;
      confirmRow.hidden = false;
    });

    cancelBtn.addEventListener("click", () => {
      confirmRow.hidden = true;
      start.hidden = false;
    });

    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      void fetch("/api/post-delete", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ postId }),
      })
        .then((res) => {
          if (res.ok) {
            // The post is gone — nothing left to reload back to.
            // encodeURIComponent, like the page's own `/@${encodeURIComponent(post.username)}`
            // link and comments-live.ts's precedent — a no-op for today's
            // `[a-z0-9_]` usernames, defense-in-depth for a future relaxed charset.
            location.href = "/@" + encodeURIComponent(handle);
            return;
          }
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          showError("Couldn't delete this post — try again.");
        })
        .catch(() => {
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          showError("Network error — try again.");
        });
    });

    root.appendChild(start);
    root.appendChild(confirmRow);
  });
}

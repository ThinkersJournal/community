/**
 * THE HIDE/UNHIDE ISLAND — hydrates the `[data-post-visibility]` control on
 * the editor page (new-post.astro). Unlike post-delete.ts's island, this
 * needs NO owner-detection dance: the editor page is already per-viewer,
 * server-rendered, session-scoped (edit mode 404s on a post that is not the
 * caller's, before this control ever renders), so the control ships visible
 * and this script only wires its click behaviour.
 *
 * On success, reloads the page so the server re-renders with the new
 * `hiddenAt` state — the banner, the button shown, and (via
 * src/lib/restricted-media.ts) any preview image URLs all follow from that
 * one server-side fact, so there is no client-side state to keep in sync by
 * hand.
 *
 * `POST_UNDER_MODERATION` (apps/api/src/moderation/author-hide.ts) is
 * surfaced with its own message: it means moderation, not the author,
 * currently controls this post's visibility.
 */
export function initPostVisibility(): void {
  const root = document.querySelector<HTMLElement>("[data-post-visibility]");
  if (root === null) return;
  const postId = root.dataset.postId ?? "";
  const csrfToken = root.dataset.csrfToken ?? "";
  const hideBtn = root.querySelector<HTMLButtonElement>("[data-hide-btn]");
  const unhideBtn = root.querySelector<HTMLButtonElement>("[data-unhide-btn]");
  const errorNote = root.querySelector<HTMLElement>("[data-visibility-error]");

  function showError(message: string): void {
    if (errorNote === null) return;
    errorNote.textContent = message;
    errorNote.hidden = false;
  }

  function run(path: string, btn: HTMLButtonElement | null): void {
    if (btn !== null) btn.disabled = true;
    void fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ postId }),
    })
      .then(async (res) => {
        if (res.ok) {
          location.reload();
          return;
        }
        const parsed = (await res.json().catch(() => null)) as { code?: string } | null;
        if (parsed?.code === "POST_UNDER_MODERATION") {
          showError("This post is hidden pending review or by a moderator, and can't be changed here.");
        } else {
          showError("Couldn't update this post's visibility — try again.");
        }
        if (btn !== null) btn.disabled = false;
      })
      .catch(() => {
        showError("Network error — try again.");
        if (btn !== null) btn.disabled = false;
      });
  }

  hideBtn?.addEventListener("click", () => run("/api/post-hide", hideBtn));
  unhideBtn?.addEventListener("click", () => run("/api/post-unhide", unhideBtn));
}

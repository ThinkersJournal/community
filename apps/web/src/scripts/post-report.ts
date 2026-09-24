/**
 * Reveals a Report control for THIS post, for any signed-in verified viewer
 * (NOT owner-gated, unlike post-delete/post-visibility-view — reporting is a
 * reader action, not an author one). SSR-hidden placeholder, same
 * reveal-via-/api/me pattern as this page's other islands: the render is
 * fully anonymous + edge-cached (see [handle]/[slug].astro's header), so
 * there is no viewer-specific value to decide "is this viewer signed in" here.
 */
import { wireReportButton } from "./report-control";

interface MeResponse {
  loggedIn: boolean;
  csrfToken: string | null;
}

export function initPostReport(): void {
  const root = document.querySelector<HTMLElement>("[data-post-report]");
  if (root === null) return;
  const postId = root.dataset.postId ?? "";

  void fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
    .then((me) => {
      if (me === null || !me.loggedIn || me.csrfToken === null) return;
      root.hidden = false;
      wireReportButton(root, { csrfToken: me.csrfToken, target: { postId } });
    })
    .catch(() => { /* network failed → stay hidden, matches nav-auth's swallow */ });
}

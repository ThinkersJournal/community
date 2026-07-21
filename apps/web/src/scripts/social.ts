/**
 * THE SOCIAL ISLAND — hydrates viewer-specific social UI onto CACHED, anonymous
 * pages (profile, authors). The page HTML is shared across all viewers, so this
 * runs client-side: it reads follow-state, follower counts, and the CSRF token
 * live from same-origin /api/* proxies, then renders the Follow button + counts.
 * Talks ONLY to same-origin endpoints (the api Worker has no public origin).
 */
interface StatusResponse {
  following: string[];
  viewerLoggedIn: boolean;
  csrfToken: string | null;
}

let csrfToken: string | null = null;

async function loadStatus(userIds: string[]): Promise<StatusResponse> {
  if (userIds.length === 0) return { following: [], viewerLoggedIn: false, csrfToken: null };
  const resp = await fetch(`/api/social?status=${encodeURIComponent(userIds.join(","))}`);
  if (!resp.ok) return { following: [], viewerLoggedIn: false, csrfToken: null };
  return (await resp.json()) as StatusResponse;
}

async function loadCounts(username: string): Promise<{ followersCount: number; followingCount: number } | null> {
  const resp = await fetch(`/api/social?counts=${encodeURIComponent(username)}`);
  if (!resp.ok) return null;
  return (await resp.json()) as { followersCount: number; followingCount: number };
}

function renderButton(btn: HTMLElement, following: boolean): void {
  btn.textContent = following ? "Unfollow" : "Follow";
  btn.dataset.following = following ? "true" : "false";
  btn.hidden = false;
}

async function toggleFollow(btn: HTMLButtonElement): Promise<void> {
  const followeeId = btn.dataset.userId ?? "";
  const following = btn.dataset.following === "true";
  if (csrfToken === null) {
    // Not logged in — send the viewer to log in, then back here.
    window.location.href = "/login";
    return;
  }
  btn.disabled = true;
  const endpoint = following ? "/api/unfollow" : "/api/follow";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ followeeId }),
  });
  btn.disabled = false;
  if (resp.ok) renderButton(btn, !following);
}

export function initSocialIsland(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-follow-btn]"));
  const counts = document.querySelector<HTMLElement>("[data-social-counts]");

  // Counts (public, viewer-independent) — fetched live so the cached HTML carries none.
  if (counts?.dataset.username) {
    void loadCounts(counts.dataset.username).then((c) => {
      if (c === null) return;
      const f = counts.querySelector<HTMLElement>("[data-followers-count]");
      const g = counts.querySelector<HTMLElement>("[data-following-count]");
      if (f) f.textContent = String(c.followersCount);
      if (g) g.textContent = String(c.followingCount);
    });
  }

  // Follow buttons (per-viewer) — one batched status call for all targets.
  if (buttons.length > 0) {
    const ids = buttons.map((b) => b.dataset.userId ?? "").filter((id) => id.length > 0);
    void loadStatus(ids).then((status) => {
      csrfToken = status.csrfToken;
      for (const btn of buttons) {
        const id = btn.dataset.userId ?? "";
        if (!status.viewerLoggedIn) {
          // Show a Follow button that will route to /login on click.
          renderButton(btn, false);
        } else if (btn.dataset.self === "true") {
          btn.hidden = true; // no self-follow affordance
        } else {
          renderButton(btn, status.following.includes(id));
        }
        btn.addEventListener("click", () => void toggleFollow(btn));
      }
    });
  }
}

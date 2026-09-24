/**
 * Upgrades the nav's [data-auth-slot] for a signed-in viewer. The slot ships a
 * logged-OUT default in SSR (Sign in / Sign up) — cache-safe and functional
 * without JS. This runs client-side, asks the same-origin /api/me proxy who the
 * viewer is, and (only if signed in) swaps in New post / @handle / Sign out.
 * Talks only to same-origin /api/* (the api Worker has no public origin).
 */
interface MeResponse {
  loggedIn: boolean;
  username: string | null;
  csrfToken: string | null;
}

async function signOut(csrfToken: string | null): Promise<void> {
  if (csrfToken === null) { window.location.href = "/login"; return; }
  await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
  window.location.href = "/";
}

/**
 * Ends EVERY session for this user, not just this one (#74 audit, batch B —
 * a user who suspects a compromised session had no way to do this at all).
 * Same fire-and-redirect shape as `signOut`: the api's `/auth/logout-all`
 * already bumps the security epoch and clears the CALLING session's cookie
 * in one response, so there is nothing left to reconcile client-side.
 */
async function signOutAll(csrfToken: string | null): Promise<void> {
  if (csrfToken === null) { window.location.href = "/login"; return; }
  await fetch("/api/logout-all", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
  window.location.href = "/";
}

export function initNavAuth(): void {
  const slot = document.querySelector<HTMLElement>("[data-auth-slot]");
  if (slot === null) return;

  void fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
    .then((me) => {
      if (me === null || !me.loggedIn) return; // keep the SSR anonymous default
      slot.replaceChildren();

      const newPost = document.createElement("a");
      newPost.href = "/new-post";
      newPost.className = "support";
      newPost.textContent = "New post";

      const profile = document.createElement("a");
      profile.href = me.username ? `/@${me.username}` : "/feed";
      profile.textContent = me.username ? `@${me.username}` : "Account";

      // Endpoint/UI audit (2026-09-24): /settings/notifications had a
      // working page and no CSS/hidden defect, but its ONLY inbound link in
      // the whole app was the unsubscribe-email landing page's "changed
      // your mind?" line — a signed-in member browsing the site had no
      // click-path to their own notification preferences at all.
      const settings = document.createElement("a");
      settings.href = "/settings/notifications";
      settings.textContent = "Settings";

      const out = document.createElement("button");
      out.type = "button";
      out.className = "signout";
      out.textContent = "Sign out";
      out.addEventListener("click", () => void signOut(me.csrfToken));

      // #74 audit, batch B — reuses `.signout`'s styling (same muted-text
      // tier as "Sign out", not a call-to-action button): this is a rare,
      // security-adjacent action, not a primary nav item.
      const outAll = document.createElement("button");
      outAll.type = "button";
      outAll.className = "signout";
      outAll.textContent = "Sign out everywhere";
      outAll.addEventListener("click", () => void signOutAll(me.csrfToken));

      // NOT slot.append(a, b, c): worker-configuration.d.ts (wrangler's ambient
      // globals for the HTMLRewriter API) declares its own global `Element`
      // with an `append(content, options?)` overload that merges into DOM's
      // `Element`/`HTMLElement`, making `.append()` fail to typecheck here for
      // any arity. appendChild is unaffected (see social.ts for precedent).
      slot.appendChild(newPost);
      slot.appendChild(profile);
      slot.appendChild(settings);
      slot.appendChild(out);
      slot.appendChild(outAll);
    })
    .catch(() => { /* network failed → keep the SSR anonymous default */ });
}

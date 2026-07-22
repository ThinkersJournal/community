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
  usernameChosen: boolean;
  csrfToken: string | null;
}

async function signOut(csrfToken: string | null): Promise<void> {
  if (csrfToken === null) { window.location.href = "/login"; return; }
  await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
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
      newPost.textContent = "New post";

      const profile = document.createElement("a");
      profile.href = me.username ? `/@${me.username}` : "/feed";
      profile.textContent = me.username ? `@${me.username}` : "Account";

      const out = document.createElement("button");
      out.type = "button";
      out.className = "support";
      out.textContent = "Sign out";
      out.addEventListener("click", () => void signOut(me.csrfToken));

      // NOT slot.append(a, b, c): worker-configuration.d.ts (wrangler's ambient
      // globals for the HTMLRewriter API) declares its own global `Element`
      // with an `append(content, options?)` overload that merges into DOM's
      // `Element`/`HTMLElement`, making `.append()` fail to typecheck here for
      // any arity. appendChild is unaffected (see social.ts for precedent).
      slot.appendChild(newPost);
      slot.appendChild(profile);
      slot.appendChild(out);
    });
}

/**
 * BROWSER read hop for the nav auth slot. Forwards the session cookie to the api
 * and reports whether the viewer is signed in (+ their handle and a CSRF token
 * for the logout button). Never cached (markPrivate) — the nav consuming it
 * renders on cached pages, so this per-viewer state stays client-side.
 *
 * ⚠️ NO MORE `usernameChosen`. The handle is chosen once, at signup (see
 * handle-at-signup Task 4) — every signed-in viewer already has one, so there
 * is no separate onboarding state left to report.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { Me } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const me = await apiFetch<Me>("/profile/me", { request: context.request });
  if (me.status !== 200 || me.data === null) {
    return new Response(
      JSON.stringify({ loggedIn: false, userId: null, username: null, csrfToken: null }),
      { status: 200, headers },
    );
  }
  const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
  return new Response(
    JSON.stringify({
      loggedIn: true,
      userId: me.data.userId,
      username: me.data.username,
      csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
    }),
    { status: 200, headers },
  );
};

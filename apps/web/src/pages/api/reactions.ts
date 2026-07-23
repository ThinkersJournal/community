/**
 * BROWSER read hop for the reactions island. Merges two upstream reads plus a
 * CSRF fetch, mirroring /api/social's ?status= mode:
 *   GET /public/reactions?postId=…   → per-post + per-comment counts (ANONYMOUS)
 *   GET /reactions/mine?postId=…     → the viewer's own toggles (authed)
 *   GET /auth/csrf                   → token for subsequent react/unreact calls
 * Never cached (markPrivate) — the post page that renders around this island
 * IS cached, so all viewer-specific state comes from here, live.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { MyReactions, PublicReactions } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const postId = new URL(context.request.url).searchParams.get("postId") ?? "";

  // ⚠️ ANONYMOUS on purpose — /public/reactions reads no session; forwarding
  // the cookie here would buy nothing and break the anonymous-hop convention.
  const counts = await apiFetch<PublicReactions>(
    `/public/reactions?postId=${encodeURIComponent(postId)}`,
  );
  if (counts.status !== 200) {
    // Honest propagation — a 404/500 here must not masquerade as an empty page.
    return new Response(counts.text, { status: counts.status, headers });
  }

  const mine = await apiFetch<MyReactions>(
    `/reactions/mine?postId=${encodeURIComponent(postId)}`,
    { request: context.request },
  );
  if (mine.status === 401) {
    // 401 → not logged in: the island renders toggle buttons that prompt login.
    return new Response(
      JSON.stringify({ counts: counts.data, mine: null, viewerLoggedIn: false, csrfToken: null }),
      { status: 200, headers },
    );
  }
  if (mine.status !== 200) {
    // Any other non-200 is a genuine upstream error — propagate it honestly
    // rather than collapsing it into the logged-out shape.
    return new Response(mine.text, { status: mine.status, headers });
  }

  const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
  return new Response(
    JSON.stringify({
      counts: counts.data,
      mine: mine.data,
      viewerLoggedIn: true,
      csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
    }),
    { status: 200, headers },
  );
};

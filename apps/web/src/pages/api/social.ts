/**
 * BROWSER read hop for the social island. Three modes:
 *   ?status=id,id,…            → { following, viewerLoggedIn, csrfToken }  (per-viewer)
 *   ?counts=<username>         → { followersCount, followingCount }        (public)
 *   ?list=followers|following&username=X&cursor=  → FollowList             (public)
 * Never cached (markPrivate) — the profile/authors pages that consume it ARE
 * cached, so their viewer-specific bits must be fetched live from here.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { FollowStatusResult, SocialCounts } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const url = new URL(context.request.url);
  const status = url.searchParams.get("status");
  const counts = url.searchParams.get("counts");
  const list = url.searchParams.get("list");

  // Mode 1: per-viewer follow-status + CSRF token for subsequent mutations.
  if (status !== null) {
    const idsQuery = status
      .split(",")
      .filter((s) => s.length > 0)
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join("&");
    const statusResp = await apiFetch<FollowStatusResult>(`/follows/status?${idsQuery}`, {
      request: context.request,
    });
    if (statusResp.status === 401) {
      // 401 → not logged in: buttons render as "Follow" that prompt login on click.
      return new Response(
        JSON.stringify({ following: [], viewerLoggedIn: false, csrfToken: null, viewerId: null }),
        { status: 200, headers },
      );
    }
    if (statusResp.status !== 200) {
      // Any other non-200 is a genuine upstream error (500/502/429/…) — do not
      // masquerade as logged-out. Propagate it honestly so it's distinguishable
      // from a real 401 in logs/devtools; the island falls back safely on !resp.ok.
      return new Response(statusResp.text, { status: statusResp.status, headers });
    }
    const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
    return new Response(
      JSON.stringify({
        following: statusResp.data?.following ?? [],
        viewerLoggedIn: true,
        csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
        viewerId: statusResp.data?.viewerId ?? null,
      }),
      { status: 200, headers },
    );
  }

  // Mode 2: public counts.
  if (counts !== null) {
    const resp = await apiFetch<SocialCounts>(`/public/social?username=${encodeURIComponent(counts)}`);
    return new Response(resp.text, { status: resp.status, headers });
  }

  // Mode 3: public follower/following list.
  if (list === "followers" || list === "following") {
    const username = url.searchParams.get("username") ?? "";
    const cursor = url.searchParams.get("cursor");
    const q = new URLSearchParams({ username });
    if (cursor !== null) q.set("cursor", cursor);
    const resp = await apiFetch<unknown>(`/public/${list}?${q.toString()}`);
    return new Response(resp.text, { status: resp.status, headers });
  }

  return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
};

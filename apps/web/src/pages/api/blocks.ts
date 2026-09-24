/**
 * BROWSER read hop for block state. Two modes, mirroring /api/social.ts:
 *   ?status=id,id,…  → { blocked, viewerLoggedIn, csrfToken, viewerId }  (per-viewer, batched)
 *   (no query)        → { users: BlockedUser[] }                         (the viewer's OWN blocked list)
 * Never cached (markPrivate) — the profile page that consumes ?status= IS
 * cached, so its viewer-specific bit must be fetched live from here; the
 * settings/blocked page that consumes the bare form is itself markPrivate.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { BlockedList, BlockStatusResult } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const url = new URL(context.request.url);
  const status = url.searchParams.get("status");

  if (status !== null) {
    const idsQuery = status
      .split(",")
      .filter((s) => s.length > 0)
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join("&");
    const statusResp = await apiFetch<BlockStatusResult>(`/blocks/status?${idsQuery}`, {
      request: context.request,
    });
    if (statusResp.status === 401) {
      return new Response(
        JSON.stringify({ blocked: [], viewerLoggedIn: false, csrfToken: null, viewerId: null }),
        { status: 200, headers },
      );
    }
    if (statusResp.status !== 200) {
      return new Response(statusResp.text, { status: statusResp.status, headers });
    }
    const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
    return new Response(
      JSON.stringify({
        blocked: statusResp.data?.blocked ?? [],
        viewerLoggedIn: true,
        csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
        viewerId: statusResp.data?.viewerId ?? null,
      }),
      { status: 200, headers },
    );
  }

  const listResp = await apiFetch<BlockedList>("/blocks", { request: context.request });
  if (listResp.status === 401) {
    return new Response(JSON.stringify({ users: [] }), { status: 200, headers });
  }
  return new Response(listResp.text, { status: listResp.status, headers });
};

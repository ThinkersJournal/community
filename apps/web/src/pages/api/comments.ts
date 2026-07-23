/**
 * BROWSER read hop for comment edit-prefill. ANONYMOUS on purpose — the api's
 * `GET /public/comments` reads no session, so forwarding the browser's cookie
 * here would buy nothing and break the anonymous-hop convention (see
 * src/lib/api.ts: omitting `request` is what makes a call anonymous). Never
 * cached (markPrivate) — the island calls this live, not through the edge.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  const { request, cache } = context;
  markPrivate({ request, response: { headers }, cache });
  const url = new URL(request.url);
  const q = new URLSearchParams({ postId: url.searchParams.get("postId") ?? "" });
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) q.set("cursor", cursor);
  // ⚠️ ANONYMOUS on purpose — /public/comments reads no session; forwarding the
  // cookie here would buy nothing and break the anonymous-hop convention.
  const response = await apiFetch<unknown>(`/public/comments?${q.toString()}`);
  return new Response(response.text, { status: response.status, headers });
};

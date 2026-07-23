/**
 * BROWSER → api authed hop for REACTION REMOVE. Same pattern as /api/react:
 * forwards HttpOnly cookie + browser Origin + double-submit CSRF over the
 * Service Binding. The api's DELETE /reactions takes its target as a QUERY
 * STRING, not a JSON body, so the body the island posts is translated into
 * query params here. Never cached (markPrivate).
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const body = (await context.request.json().catch(() => null)) as
    | { postId?: unknown; commentId?: unknown; kind?: unknown }
    | null;
  if (body === null) return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  const q = new URLSearchParams();
  if (typeof body.postId === "string") q.set("postId", body.postId);
  if (typeof body.commentId === "string") q.set("commentId", body.commentId);
  if (typeof body.kind === "string") q.set("kind", body.kind);
  const response = await apiFetch<unknown>(`/reactions?${q.toString()}`, {
    method: "DELETE",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

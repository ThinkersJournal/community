/**
 * BROWSER → api authed hop for POST DELETE. Same pattern as /api/comment-delete:
 * forwards HttpOnly cookie + browser Origin + double-submit CSRF over the
 * Service Binding. Never cached (markPrivate).
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }

  const { postId } = body as { postId?: unknown };
  if (typeof postId !== "string") {
    return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
  }

  const response = await apiFetch<{ username?: string }>("/posts/" + encodeURIComponent(postId), {
    method: "DELETE",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

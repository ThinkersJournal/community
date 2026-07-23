/**
 * BROWSER → api authed hop for COMMENT UPDATE. Same pattern as /api/comment:
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

  const { commentId, markdownSource } = body as { commentId?: unknown; markdownSource?: unknown };
  if (typeof commentId !== "string") {
    return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>("/comments/" + encodeURIComponent(commentId), {
    method: "PATCH",
    body: { markdownSource },
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

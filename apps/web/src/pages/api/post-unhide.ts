/**
 * BROWSER → api authed hop for POST unhide (#61 follow-up / #73). Same
 * pattern as /api/post-delete and /api/post-hide: forwards HttpOnly cookie +
 * browser Origin + double-submit CSRF over the Service Binding. Never cached
 * (markPrivate).
 *
 * The api's own `POST /posts/:id/unhide` (src/moderation/author-hide.ts)
 * refuses with `POST_UNDER_MODERATION` (403) when the post's current hide
 * isn't the author's own — this hop is a plain pass-through of that status
 * and body; it makes no authorization decision of its own.
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

  const response = await apiFetch<{ hidden?: boolean }>(`/posts/${encodeURIComponent(postId)}/unhide`, {
    method: "POST",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

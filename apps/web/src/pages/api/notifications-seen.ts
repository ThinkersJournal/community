/**
 * BROWSER → api authed hop for MARK-SEEN (M2.3c). Advances the caller's badge
 * watermark; same forward-cookie+Origin+CSRF shape as notifications-read. No
 * request body. Never cached.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const response = await apiFetch<unknown>("/notifications/seen", {
    method: "POST",
    body: {},
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

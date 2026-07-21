/**
 * BROWSER → api authed hop for FOLLOW. Same pattern as /media-upload: the
 * island fetches this same-origin endpoint, which forwards the HttpOnly session
 * cookie + the browser's Origin + the double-submit CSRF token to the api over
 * the Service Binding. Never cached (markPrivate).
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let followeeId = "";
  try {
    const body = (await context.request.json()) as { followeeId?: unknown };
    followeeId = typeof body.followeeId === "string" ? body.followeeId : "";
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>("/follows", {
    method: "POST",
    body: { followeeId },
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

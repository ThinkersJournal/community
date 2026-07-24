/**
 * BROWSER → api authed hop for MARK NOTIFICATIONS READ (M2.3a). Same pattern
 * as /api/react: forwards the HttpOnly session cookie + the browser's Origin +
 * the double-submit CSRF token to the api over the Service Binding. The body
 * ({ ids } | { all: true }) is passed through untouched — the api validates
 * it with MarkReadInput, so there is nothing for this hop to pick apart.
 * Never cached (markPrivate).
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

  const response = await apiFetch<unknown>("/notifications/read", {
    method: "POST",
    body,
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

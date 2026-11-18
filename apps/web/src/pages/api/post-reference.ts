// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * BROWSER -> api authed hop for ATTACHING A LINK CARD (M3.4b). Same pattern as /api/react: forwards the HttpOnly
 * cookie + browser Origin + double-submit CSRF over the Service Binding. Never cached (markPrivate).
 *
 * The post id travels in the JSON body (`postId`, uuid-checked here) and builds the upstream path
 * `/posts/<id>/references`; it is stripped from the forwarded body, which the api validates as `{url}` alone.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
  }
  const { postId, ...forwarded } = body as Record<string, unknown>;
  if (typeof postId !== "string" || !UUID_RE.test(postId)) {
    return new Response(JSON.stringify({ code: "INVALID_INPUT", fields: ["postId"] }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>(`/posts/${encodeURIComponent(postId)}/references`, {
    method: "POST",
    body: forwarded,
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

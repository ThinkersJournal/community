/**
 * BROWSER → api authed hop for UNFOLLOW. Forwards to DELETE /follows/:id.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(followeeId)) {
    return new Response(JSON.stringify({ code: "INVALID_INPUT" }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>(`/follows/${encodeURIComponent(followeeId)}`, {
    method: "DELETE",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

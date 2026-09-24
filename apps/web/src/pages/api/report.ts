/**
 * BROWSER → api authed hop for REPORT. Forwards to POST /reports, whose
 * response is already a bare 201 in every outcome (new report, duplicate,
 * threshold tripped) — this proxy does not read or transform the body, so
 * there is nothing here that could start leaking threshold/duplicate state
 * even by accident. Same pattern as /api/follow.
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let body: { postId?: unknown; commentId?: unknown; reason?: unknown };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }

  const forwarded: Record<string, unknown> = { reason: body.reason };
  if (typeof body.postId === "string") forwarded.postId = body.postId;
  if (typeof body.commentId === "string") forwarded.commentId = body.commentId;

  const response = await apiFetch<unknown>("/reports", {
    method: "POST",
    body: forwarded,
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};

/**
 * BROWSER → api authed hop for the notification LIST (M2.3a). Same pattern as
 * /api/social's authed reads: forwards the HttpOnly session cookie over the
 * Service Binding so the api can scope to `recipient_id = session.userId`.
 * No anonymous leg — the bell/page have nothing to show a logged-out viewer.
 * Never cached (markPrivate).
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const cursor = new URL(context.request.url).searchParams.get("cursor");
  const path = cursor === null ? "/notifications" : `/notifications?cursor=${encodeURIComponent(cursor)}`;

  const resp = await apiFetch<unknown>(path, { request: context.request });
  return new Response(resp.text, { status: resp.status, headers });
};

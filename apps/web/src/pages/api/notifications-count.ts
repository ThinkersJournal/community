/**
 * BROWSER → api authed hop for the notification UNREAD COUNT (M2.3a). Same
 * pattern as notifications.ts: forwards the HttpOnly session cookie so the api
 * can scope to `recipient_id = session.userId`. No anonymous leg. Polled by
 * the bell island; never cached (markPrivate).
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const resp = await apiFetch<unknown>("/notifications/unread-count", { request: context.request });
  return new Response(resp.text, { status: resp.status, headers });
};

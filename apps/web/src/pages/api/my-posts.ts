/**
 * BROWSER → api authed hop for `GET /posts` (#78) — every one of the
 * caller's own posts, any status. Same read-hop shape as api/me.ts:
 * forwards the session cookie, JSON in and out, markPrivate.
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { MyPostsPage } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const cursor = new URL(context.request.url).searchParams.get("cursor");
  const path = cursor === null ? "/posts" : `/posts?cursor=${encodeURIComponent(cursor)}`;
  const response = await apiFetch<MyPostsPage>(path, { request: context.request });
  return new Response(response.text, { status: response.status, headers });
};

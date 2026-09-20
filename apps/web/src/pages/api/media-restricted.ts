/**
 * BROWSER → api hop that streams a RESTRICTED media object (#61 / #73) back
 * to the browser — the author viewing their own hidden post's images. See
 * apps/api/src/routes/media-restricted.ts's `GET /media/restricted/:sha256`.
 *
 * ⚠️ NEVER use `apiFetch` (src/lib/api.ts) here: it reads the whole response
 * body as TEXT and JSON-parses it, which would corrupt binary image bytes.
 * A raw `env.API.fetch` + a streamed body passthrough instead — same
 * reasoning as posts-live.ts's WebSocket proxy header.
 *
 * ⚠️ FORWARDS ONLY THE COOKIE, not the whole request — this is a plain GET
 * with no upgrade/CSRF concerns (unlike posts-live.ts's WS handshake), so
 * there is nothing else the api's authorization check needs.
 *
 * `subject=post&subjectId=<postId>` matches the api route's ordinary
 * (non-legal-hold) tier: it re-verifies, on every request, that the named
 * post actually references this key AND that the caller is either that
 * post's author (via the forwarded session cookie) or an admin — see that
 * route's header. This app never reaches the legal-hold tier (that needs an
 * Access-JWT-bearing admin grant, a different trust domain entirely — see
 * src/admin/require-admin.ts).
 */
import { env } from "cloudflare:workers";

import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

/** Matches `mediaKey()`'s hash shape (apps/api/src/routes/media.ts) — anything else is not a real key. */
const SHA256_RE = /^[0-9a-f]{64}$/;

export const GET: APIRoute = async (context) => {
  const headers = new Headers();
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const url = new URL(context.request.url);
  const sha256 = url.searchParams.get("sha256") ?? "";
  const postId = url.searchParams.get("postId") ?? "";
  if (!SHA256_RE.test(sha256) || postId === "") {
    return new Response(null, { status: 404, headers });
  }

  const forwardHeaders = new Headers();
  const cookie = context.request.headers.get("Cookie");
  if (cookie !== null) forwardHeaders.set("Cookie", cookie);

  const upstream = await env.API.fetch(
    `https://api.internal/media/restricted/${sha256}?subject=post&subjectId=${encodeURIComponent(postId)}`,
    { headers: forwardHeaders },
  );

  if (!upstream.ok) {
    return new Response(null, { status: upstream.status, headers });
  }

  headers.set("content-type", upstream.headers.get("content-type") ?? "image/webp");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, { status: 200, headers });
};

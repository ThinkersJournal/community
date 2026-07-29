/**
 * GET /posts/live?postId=<uuid> — the UNAUTHENTICATED per-post live channel.
 * Origin-checked (WS carries cookies, bypasses CORS) but no session: the post is
 * public, its comments/reactions are public, and the frames are content-free
 * ({type} only). Forwards the upgrade to the post's own PostLiveDO.
 */
import { isAllowedOrigin } from "../auth/csrf";
import { errorResponse } from "../http/errors";

import type { RouteHandler } from "../routing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handlerPostsLive: RouteHandler = async (request, env) => {
  if (!isAllowedOrigin(env, request)) return errorResponse("FORBIDDEN", 403);

  const postId = new URL(request.url).searchParams.get("postId") ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("INVALID_INPUT", 400, { fields: ["postId"] });

  // The `Upgrade` token is case-insensitive (RFC 6455 / 7230) — normalize
  // before comparing, matching the web proxy and PostLiveDO.
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  return env.POST_LIVE.getByName(postId).fetch(request);
};

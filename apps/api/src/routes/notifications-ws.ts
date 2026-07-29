/**
 * `GET /notifications/ws` — the authenticated WebSocket upgrade for the
 * realtime bell (M2.3b).
 *
 * Order matters, and mirrors the mutating pipeline's own ordering even though
 * this route does NOT run it (it is a GET that authenticates inline, like
 * `/auth/csrf`):
 *
 *   1. `isAllowedOrigin` — the WS-hijack guard. NOT `checkOrigin`: that helper
 *      exempts GET/HEAD unconditionally, which is correct for ordinary CSRF
 *      (a normal GET is read-only) but wrong here — a WebSocket upgrade is a
 *      GET that establishes a live, cookie-authenticated connection and is NOT
 *      covered by CORS. Going through `checkOrigin` would make this check a
 *      silent no-op. See src/auth/csrf.ts's doc comment on both functions.
 *   2. `readCurrentSession` — the session read PLUS the epoch check, same as
 *      every other session-bearing GET in this Worker (handleCsrf,
 *      handleUnreadCount, ...).
 *   3. The `Upgrade` header check — 426 if this was not actually a WS
 *      handshake (e.g. curl/a browser navigation to the URL).
 *
 * Resolves `userId` from the SESSION ONLY, never a client-supplied param, so a
 * caller can attach to none but their OWN `NotifyDO` — forwarding the upgrade
 * Request straight to it, which returns the `101` + `webSocket` that flows back
 * out through the `web` proxy to the browser.
 */
import { isAllowedOrigin } from "../auth/csrf";
import { readCurrentSession } from "../auth/pipeline";
import { errorResponse } from "../http/errors";

import type { RouteHandler } from "../routing";

export const handleNotificationsWs: RouteHandler = async (request, env) => {
  if (!isAllowedOrigin(env, request)) return errorResponse("FORBIDDEN", 403);

  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;

  // The `Upgrade` token is case-insensitive (RFC 6455 / 7230) — normalize
  // before comparing, matching the web proxy and NotifyDO.
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  return env.NOTIFY.getByName(session.userId).fetch(request);
};

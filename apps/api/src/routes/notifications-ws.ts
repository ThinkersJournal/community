/**
 * `GET /notifications/ws` — the WebSocket upgrade endpoint (M2.3b).
 *
 * ⚠️ SPIKE SCAFFOLDING (Task 0): TEMPORARILY UNAUTHED and hard-wired to a fixed
 * `"spike-user"` DO. The real milestone (Task 2) resolves `userId` from the
 * session (`readCurrentSession`) + an Origin check, then routes to the caller's
 * OWN DO — a client-supplied id must never reach `getByName`. Until then this
 * proves only the transport. See
 * docs/superpowers/spikes/2026-07-25-ws-topology-spike.md.
 *
 * Forwards the incoming upgrade Request straight to the per-user `NotifyDO`,
 * which returns the `101` + `webSocket` that flows back out through the `web`
 * proxy to the browser.
 */
import type { RouteHandler } from "../routing";

const SPIKE_USER = "spike-user";

export const handleNotificationsWs: RouteHandler = async (request, env) => {
  return env.NOTIFY.getByName(SPIKE_USER).fetch(request);
};

/**
 * `GET /notifications/ws-push` — SPIKE-ONLY trigger. Fires a server-initiated
 * `push("notification")` on the spike DO so the round-trip's "server → browser"
 * leg can be exercised from a plain HTTP request. Deleted with the rest of the
 * spike auth-bypass when Task 2 wires `notify()` to the real push.
 */
export const handleNotificationsWsPush: RouteHandler = async (_request, env) => {
  await env.NOTIFY.getByName(SPIKE_USER).push("notification");
  return new Response("pushed", { status: 200 });
};

/**
 * BROWSER → api WebSocket upgrade proxy (M2.3b).
 *
 * ⚠️ SPIKE SCAFFOLDING (Task 0). Forwards an incoming WS upgrade to the `api`
 * Worker's `/notifications/ws` over the `API` Service Binding and hands the
 * resulting `101` + `webSocket` back to the browser. The Task-0 spike PROVED
 * both unknowns: the Service Binding DOES carry the upgrade (in and out, incl.
 * server-initiated frames), and an Astro APIRoute CAN return the 101 — but only
 * via the hand-reconstructed form below; returning `upstream` verbatim yields a
 * 500 handshake error. See docs/superpowers/spikes/2026-07-25-ws-topology-spike.md.
 *
 * ⚠️ CANNOT use `apiFetch` (src/lib/api.ts): that helper reads the whole
 * response body as text, which would consume/destroy a 101 upgrade.
 *
 * `env` comes from `cloudflare:workers`, NOT `Astro.locals.runtime.env` (removed
 * in Astro v6+) — same rule as src/lib/api.ts.
 */
import { env } from "cloudflare:workers";

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  if (context.request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }

  // Forward the upgrade over the Service Binding, carrying the Upgrade (and, in
  // the real milestone, Cookie + Origin) headers. The api resolves the target
  // DO and returns the 101.
  const upstream = await (
    env as unknown as { API: { fetch: (url: string, init: RequestInit) => Promise<Response> } }
  ).API.fetch("https://api.internal/notifications/ws", {
    headers: context.request.headers,
  });

  // ⚠️ SPIKE FINDING (Task 0): returning `upstream` verbatim yields a 500
  // handshake error — @astrojs/cloudflare does NOT pass a raw 101+webSocket
  // Response through. A hand-reconstructed 101 carrying the client socket is
  // REQUIRED for the adapter to return the upgrade. See the spike doc.
  const ws = (upstream as unknown as { webSocket?: unknown }).webSocket;
  if (upstream.status === 101 && ws) {
    return new Response(null, {
      status: 101,
      // `webSocket` is a workerd Response extension not in the DOM lib types.
      webSocket: ws,
    } as ResponseInit);
  }

  return upstream;
};

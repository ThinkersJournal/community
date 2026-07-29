/**
 * BROWSER → api WebSocket upgrade proxy (M2.3b) — per-post live channel.
 *
 * Forwards an incoming WS upgrade to the `api` Worker's `/posts/live`
 * over the `API` Service Binding, carrying the `postId` query param, and
 * hands the resulting `101` + `webSocket` back to the browser, so `api` can
 * auth the session (Cookie) and origin-check (Origin) the socket itself.
 *
 * ⚠️ HAND-RECONSTRUCT THE 101 — a Task-0 spike finding, do NOT "simplify"
 * this away. Returning the upstream Response verbatim yields a 500 handshake
 * error: @astrojs/cloudflare does NOT pass a raw 101+webSocket Response
 * through. The `new Response(null, { status: 101, webSocket: ws })` below is
 * REQUIRED for the adapter to return the upgrade. See
 * docs/superpowers/spikes/2026-07-25-ws-topology-spike.md.
 *
 * ⚠️ NEVER use `apiFetch` (src/lib/api.ts) here: it reads the whole response
 * body as text, which would consume/destroy a 101 upgrade.
 *
 * `env` comes from `cloudflare:workers`, NOT `Astro.locals.runtime.env`
 * (removed in Astro v6+) — same rule as src/lib/api.ts.
 *
 * Headers are forwarded WHOLESALE (`context.request.headers`), never filtered
 * down to just Cookie/Origin: the WS handshake also needs
 * `Sec-WebSocket-Key`/`-Version`/`-Extensions` and `Connection`. Wholesale
 * forwarding is what carries Cookie + Origin — the auth/origin-check this
 * route exists for — AND the handshake headers the upgrade itself needs.
 */
import { env } from "cloudflare:workers";

import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  // This route is per-viewer authed, so it must declare its cacheability like
  // every other page (test/page-cache-inventory.test.ts SWEEP A). A 101
  // protocol switch is never cached and carries no header of its own, but
  // every OTHER response this handler can return (426 rejection, non-101
  // fallback) gets `headers` marked private up front.
  const headers = new Headers();
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  if (context.request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426, headers });
  }

  // Forward the upgrade over the Service Binding, carrying every header —
  // Cookie + Origin (api auths the session and origin-checks) plus the
  // Sec-WebSocket-* handshake headers the upgrade itself needs. The api
  // resolves the target DO and returns the 101.
  const postId = new URL(context.request.url).searchParams.get("postId") ?? "";
  const upstream = await (
    env as unknown as { API: { fetch: (url: string, init: RequestInit) => Promise<Response> } }
  ).API.fetch(`https://api.internal/posts/live?postId=${encodeURIComponent(postId)}`, {
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

  // Non-101 fallback (e.g. api rejected the upgrade: unauthenticated, bad
  // Origin). Carry upstream's body and status, but OUR cache headers — not
  // upstream's — so this per-viewer response still declares itself private.
  //
  // ⚠️ NEVER pass a bare 101 through here. We only reach this branch when the
  // status ISN'T 101, OR it is 101 but carried no `webSocket` (a broken
  // upstream — the api always pairs them). Constructing `new Response(body,
  // {status:101})` WITHOUT a webSocket throws a RangeError (101 is outside the
  // constructor's valid 200–599 range; the reconstruction above is the one
  // legal 101 form). Coerce that impossible-but-fatal case to a 502 so the
  // proxy degrades cleanly instead of 500ing.
  const status = upstream.status === 101 ? 502 : upstream.status;
  return new Response(upstream.body, { status, headers });
};

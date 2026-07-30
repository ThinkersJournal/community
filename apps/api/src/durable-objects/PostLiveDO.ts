/**
 * `PostLiveDO` — a per-post WebSocket relay, one Durable Object instance per
 * post (addressed via `getByName(postId)`). Holds hibernating WebSocket
 * connections and relays tiny content-free "refresh" nudges to every open
 * socket.
 *
 * It is NOT a security boundary — the channel is UNAUTHED at the route (any
 * viewer of a public post page may subscribe) — and it holds NO comment or
 * reaction content or durable state; it is a dumb relay. The `new_sqlite_classes`
 * migration is required by platform rules (KV-backed `new_classes` is blocked
 * for new namespaces) even though storage is unused here.
 */
import { DurableObject } from "cloudflare:workers";

export class PostLiveDO extends DurableObject<Env> {
  /**
   * The WS upgrade entry point. Validates `Upgrade: websocket`, creates a
   * `WebSocketPair`, hands the server end to the Hibernation API
   * (`acceptWebSocket` → ~zero idle cost, survives eviction), and returns the
   * client end as a `101` response the caller relays back to the browser.
   */
  async fetch(request: Request): Promise<Response> {
    // The `Upgrade` token is case-insensitive (RFC 6455 / 7230) — normalize
    // before comparing, matching the web proxy (apps/web/src/pages/api/
    // notifications-ws.ts). Browsers send lowercase, but a non-browser client
    // or a re-casing intermediary sending "WebSocket" must not be rejected.
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The client only sends keepalive pings — nothing to do. Deliberately NOT an
   * echo: this DO relays server-initiated push()es only, never reflects
   * client input back onto the socket.
   */
  webSocketMessage(): void {}

  /** No-op cleanup — hibernation + auto-close-reply handle it. */
  webSocketClose(): void {}

  /**
   * RPC called by `api` handlers after a comment / reaction write. Pushes a
   * tiny content-free nudge (`{type:kind}` — no ids, no counts, no actor) to
   * every open socket on this post's DO. Each send is isolated in its own
   * try/catch so one dead/closing socket can't block delivery to the rest.
   */
  push(kind: "comment" | "reaction"): void {
    const frame = JSON.stringify({ type: kind });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        /* a dead socket is harmless; hibernation/close-reply reaps it */
      }
    }
  }
}

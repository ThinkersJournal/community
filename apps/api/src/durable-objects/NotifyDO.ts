/**
 * `NotifyDO` — a per-user WebSocket relay, one Durable Object instance per user
 * (addressed via `getByName(userId)`). Holds hibernating WebSocket connections
 * and relays tiny content-free "refresh" nudges to every open socket.
 *
 * ⚠️ SPIKE SCAFFOLDING (M2.3b Task 0). This is the minimal stub that the Task-0
 * connectivity spike exercises end-to-end (browser → web → Service Binding →
 * api → this DO). If the DO-in-`api` topology is confirmed it becomes the
 * foundation for Tasks 1/2/5; the spike's `fetch()` is temporarily UNAUTHED
 * (auth lives at the api route, added in Task 2). See
 * docs/superpowers/spikes/2026-07-25-ws-topology-spike.md.
 *
 * It is NOT a security boundary and holds NO notification content or durable
 * state — it is a dumb relay. The `new_sqlite_classes` migration is required by
 * platform rules (KV-backed `new_classes` is blocked for new namespaces) even
 * though storage is unused here.
 */
import { DurableObject } from "cloudflare:workers";

export class NotifyDO extends DurableObject<Env> {
  /**
   * The WS upgrade entry point. Validates `Upgrade: websocket`, creates a
   * `WebSocketPair`, hands the server end to the Hibernation API
   * (`acceptWebSocket` → ~zero idle cost, survives eviction), and returns the
   * client end as a `101` response the caller relays back to the browser.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Echo, for the spike's round-trip proof. In the real milestone the client
   * only sends keepalive pings and this becomes a no-op.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string") {
      ws.send(`echo:${message}`);
    }
  }

  /** No-op cleanup — hibernation + auto-close-reply handle it. */
  webSocketClose(): void {}

  /**
   * RPC called by `api` handlers after a notification write / mark-read. Pushes
   * a tiny content-free nudge to every open socket on this user's DO.
   */
  push(kind: "notification" | "read"): void {
    const frame = JSON.stringify({ type: kind });
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(frame);
    }
  }
}

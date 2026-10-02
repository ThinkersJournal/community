/**
 * The client's real IP, for rate limiters and audit trails.
 *
 * ⚠️ TRUST BOUNDARY. The api has no public ingress: `workers_dev: false`
 * (apps/api/wrangler.jsonc:10) and no `routes` key anywhere in that file — the
 * `web` Worker's `API` Service Binding is its WHOLE surface (same fact
 * src/index.ts and apps/web/src/lib/api.ts's file header both rely on). A
 * Service Binding dispatches Worker-to-Worker inside Cloudflare, never over
 * the public internet, so `CLIENT_IP_HEADER` cannot arrive from a browser —
 * only `web` can set it, and `web` sets it from its own middleware's read of
 * `CF-Connecting-IP` (apps/web/src/middleware.ts), never from anything a
 * browser sends directly.
 *
 * `CF-Connecting-IP` itself does NOT survive the Service-Binding hop —
 * `env.API.fetch()` builds a brand-new request with none of the browser's
 * original headers (see apps/web/src/lib/api.ts's file header, item 3) — so
 * it is checked here only as a fallback for a direct `worker.fetch()` call
 * that bypasses `web` entirely, which is exactly how every test in this repo
 * (e.g. apps/api/test/search.test.ts) drives this Worker.
 */
import { CLIENT_IP_HEADER } from "@thinkersjournal/shared";

export function clientIp(request: Request): string | null {
  return request.headers.get(CLIENT_IP_HEADER) ?? request.headers.get("CF-Connecting-IP") ?? null;
}

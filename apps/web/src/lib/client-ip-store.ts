/**
 * Carries the real browser IP from the Astro middleware (which sees the
 * incoming request's `CF-Connecting-IP`) to `apiFetch` (which has only a
 * synthetic Service-Binding request with no IP of its own — see api.ts's
 * file header, item 3).
 *
 * ⚠️ `AsyncLocalStorage`, NOT a module-level variable: a Worker handles
 * concurrent requests on one isolate, so a plain variable would leak one
 * request's IP into another's `apiFetch` calls racing alongside it.
 * `node:async_hooks` works here because the web Worker sets
 * `nodejs_compat` (apps/web/wrangler.jsonc) — confirmed with `astro build`
 * + `wrangler dev` against this exact module (see the task report); this
 * is the ALS path, not the `ApiFetchOptions`-threading fallback the brief
 * allowed for if ALS turned out not to work.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { CLIENT_IP_HEADER } from "@thinkersjournal/shared";

export interface ClientIpStore {
  clientIp: string | null;
}

export const clientIpStore = new AsyncLocalStorage<ClientIpStore>();

/**
 * Runs `next` inside the store, seeded with `request`'s `CF-Connecting-IP`.
 *
 * Pulled out of middleware.ts into a plain function so it has a real unit
 * test: middleware.ts imports `astro:middleware`, a virtual module Vite only
 * resolves inside Astro's own build/dev pipeline — it cannot be imported by
 * this app's plain-Node vitest (see vitest.config.ts's header), so none of
 * the logic can live only there.
 */
export function runWithClientIp<T>(request: Request, next: () => T): T {
  const clientIp = request.headers.get("CF-Connecting-IP");
  return clientIpStore.run({ clientIp }, next);
}

/**
 * Sets (or removes) `headers`' `CLIENT_IP_HEADER` to exactly `ip`.
 *
 * Pure (no ALS read) so it has a real unit test independent of the store —
 * apiFetch is the only caller, and it always passes
 * `clientIpStore.getStore()?.clientIp ?? null`.
 *
 * ⚠️ Always deletes any pre-existing value FIRST, whatever set it — a caller
 * or (were this header ever to reach a browser-facing surface) a browser
 * itself — so this function's own write is always the last word. apiFetch
 * calls it LAST, after every other header it sets, for the same reason: an
 * earlier call couldn't un-override a later caller-supplied value.
 *
 * `ip === null` (no store — ALS never entered, e.g. a call made outside the
 * middleware's `next()` — or the store's `clientIp` itself is null, e.g. in
 * dev off Cloudflare where the incoming request had no `CF-Connecting-IP`)
 * only deletes — no header is sent, and the api's `clientIp()` helper falls
 * back the same way it always has.
 */
export function applyClientIpHeader(headers: Headers, ip: string | null): void {
  headers.delete(CLIENT_IP_HEADER);
  if (ip !== null) {
    headers.set(CLIENT_IP_HEADER, ip);
  }
}

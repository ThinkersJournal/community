/**
 * Astro middleware: the ONLY place that reads `CF-Connecting-IP` on this
 * side. Everything downstream (every page, `apiFetch`) sees the IP only via
 * `clientIpStore` (./lib/client-ip-store.ts) — never off the request again.
 *
 * There was no prior middleware file (checked astro.config.mjs and src/ for
 * existing wiring before adding this one), so there is nothing to compose
 * with.
 *
 * Kept deliberately thin: `astro:middleware` is a virtual module Vite only
 * resolves inside Astro's own build/dev pipeline, so this file can't be
 * imported by this app's plain-Node vitest (see vitest.config.ts's header).
 * The actual logic lives in `runWithClientIp`, which IS unit-tested
 * (test/client-ip-store.test.ts); this file is pinned structurally instead
 * (test/middleware.test.ts).
 */
import { defineMiddleware } from "astro:middleware";

import { runWithClientIp } from "./lib/client-ip-store";

export const onRequest = defineMiddleware((context, next) =>
  runWithClientIp(context.request, next),
);

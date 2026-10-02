import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `src/middleware.ts` — SOURCE/STRUCTURE TEST, NOT A DRIVE: the file imports
 * `astro:middleware`, a virtual module Vite only resolves inside Astro's own
 * build/dev pipeline (checked directly — see the task report), so it cannot
 * be imported here (same constraint test/login-page.test.ts documents for
 * `cloudflare:workers`). The behaviour this file delegates to —
 * `runWithClientIp` running `next` inside the IP store — IS driven, with a
 * fake request and a fake `next`, in test/client-ip-store.test.ts.
 *
 * This file pins the wiring: `onRequest` is built with `defineMiddleware` and
 * does nothing but hand `context.request` and `next` to `runWithClientIp`, so
 * the two can't drift apart.
 */
const code = readFileSync(join(import.meta.dirname, "../src/middleware.ts"), "utf8");

describe("middleware.ts", () => {
  it("defines onRequest via astro's defineMiddleware", () => {
    expect(code).toContain("defineMiddleware");
    expect(code).toMatch(/export const onRequest = defineMiddleware/);
  });

  it("delegates to runWithClientIp with the request and next — no inline IP logic", () => {
    expect(code).toContain("runWithClientIp(context.request, next)");
    // The actual header READ lives only in client-ip-store.ts — this file may
    // still mention the header name in prose (its own file header does).
    expect(code).not.toMatch(/\.headers\.get\(/);
  });
});

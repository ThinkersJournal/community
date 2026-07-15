import { defineConfig } from "vitest/config";

/**
 * Plain Node vitest — deliberately NOT `@cloudflare/vitest-pool-workers` (what
 * apps/api uses). The only thing under test here is `src/lib/next-url.ts`, a
 * pure function over the WHATWG `URL` parser, which Node and workerd implement
 * identically. Spinning up workerd for it would buy nothing and cost seconds.
 *
 * The `.astro` pages are NOT tested here: they are thin server-rendered glue
 * over `src/lib/api.ts`, exercised end-to-end against both real Workers via
 * `wrangler dev` (see the task report). Rendering them in isolation would mean
 * mocking the `API` Service Binding — i.e. testing the mock.
 */
export default defineConfig({
  test: {
    name: "web",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

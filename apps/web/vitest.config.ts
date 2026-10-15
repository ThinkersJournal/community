import { join } from "node:path";

import { getViteConfig } from "astro/config";

/**
 * Plain Node vitest — deliberately NOT `@cloudflare/vitest-pool-workers` (what
 * apps/api uses). Most files here are source scans or pure functions over the
 * WHATWG `URL` parser, which Node and workerd implement identically.
 *
 * `getViteConfig` (astro/config) adds Astro's own Vite plugins so a test may
 * `import Page from "../src/pages/x.astro"` and render it with Astro's
 * container API (see test/helpers/render-page.ts). The Cloudflare adapter is
 * NOT loaded (`configFile: false`): only the `.astro` compiler matters here,
 * and workerd is not needed. `cloudflare:workers` is aliased to a Node stub.
 */
export default getViteConfig(
  {
    resolve: {
      alias: {
        "cloudflare:workers": join(import.meta.dirname, "test/helpers/cloudflare-workers-stub.ts"),
      },
    },
    // @ts-expect-error — `test` is vitest's key; getViteConfig's type is vite's.
    test: {
      name: "web",
      environment: "node",
      include: ["test/**/*.test.ts"],
    },
  },
  { configFile: false, output: "server" },
);

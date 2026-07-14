import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `@cloudflare/vitest-pool-workers@0.18.x` (Vitest 4) exposes its integration as
// the `cloudflareTest()` Vite plugin. The older `defineWorkersConfig` /
// `defineWorkersProject` exports from `@cloudflare/vitest-pool-workers/config`
// were removed in this line — there is no `./config` subpath in the installed
// package. Options previously nested under `test.poolOptions.workers` are now
// passed directly to `cloudflareTest()`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});

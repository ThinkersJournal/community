import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// The api package runs tests in TWO environments from a single `vitest run`:
//
//   1. "pool"  — the existing Worker tests (health, password) run inside REAL
//                workerd via `@cloudflare/vitest-pool-workers` (the
//                `cloudflareTest()` plugin, scoped to this project).
//   2. "node"  — this task's migration/schema test (`*.db.test.ts`) runs in a
//                plain Node environment with a direct `pg` TCP connection to
//                Postgres. It cannot run in workerd (needs node-pg-migrate + pg
//                + information_schema, and there is no Hyperdrive binding yet).
//
// `cloudflareTest()` is a Vitest plugin whose `configureVitest` hook sets the
// pool on `context.project` only, so placing it in the pool project's `plugins`
// keeps workerd out of the Node project.
export default defineConfig({
  test: {
    // Applies the DB migrations ONCE in Node before any project runs. Idempotent
    // (node-pg-migrate's `pgmigrations` table). Declared at the root so it also
    // covers Task 6's pool DB tests (Hyperdrive → same test DB).
    globalSetup: ["./test/global-setup.ts"],
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "pool",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/**/*.db.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.db.test.ts"],
        },
      },
    ],
  },
});

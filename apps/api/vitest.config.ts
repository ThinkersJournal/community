import { createRequire } from "node:module";
import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// Two `pg` transitive deps ship an ESM entry that the pool's module-fallback
// loader mishandles inside workerd. Redirect each bare specifier to its CJS
// `dist` build so the whole `pg` chain loads as CJS:
//
//   • pg-protocol  — its `import` condition is `./esm/index.js`, an ESM file
//     with a `.js` extension in a package that is NOT `type: "module"`, so the
//     loader evaluates it as CJS → "Cannot use import statement outside a
//     module". `dist/index.js` is the equivalent CJS build.
//   • pg-cloudflare — the workerd socket impl. Its `esm/index.mjs` re-exports
//     the CJS `dist` via `import cf from '../dist/index.js'`; under the pool's
//     require→ESM interop the `CloudflareSocket` binding comes back undefined
//     ("CloudflareSocket is not a constructor"). `dist/index.js` exports the
//     class directly and uses `await import('cloudflare:sockets')`, which
//     workerd provides.
//
// This is a TEST-ONLY shim (real `wrangler` builds bundle `pg` correctly). It
// MUST live at the ROOT `plugins` (not the pool project's) because the pool's
// module-fallback service resolves via the Vitest root Vite server
// (`project.vitest.vite`), not the per-project Vite instance.
const require = createRequire(import.meta.url);
const toPosix = (p: string) => p.replace(/\\/g, "/");
const pgCjsRedirects: Record<string, string> = {
  "pg-protocol": toPosix(require.resolve("pg-protocol/dist/index.js")),
  // pg-cloudflare does not export `./dist/*`, so anchor off its package.json.
  "pg-cloudflare": toPosix(
    path.join(
      path.dirname(require.resolve("pg-cloudflare/package.json")),
      "dist/index.js",
    ),
  ),
};

const pgCjsRedirectPlugin = {
  name: "pg-cjs-redirect",
  enforce: "pre" as const,
  resolveId(id: string) {
    return pgCjsRedirects[id] ?? null;
  },
};

// The local Postgres both Hyperdrive bindings resolve to in tests. Defaults to
// the Docker test DB; CI can override via TEST_DATABASE_URL.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

// The pool loads `wrangler.jsonc` via `unstable_getMiniflareWorkerOptions`,
// which REQUIRES a local connection string for every Hyperdrive binding and
// THROWS before the `miniflare.hyperdrives` override below is merged. Supply it
// through wrangler's documented env var so the wrangler parse succeeds; both the
// env var and the override point at the same test DB.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED ??=
  TEST_DATABASE_URL;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH ??=
  TEST_DATABASE_URL;

// Keep test output pristine: wrangler logs an info-level "Found a non-empty
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_* variable" line (level "log")
// each time the pool parses the config. Raise the threshold to "warn" so real
// warnings/errors still surface; honor an explicit user override.
process.env.WRANGLER_LOG ??= "warn";

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
  // Root-level so the pool's module-fallback service (which resolves through the
  // Vitest root Vite server) applies the `pg` → CJS redirects.
  plugins: [pgCjsRedirectPlugin],
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
            // Resolve BOTH Hyperdrive bindings to the local test DB. The real
            // FRESH-vs-CACHED caching difference only exists on Cloudflare's
            // Hyperdrive; locally each just opens a direct connection, so both
            // point at the same test database. `wrangler.jsonc`'s placeholder
            // ids are never dereferenced because this override supplies the URL.
            miniflare: {
              hyperdrives: {
                HYPERDRIVE_CACHED: TEST_DATABASE_URL,
                HYPERDRIVE_FRESH: TEST_DATABASE_URL,
              },
            },
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

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
              // Miniflare simulates R2 locally with an in-memory bucket. The
              // name need only match wrangler.jsonc's binding.
              r2Buckets: ["MEDIA"],
              // ⚠️ REQUIRED, NOT OPTIONAL — the pool will not START without it.
              // wrangler.jsonc declares `services: [{ binding: "WEB", service:
              // "thinkersjournal-web" }]` (the purge hop), and miniflare
              // resolves service bindings by NAME against workers it actually
              // has. `web` is a different package that is not in this pool, so
              // without this override every test file dies before it runs with:
              //
              //   Worker "core:user:vitest-pool-workers-runner-pool"'s binding
              //   "WEB" refers to a service "core:user:thinkersjournal-web",
              //   but no such service is defined.
              //
              // A 200 is the RIGHT default rather than a throw: test/posts.test.ts
              // drives the real handlers with the real `env`, so publishing a post
              // there genuinely dispatches a purge through this binding. Answering
              // "web accepted it" keeps that suite's output pristine (purgeTags
              // logs on a non-2xx) without asserting anything about purging.
              //
              // ⚠️ THIS STUB PROVES NOTHING ABOUT THE HOP — AND IT DISPROVES
              // NOTHING EITHER, WHICH IS THE DANGEROUS HALF. It creates `WEB`
              // regardless of what wrangler.jsonc says, so DELETING the `services`
              // block there leaves all api tests GREEN while production gets
              // `env.WEB === undefined` -> TypeError -> swallowed by purgeTags'
              // own catch -> one log line and every purge silently dead forever.
              // Verified by doing exactly that.
              //
              // ⚠️ THAT HOLE IS NOW PINNED ELSEWHERE, BY NECESSITY:
              // test/purge-binding.node.test.ts asserts the real `services` block
              // from the real file. It cannot live in THIS project — workerd's
              // filesystem is virtual (`/bundle`), so a pool test cannot read
              // wrangler.jsonc at all. Do not delete that test thinking this stub
              // covers it; it is the only thing that does.
              //
              // The tests that care about behaviour (test/purge.test.ts,
              // test/purge-wiring.test.ts) pass their OWN `WEB` stub in the `env`
              // they hand to `worker.fetch`, and observe that.
              serviceBindings: {
                WEB: () =>
                  new Response(JSON.stringify({ purged: 0 }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  }),
              },
              // Values for vars/secrets that live in the gitignored
              // `apps/api/.dev.vars`, so CI checkouts never have them. Supplied
              // directly here to keep the suite CI-safe without depending on
              // `.dev.vars` existing at test-run time.
              bindings: {
                // A SECRET (see src/auth/turnstile.ts). Cloudflare's published
                // dummy "always passes" secret.
                TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
                // A SECRET (see src/auth/email-verify.ts). Never used against
                // the real API: test/email-verify.test.ts stubs global `fetch`
                // and asserts this exact value is sent as the Postmark header.
                POSTMARK_SERVER_TOKEN: "test-postmark-token",
                // Gates the TEST-ONLY `GET /__test/last-verify-token` route
                // (src/routes/__test.ts). Set HERE (and in .dev.vars) but NEVER
                // in wrangler.jsonc's `vars` — in production it must be unset,
                // which makes that route 404 like any nonexistent path.
                // test/email-verify.test.ts covers BOTH states.
                TEST_ROUTES: "1",
                // A SECRET (src/cache/purge.ts). Supplied here so the suite is
                // CI-safe without .dev.vars. Must match apps/web/.dev.vars for
                // the E2E's cross-process purge hop to authenticate.
                PURGE_SECRET: "dev-purge-secret-not-for-production",
                // A SECRET (src/notifications/unsub-token.ts). Dummy HMAC key for tests.
                UNSUBSCRIBE_SIGNING_KEY: "test-unsub-signing-key",
              },
            },
          }),
        ],
        test: {
          name: "pool",
          include: ["test/**/*.test.ts"],
          // ⚠️ NOT A LATENCY ASSERTION — a headroom for REAL I/O. Every test in
          // this project drives the handlers through workerd against the live
          // Docker Postgres, and the seed-heavy ones do many SEQUENTIAL DB
          // round trips (e.g. public-reads' keyset test posts 25 rows one at a
          // time to get two pages, ordered). Vitest runs the "pool" and "node"
          // projects in PARALLEL, so those seeds contend for Postgres and, as
          // more DB-integration files are added, honest work crept past the 5s
          // default and flaked RED (observed at 5.0s — a timeout, not a wrong
          // answer). This ceiling is generous enough that legitimate seeding
          // never trips it while a genuine hang still fails the run.
          testTimeout: 20_000,
          // ⚠️ `*.node.test.ts` is excluded for a REASON THAT IS NOT STYLE: workerd
          // has a VIRTUAL filesystem rooted at `/bundle`, so a test in this project
          // cannot read the repo's own files at all — `readFileSync("wrangler.jsonc")`
          // fails with `no such file or directory, readAll '/bundle/wrangler.jsonc'`
          // (verified). Any test that must ASSERT ON CONFIG SOURCE therefore has to
          // run in the Node project below.
          exclude: [...configDefaults.exclude, "test/**/*.db.test.ts", "test/**/*.node.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          // `*.db.test.ts` — needs pg/node-pg-migrate/information_schema.
          // `*.node.test.ts` — needs the REAL filesystem to assert on config
          // source (workerd's is virtual; see the pool project's exclude).
          include: ["test/**/*.db.test.ts", "test/**/*.node.test.ts"],
          // NOTE: no `fileParallelism: false` here, deliberately. The
          // destructive full-stack drop/recreate that would have required it
          // (migrations.db.test.ts) now runs against its OWN database, so
          // nothing in this project can drop a table another test — in this
          // project OR in the concurrently-running "pool" project — is querying.
          // Serializing would only have covered THIS project anyway: vitest runs
          // projects in parallel unless `sequence.groupOrder` is set, so the
          // pool's Hyperdrive tests were still exposed. The database split fixes
          // both, and cannot be lost the way a scheduling constraint can.
        },
      },
    ],
  },
});

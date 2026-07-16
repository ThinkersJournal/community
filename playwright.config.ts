import { defineConfig, devices } from "@playwright/test";

/**
 * E2E across BOTH Workers, in a real browser, against real Postgres.
 *
 * WHAT THIS PROVES that no other suite can: a browser drives signup -> email
 * verification -> post creation through the `web` Worker, which reaches the
 * `api` Worker only over the Service Binding. The api's vitest suite stubs the
 * browser; this does not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ TOPOLOGY — TWO wrangler processes, NOT one. This is forced, not a choice.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The obvious form runs both Workers in ONE process:
 *
 *     wrangler dev -c apps/web/dist/server/wrangler.json -c apps/api/wrangler.jsonc --port 8787
 *
 * The FIRST `-c` is the primary Worker and gets the port; every later `-c` is an
 * AUXILIARY worker reachable ONLY through a Service Binding. That is faithful to
 * production (the api has no public route) and it is what Task 18 used — but it
 * makes this suite IMPOSSIBLE to write, because an auxiliary worker has no
 * address. The test must read the emailed verification token out of
 * `GET /__test/last-verify-token`, which lives on the **api**. Verified: against
 * the single-process form, `curl :8787/__test/last-verify-token` -> **404**,
 * because :8787 is the web Worker, which has no such route and never will.
 *
 * So the api runs as its OWN primary on :8788, and web's `API` binding reaches
 * it ACROSS PROCESSES — wrangler's dev registry connects service bindings
 * between separate `wrangler dev` processes. Verified live: web logs
 * `env.API (thinkersjournal-api) Worker local [connected]`, and `GET :8787/`
 * renders `api-status: 200 / ok`, a value that exists only inside the api.
 *
 * ⚠️ THE SECURITY PROPERTY IS UNCHANGED, AND THE TEST MUST KEEP IT THAT WAY.
 * The BROWSER still only ever talks to :8787. :8788 is a DEV-ONLY affordance for
 * the harness, in the same category as `TEST_ROUTES` itself — it is how the test
 * stands in for an email inbox, not a route the app uses. `e2e/signup.spec.ts`
 * touches :8788 for exactly one thing (reading the token) and drives everything
 * else through the browser at :8787. Do not "simplify" the spec by calling the
 * api directly for anything else: that would test the api, which vitest already
 * does, and stop testing the two-Worker spine, which nothing else does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ ORDER IS LOAD-BEARING: api FIRST, then web.
 * ─────────────────────────────────────────────────────────────────────────────
 * Playwright sets webServers up in array order, each waiting for its `url`
 * before the next starts. The api must be listening before web starts, or web's
 * `API` binding comes up `[not connected]` and every page 500s.
 */

/** The `web` Worker — the ONLY origin the browser is allowed to know about. */
const WEB_PORT = 8787;
/** The `api` Worker — dev-only exposure, for reading the verification token. */
const API_PORT = 8788;

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

/**
 * The local Postgres both Hyperdrive bindings resolve to. This is the DEV
 * database (`thinkersjournal`), NOT the vitest one (`thinkersjournal_test`):
 * the E2E writes real users through the real signup path and they persist, so
 * every run uses a fresh `crypto.randomUUID()` email rather than truncating
 * tables under a suite that may be running concurrently.
 *
 * ⚠️ Hyperdrive ids in wrangler.jsonc are placeholders; wrangler NEVER
 * dereferences them locally because this env var supplies the connection
 * directly. The var name encodes the binding: `..._<BINDING_NAME>`.
 */
const DEV_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal";

const hyperdriveEnv = {
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH: DEV_DATABASE_URL,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED: DEV_DATABASE_URL,
};

/**
 * The api's vars, passed as `--var` on the command line rather than relying on
 * `apps/api/.dev.vars`.
 *
 * ⚠️ WHY NOT `.dev.vars`: it is GITIGNORED (it is where real secrets go), so a
 * fresh clone / CI checkout does not have it and the suite would fail with a
 * confusing 403 from Turnstile rather than "you are missing a file". This
 * mirrors the choice `apps/api/vitest.config.ts` already made for the same
 * reason ("Supplied directly here to keep the suite CI-safe without depending
 * on `.dev.vars` existing at test-run time"). Verified: with `.dev.vars` moved
 * aside entirely, these flags alone drive signup -> 201 and the token route.
 *
 * ⚠️ EVERY VALUE HERE IS A PUBLIC DUMMY. Nothing real may ever be committed to
 * this file:
 *   • TURNSTILE_SECRET_KEY is Cloudflare's PUBLISHED always-passes test secret.
 *   • POSTMARK_SERVER_TOKEN is a fake. Postmark will reject the send; that is
 *     FINE and intentional — `sendVerificationEmail` never throws, it logs
 *     ("postmark rejected send") and returns, precisely so a mail failure cannot
 *     500 a signup. The test reads the token from KV instead, which is what the
 *     `__test` route exists for.
 *   • TEST_ROUTES="1" is dev/CI ONLY. It gates the `__test` token route AND
 *     (see apps/api/src/auth/session.ts) relaxes the session cookie's
 *     Domain/Secure so a browser can actually store it on http://127.0.0.1.
 *     It MUST be unset in production — the deploy-gate checklist in README.md
 *     covers both consequences.
 *   • PURGE_SECRET is a dev placeholder, and it is passed to BOTH Workers below
 *     (`apiVars` and `webVars`) because it must MATCH on both ends. Production
 *     sets a real high-entropy value with `wrangler secret put` on each.
 */

/**
 * The purge hop's shared secret. ⚠️ THE SAME VALUE ON BOTH WORKERS, deliberately:
 * `api` sends it over the `WEB` binding and `web` compares it in constant time,
 * so a mismatch is a 403 and a silently un-purged cache.
 *
 * ⚠️ THE PURGE HOP IS THE ONE api->web DIRECTION. It works across the dev registry
 * exactly the way web->api does (the same mechanism that makes the `API` binding
 * resolve between these two processes) — which is what makes the bindings CIRCULAR
 * here as in production. See apps/api/wrangler.jsonc's `services` block for the
 * first-deploy ordering that circularity forces.
 */
const PURGE_SECRET = "dev-purge-secret-not-for-production";

const apiVars = [
  "--var",
  "TEST_ROUTES:1",
  "--var",
  "TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA",
  "--var",
  "POSTMARK_SERVER_TOKEN:dummy-postmark-token-not-a-real-secret",
  "--var",
  `PURGE_SECRET:${PURGE_SECRET}`,
].join(" ");

/** The `web` Worker's vars — same reasoning as `apiVars`, same dummy secret. */
const webVars = ["--var", `PURGE_SECRET:${PURGE_SECRET}`].join(" ");

export default defineConfig({
  testDir: "./e2e",
  // The spec's two cases share one dev server and one database, and each signs
  // up a distinct random user, so they are safe to parallelize — but the api's
  // SIGNUP_LIMITER (5/60s per IP) does not know that. Serial keeps a future
  // third case from silently tripping a 429 and looking like a real failure.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],

  use: {
    baseURL: WEB_URL,
    // Every failure here is expensive to reproduce (two Workers + Postgres +
    // a browser), so keep the evidence from the first occurrence.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: [
    {
      // ⚠️ THE WEB BUILD RUNS HERE, IN THE **API**'s COMMAND. That looks wrong.
      // It is deliberate, and moving it is a multi-hour debugging trap.
      //
      // `astro build` must not run while ANY wrangler dev process is alive.
      // When it does, the build's own workerd children disturb wrangler's dev
      // registry, and the web Worker's `API` Service Binding comes up reporting
      // `[connected]` while every dispatch through it dies with:
      //
      //     X [ERROR] Error: Network connection lost.
      //     [wrangler:info] POST /signup 500 Internal Server Error
      //
      // The api is fine throughout (`GET :8788/health` -> 200 the whole time),
      // which is what makes this so misleading — it presents as a broken app,
      // not a broken build step. Measured, from clean each time:
      //
      //     api up -> build -> web up   => api-error: Network connection lost
      //     build  -> api up -> web up  => api-status: 200 / ok
      //
      // Playwright starts webServers in ARRAY ORDER and runs `globalSetup`
      // AFTER the webServer plugins, so the front of the first command is the
      // only place a build can run before both servers exist.
      //
      // `pnpm --filter <pkg> build` goes through scripts/build-web.mjs, which
      // cleans dist and reaps the workerd processes astro leaks (they lock
      // dist/ and make every later build fail on Windows). It reaps only what
      // its own build spawned — verified: 4 leaked, 0 left, api untouched.
      command: [
        "pnpm --filter @thinkersjournal/web build",
        `pnpm --filter @thinkersjournal/api exec wrangler dev --port ${API_PORT} ${apiVars}`,
      ].join(" && "),
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      // Generous: a cold `astro build` plus a workerd start.
      timeout: 240_000,
      stdout: "pipe",
      stderr: "pipe",
      env: hyperdriveEnv,
    },
    {
      // The web Worker. No build here — see above.
      //
      // ⚠️ `-c dist/server/wrangler.json` — the GENERATED config, never the
      // source `apps/web/wrangler.jsonc`. The source has no `main` and its
      // `assets` has no `directory` because @astrojs/cloudflare injects both at
      // build time; pointing wrangler at it fails with "The `assets` property in
      // your configuration is missing the required `directory` property." The
      // config this serves is build output, which is the other reason the build
      // must already have run.
      command: `pnpm --filter @thinkersjournal/web exec wrangler dev -c dist/server/wrangler.json --port ${WEB_PORT} ${webVars}`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

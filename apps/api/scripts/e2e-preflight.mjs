// SPDX-License-Identifier: MIT OR Apache-2.0
// E2E PREFLIGHT (#84): run FIRST in the first Playwright webServer command, before
// the web build and any `wrangler dev`, so an unmigrated local dev database fails in
// seconds with the fix named instead of hanging until the webServer timeout.
// Logic and rationale: scripts/lib/e2e-preflight.mjs. Reads only; writes nothing.
//
// UNCONDITIONAL TOP-LEVEL EXECUTION, no entry-point guard (same rule as migrate.mjs):
// a guard that mis-compares paths would silently skip the check and exit 0.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { DEFAULT_DEV_URL } from "./lib/migrate-args.mjs";
import { checkDevDb, listMigrationNames } from "./lib/e2e-preflight.mjs";

// The same variable and default playwright.config.ts hands to both Hyperdrive bindings.
const databaseUrl = process.env.E2E_DATABASE_URL ?? DEFAULT_DEV_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const result = await checkDevDb({
  databaseUrl,
  migrationNames: listMigrationNames(readdirSync(migrationsDir)),
  queryApplied: async () => {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const res = await client.query("SELECT name FROM pgmigrations");
      return res.rows.map((r) => r.name);
    } finally {
      await client.end();
    }
  },
});

console.log(result.message);
if (!result.ok) process.exitCode = 1;

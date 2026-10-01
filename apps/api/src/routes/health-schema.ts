/**
 * `GET /health/schema?migration=<name>` — the deploy-time migration gate's
 * ONLY data source (#116, shape A: CireSnave ruled no standing CI credential —
 * the deployed Worker answers from the database access it already has rather
 * than minting a new one for `scripts/check-migrations-applied.mjs` to hold).
 *
 * ⚠️ IT DISCLOSES A BOOLEAN FOR A CALLER-SUPPLIED NAME, NOTHING MORE — a PM
 * refinement on the shape-A proposal. It never returns the latest migration's
 * name or the migration list: that would let anyone outside this repo map
 * production's exact schema history for free, a strictly worse disclosure
 * than "yes/no for a name you already had to know". Do not add a `latest`
 * field or a listing to this route, ever.
 *
 * `migration` is validated against the node-pg-migrate filename shape BEFORE
 * it reaches SQL — anything else (missing, wrong shape, a path segment, a
 * stray `;`) is `errorResponse("INVALID_INPUT", 400)`. node-pg-migrate's own
 * `pgmigrations` table stores the file name WITHOUT its `.sql` extension (see
 * apps/api/scripts/migrate.mjs), so that is what this compares against.
 *
 * ⚠️ IF THE LEAST-PRIVILEGE `app_runtime` ROLE (docs/superpowers/specs/
 * 2026-09-02-least-privilege-db-role-design.md) EVER CUTS OVER, IT MUST BE
 * GRANTED `SELECT` ON `pgmigrations` OR THIS ROUTE — AND THEREFORE THE DEPLOY
 * GATE — SILENTLY STARTS ANSWERING 503 FOREVER. That design predates this one
 * and only enumerates the request-path's DML tables; `pgmigrations` is not
 * among them because nothing in the request path touched it until now. See
 * that design doc's dated note.
 */
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import type { RouteParams } from "../routing";

const MIGRATION_NAME_RE = /^\d{4}_[a-z0-9_]+$/;

export async function handleHealthSchema(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  _params: RouteParams,
): Promise<Response> {
  const migration = new URL(request.url).searchParams.get("migration");

  if (migration === null || !MIGRATION_NAME_RE.test(migration)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["migration"] });
  }

  let applied: boolean;
  try {
    applied = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query("SELECT 1 FROM pgmigrations WHERE name = $1", [
        migration,
      ]);
      return rows.length > 0;
    });
  } catch (err) {
    // Never put the error (or any migration name) in the body — a DB-outage
    // detail here is no more useful to the gate script than it is to
    // src/routes/health-db.ts's monitor, and logging keeps it attributable.
    console.error("health/schema: query failed", err);
    return new Response(JSON.stringify({ applied: null }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ applied }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

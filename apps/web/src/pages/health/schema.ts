/**
 * `GET /health/schema?migration=<name>` — the PUBLIC proxy to the api's
 * migration-applied readout (#116, the deploy-time migration gate, shape A).
 *
 * `scripts/check-migrations-applied.mjs` polls THIS route (the one the public
 * internet, and therefore a Cloudflare Workers Build, can reach) rather than
 * the api directly — same reason `health/db.ts` proxies `/health/db`: the api
 * Worker is `workers_dev:false` and has no public route of its own.
 *
 * ⚠️ markPrivate — NEVER cacheable, and that is load-bearing here MORE than on
 * `health/db.ts`: a cached `{"applied":true}` would make the gate pass forever
 * even after a rollback or a schema regression, which is exactly the failure
 * this endpoint exists to prevent (#107/0019's incident). `health-schema-proxy
 * .test.ts` pins that this route stays `markPrivate`.
 *
 * Passes the api's status AND body through UNCHANGED — the gate script reads
 * both, and the api's own 400 (bad/missing `migration`) must reach it as a 400
 * too, not be swallowed into a generic proxy error.
 */
import type { APIRoute } from "astro";

import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  // ⚠️ An APIRoute's `context` has NO `.response` — build the headers here and
  // hand the SAME object to markPrivate and to the Response (as rss.xml.ts does).
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  // Missing `migration` is NOT handled here — an empty string reaches the api
  // unchanged and its own `INVALID_INPUT` 400 comes through, same as any other
  // malformed value. This proxy validates nothing; the api is the one source
  // of truth for the name shape.
  const migration = new URL(context.request.url).searchParams.get("migration") ?? "";

  try {
    // ANONYMOUS (no `request`): the readout carries no viewer state.
    const response = await apiFetch<unknown>(
      "/health/schema?migration=" + encodeURIComponent(migration),
    );
    return new Response(response.text, { status: response.status, headers });
  } catch {
    // The api Worker itself is unreachable (binding-level failure). Fail
    // closed, same shape as health/db.ts: a non-200 so the gate script (which
    // fails closed on anything but 200 + `applied:true`) refuses to deploy.
    return new Response(JSON.stringify({ applied: null }), { status: 503, headers });
  }
};

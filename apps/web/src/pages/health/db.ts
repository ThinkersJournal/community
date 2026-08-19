/**
 * `GET /health/db` — the PUBLIC, pollable readout of the DB-reachability probe.
 *
 * The api's own `/health/db` is binding-only (the api is `workers_dev:false`),
 * so an external uptime monitor cannot reach it directly. This proxies it over
 * the Service Binding through the PUBLIC `web` Worker — which is BETTER than a
 * direct api route, not merely reachable: the poll then exercises the exact
 * path a visitor takes (web → api → Hyperdrive → Neon), so if the `web` Worker
 * itself is down the monitor fires too, and it should — that is a real outage
 * regardless of the database being fine.
 *
 * ⚠️ markPrivate — NEVER cacheable, and that is load-bearing. A cached 200 here
 * would be indistinguishable from a live one and would MASK the exact outage
 * this exists to catch. The api's readout is already KV-only (never edge-cached
 * on the api side); this keeps the `web` hop uncached too. `db-health-proxy.test.ts`
 * pins that this route stays `markPrivate` — SWEEP A of page-cache-inventory only
 * checks that SOME helper is called, not that it is the uncacheable one.
 *
 * Passes the api's status through UNCHANGED — a `503` (stale/down/unknown) must
 * reach the monitor as a non-200 so it alerts. No CSP (this is JSON, not HTML).
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

  try {
    // ANONYMOUS (no `request`): the readout carries no viewer state. The api's
    // status is passed through so a 503 reaches an external monitor as a non-200.
    const response = await apiFetch<unknown>("/health/db");
    return new Response(response.text, { status: response.status, headers });
  } catch {
    // The api Worker itself is unreachable (binding-level failure) — a real
    // outage from a visitor's perspective, and the monitor MUST fire. Answer a
    // 503 with our own status body rather than letting the error escape as a 500.
    return new Response(JSON.stringify({ status: "api_unreachable" }), { status: 503, headers });
  }
};

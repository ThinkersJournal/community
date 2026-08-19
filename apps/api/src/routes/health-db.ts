/**
 * `GET /health/db` — the read side of the DB-reachability probe
 * (src/health/probe.ts). Detection only; notification/alerting is a separate,
 * later piece.
 *
 * ⚠️ READS ONLY KV, NEVER THE DATABASE. The whole point of this endpoint is to
 * stay responsive during a DB outage — if it queried Postgres itself it would
 * fail exactly when it has the most to say. It answers entirely from the
 * `db-probe` record `recordDbProbe` writes on every cron tick.
 */
import { readDbProbe, STALE_AFTER_MS } from "../health/probe";

import type { RouteParams } from "../routing";

type HealthDbStatus = "ok" | "stale" | "down" | "unknown";

export async function handleHealthDb(
  _request: Request,
  env: Env,
  _ctx: ExecutionContext,
  _params: RouteParams,
): Promise<Response> {
  const state = await readDbProbe(env);
  const now = Date.now();

  const ageMs = state === null ? null : now - state.lastCheckAt;
  const isStale = ageMs !== null && ageMs > STALE_AFTER_MS;

  const status: HealthDbStatus =
    state === null ? "unknown" : isStale ? "stale" : state.ok ? "ok" : "down";

  // A dumb external HTTP monitor (uptime checker, load balancer health check)
  // alerts on non-200 — so "ok" is the ONLY 2xx; every other status is 503.
  const httpStatus = status === "ok" ? 200 : 503;

  const body: Record<string, unknown> = {
    status,
    lastCheckAt: state?.lastCheckAt ?? null,
    ageMs,
    staleAfterMs: STALE_AFTER_MS,
    checkedRecently: !isStale,
  };

  // Detail (the raw error string and the recent-probe series) is withheld
  // from the public/prod response — a leaked connection error (hostname,
  // driver internals) reads badly surfaced in an incident writeup, and the
  // recent series is more than an external monitor needs. Gated on the same
  // TEST_ROUTES flag every other dev/test-only seam uses (src/routes/__test.ts);
  // a future prod-auth gate can widen this deliberately.
  if (env.TEST_ROUTES === "1") {
    body.error = state?.error ?? null;
    body.latencyMs = state?.latencyMs ?? null;
    body.recent = state?.recent ?? [];
  }

  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

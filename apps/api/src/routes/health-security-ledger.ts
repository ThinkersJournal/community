// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `GET /health/security-ledger` (security-alerting spec §2.6 R2). Reads ONE KV
 * key, `security-ledger:ok`, which the ledger's alarm writes first on every run.
 * Answers only `{"status":"ok"}` (200) or `{"status":"stale"}` (503): no
 * timestamp, no digest time, and NO Durable Object call, so it is neither an
 * oracle nor a way to wake the ledger from the public internet.
 */
import { LIVENESS_KEY } from "../durable-objects/SecurityLedgerDO";

/** Older than this, the ledger's alarm has stopped (it runs at least hourly). */
export const LEDGER_STALE_AFTER_MS = 2 * 3_600_000;

export async function handleHealthSecurityLedger(_request: Request, env: Env): Promise<Response> {
  // A KV read that throws means the ledger cannot be shown alive: answer `stale`
  // (503), not an unhandled 500 with no body.
  let raw: string | null = null;
  try {
    raw = await env.HEALTH.get(LIVENESS_KEY);
  } catch {
    raw = null;
  }
  const at = raw === null ? Number.NaN : Number(raw);
  const ok = Number.isFinite(at) && Date.now() - at < LEDGER_STALE_AFTER_MS;
  return new Response(JSON.stringify({ status: ok ? "ok" : "stale" }), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

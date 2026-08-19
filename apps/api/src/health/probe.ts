/**
 * The DB-reachability probe (detection half only — notification/alerting is a
 * separate, later piece).
 *
 * ⚠️ WHY THIS EXISTS. The production database was unreachable for 3 days and
 * nothing noticed. This module records, on every cron tick, whether Postgres
 * answered a trivial query — and it records that result to KV, a store
 * INDEPENDENT of the database, so the probe log survives the exact outage it
 * exists to detect. A probe that stored its results IN Postgres would go dark
 * at precisely the moment it has something to say.
 *
 * ⚠️ WHY `HYPERDRIVE_FRESH`, DELIBERATELY. This probe exists to catch the
 * database being unreachable — and `HYPERDRIVE_FRESH` (cache-disabled) is the
 * exact code path the app's auth/session reads use, i.e. the one that broke.
 * Probing through `HYPERDRIVE_CACHED` could keep answering from a stale cached
 * connection state and miss the very outage this exists to catch.
 */
import { withClient } from "../db/client";

/** The single KV key this module reads and writes in `env.HEALTH`. */
export const PROBE_KEY = "db-probe";

/** How many recent probe records are retained (most-recent-first). */
export const RECENT_WINDOW = 50;

/**
 * How stale `lastCheckAt` must be before `GET /health/db` reports "stale"
 * instead of trusting the last recorded result.
 *
 * DELIBERATELY GENEROUS — 7 minutes, not e.g. 3. The probe runs on the api's
 * every-2-minute cron (wrangler.jsonc's `triggers.crons`), and KV is
 * eventually consistent (writes can take up to ~60s to propagate across
 * Cloudflare's PoPs). Any
 * threshold below `probe interval + KV propagation` would manufacture false
 * "probe stopped" readings purely from that propagation lag, on a schedule
 * that is otherwise healthy. 7 minutes is roughly 3x the cron interval plus
 * margin for KV propagation — generous enough that only a GENUINELY stopped
 * probe (the cron itself not firing, or every recent write failing) trips it.
 */
export const STALE_AFTER_MS = 7 * 60_000;

/** One probe attempt's result. */
export interface DbProbeRecord {
  readonly at: number;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

/** The KV-stored state: the latest result plus a bounded recent history. */
export interface DbProbeState {
  readonly lastCheckAt: number;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
  readonly recent: DbProbeRecord[];
}

/** An error message truncated to a bounded length for storage. */
const ERROR_MESSAGE_MAX = 200;

function classifyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, ERROR_MESSAGE_MAX);
}

/**
 * Run one DB-reachability probe (`SELECT 1` through `HYPERDRIVE_FRESH`) and
 * append the result to the `db-probe` KV log.
 *
 * ⚠️ THIS FUNCTION MUST NEVER THROW. It runs under `ctx.waitUntil` on every
 * cron tick (src/index.ts's `scheduled()`), and a throw inside `waitUntil` is
 * an unhandled rejection — logged by the runtime but never surfaced to a
 * caller who could react to it. Every fallible step below (the DB query, the
 * KV read, the KV write) is therefore individually caught.
 */
export async function recordDbProbe(env: Env, ctx: ExecutionContext): Promise<void> {
  // The OUTER try/catch is the "never throws" guarantee itself: everything
  // below — the probe query, the KV read, the KV write — funnels through it,
  // so no unanticipated failure can escape as an unhandled rejection under
  // `ctx.waitUntil`.
  try {
    const startedAt = Date.now();
    let ok: boolean;
    let error: string | undefined;
    try {
      await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("SELECT 1"));
      ok = true;
    } catch (err) {
      // pg errors like "password authentication failed for user
      // 'neondb_owner'" are safe to store verbatim (they never contain the
      // password itself) — just truncated, as a bound on KV value size and
      // log noise.
      ok = false;
      error = classifyError(err);
    }
    const latencyMs = Date.now() - startedAt;
    const record: DbProbeRecord = {
      at: Date.now(),
      ok,
      latencyMs,
      ...(error !== undefined ? { error } : {}),
    };

    const previous = await env.HEALTH.get<DbProbeState>(PROBE_KEY, "json");
    const recent = [record, ...(previous?.recent ?? [])].slice(0, RECENT_WINDOW);
    const state: DbProbeState = {
      lastCheckAt: record.at,
      ok,
      latencyMs,
      ...(error !== undefined ? { error } : {}),
      recent,
    };

    // ⚠️ A FAILED WRITE HERE SILENTLY FREEZES THE LOG at its previous entry —
    // that is NOT itself surfaced to `GET /health/db`. That is deliberate:
    // the endpoint's staleness check (`lastCheckAt` vs `STALE_AFTER_MS`) is
    // the load-bearing thing that eventually surfaces a stuck log (as
    // "stale"), NOT this log line — the two are not redundant with each
    // other. This inner try/catch exists only so a KV outage on the WRITE
    // side cannot itself throw out of `recordDbProbe`.
    try {
      await env.HEALTH.put(PROBE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error("db-probe: KV write failed", err);
    }
  } catch (err) {
    console.error("db-probe: unexpected failure recording probe", err);
  }
}

/** Read the current probe state from KV, or `null` if none has been recorded yet. */
export async function readDbProbe(env: Env): Promise<DbProbeState | null> {
  return env.HEALTH.get<DbProbeState>(PROBE_KEY, "json");
}

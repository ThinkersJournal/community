/**
 * The web Worker's half of security counting (security-alerting spec §2.2 item
 * 4). The purge route is the web Worker's only `security:` source; its failures
 * go into ONE module-scoped `SecurityEventBuffer` per isolate (the same class the
 * api uses, packages/shared), flushed to the api's `site` counter through a
 * cross-script Durable Object binding.
 *
 * ⚠️ PURGE_LIMITER DOES NOT CAP FAILURES (apps/web/wrangler.jsonc): every wrong
 * secret is an event. The buffer is what bounds the cost: at most one `record`
 * RPC per isolate per `FLUSH_DELAY_MS`, however many failures arrive.
 */
import {
  logSecurityEvent,
  SecurityEventBuffer,
  type CounterBatch,
  type SecurityCounterRpc,
  type SecurityEvent,
} from "@thinkersjournal/shared";

/** The env keys this module reads. The web `Env` satisfies it. */
export interface SecurityCountingEnv {
  /** `"off"` is the kill switch (spec §3.1). */
  readonly SECURITY_COUNTING?: string;
  readonly SECURITY_COUNTER: { getByName(name: string): SecurityCounterRpc };
}

const isolateBuffer = new SecurityEventBuffer();

/**
 * The purge page's `onSecurityEvent`. `target` is a TEST SEAM (a buffer with an
 * injected `sleep`); production uses the isolate's buffer.
 */
export function purgeSecurityEventSink(
  env: SecurityCountingEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  target: SecurityEventBuffer = isolateBuffer,
): (event: SecurityEvent, at: Date) => void {
  if (env.SECURITY_COUNTING === "off") return () => undefined;
  const scope = { waitUntil, stubFor: (shard: string) => guardedCounter(env, shard) };
  return (event, at) => {
    target.add(event, at, {}, scope);
  };
}

/**
 * The counter, reached so that a failure can neither reach the purge response
 * nor pass silently (PM ruling on batch-2 review I-5, option A).
 *
 * ⚠️ THE CROSS-SCRIPT CALL CAN FAIL. Under two separate local `wrangler dev`
 * processes (the E2E's topology, playwright.config.ts) it answers "Network
 * connection lost." Whatever fails, `getByName` or `record`, is caught here and
 * logged ONCE per failed call as a `security:` line, the same prefix as this
 * route's refusals and the api's own `alerting_fault`s:
 * `security: alerting_fault security-counter counter_unreachable`.
 *
 * No counter is bumped: the web Worker has no metrics or counter mechanism to
 * bump (src/pages/api/turnstile-signal.ts's header records that none exists;
 * wrangler.jsonc has no Analytics Engine or KV binding). The `security:` line
 * IS the countable signal: Workers Logs is this codebase's observability
 * surface, and an operator counts it with a query on that prefix.
 */
function guardedCounter(env: SecurityCountingEnv, shard: string): SecurityCounterRpc {
  return {
    record: async (batch: CounterBatch) => {
      try {
        await env.SECURITY_COUNTER.getByName(shard).record(batch);
      } catch {
        logSecurityEvent({ kind: "alerting_fault", route: "security-counter", reason: "counter_unreachable", ip: null });
      }
    },
  };
}

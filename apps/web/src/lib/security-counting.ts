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
import { SecurityEventBuffer, type SecurityCounterRpc, type SecurityEvent } from "@thinkersjournal/shared";

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
  const scope = { waitUntil, stubFor: (shard: string) => env.SECURITY_COUNTER.getByName(shard) };
  return (event, at) => target.add(event, at, {}, scope);
}

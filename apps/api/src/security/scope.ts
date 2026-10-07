import { AsyncLocalStorage } from "node:async_hooks";

import { SecurityEventBuffer, setSecurityEventObserver } from "@thinkersjournal/shared";
import type { SecurityRequestScope } from "@thinkersjournal/shared";

/** The env keys this module reads. `Env` satisfies it once the binding is added. */
export interface SecurityScopeEnv {
  /** `"off"` is the kill switch (§6). */
  readonly SECURITY_COUNTING?: string;
  readonly SECURITY_COUNTER: Pick<Env["SECURITY_COUNTER"], "getByName">;
}

/**
 * TEST SEAM (I5). The workerd pool cannot spy on an ES module's exports
 * (routes/reset-password.ts:94-99), so tests swap collaborators here instead.
 * Production never calls the setter.
 */
export interface SecurityScopeOverrides {
  readonly buffer?: SecurityEventBuffer;
  readonly stubFor?: SecurityRequestScope["stubFor"];
}

let overrides: SecurityScopeOverrides = {};

export function setSecurityScopeOverridesForTests(next: SecurityScopeOverrides | null): void {
  overrides = next ?? {};
}

const scopeStore = new AsyncLocalStorage<SecurityRequestScope>();
const defaultBuffer = new SecurityEventBuffer();

setSecurityEventObserver((event, at, counting) => {
  const scope = scopeStore.getStore();
  if (scope === undefined) return; // outside a request (cron): the log line only
  (overrides.buffer ?? defaultBuffer).add(event, at, counting, scope);
});

/**
 * Run one request's handler with counting enabled. src/index.ts's only change is
 * to call this around the handler it already dispatched (§2.2, the pin).
 * Returns exactly what `run` returns; counting can never change a response.
 */
export function withSecurityScope<T>(
  env: SecurityScopeEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  run: () => Promise<T>,
): Promise<T> {
  if (env.SECURITY_COUNTING === "off") return run();
  const scope: SecurityRequestScope = {
    waitUntil: (p) => {
      ctx.waitUntil(p);
    },
    stubFor: overrides.stubFor ?? ((shard) => env.SECURITY_COUNTER.getByName(shard)),
  };
  return scopeStore.run(scope, run);
}

/**
 * One log shape for every security-relevant refusal, on BOTH Workers: a failed
 * authentication (wrong password, bad reset token, wrong purge secret) and every
 * rate-limit 429 on the routes that carry one.
 *
 * ⚠️ THE `security:` PREFIX IS A CONTRACT, NOT DECORATION. The alerting follow-up
 * counts these lines out of Cloudflare's Workers Logs (`observability.enabled` on
 * both Workers); a grep or Logs query for the prefix is how it will find them. Do
 * not reword it, and do not log a security event any other way.
 *
 * ⚠️ NEVER PASS A SECRET. The fields are fixed on purpose: a route, a short
 * machine-readable reason, the client IP and a timestamp. A password, a reset
 * token, a purge secret, a CSRF token or a limiter KEY (login's keys embed the
 * email address) has no field to go in. Cloudflare's log retention is not ours to
 * scrub.
 *
 * `console.warn`, not `console.error`: a refusal is the system WORKING. The level
 * still lands in Workers Logs, and keeps these out of the error-rate signal.
 */
export type SecurityEventKind = "auth_failure" | "rate_limited";

export interface SecurityEvent {
  kind: SecurityEventKind;
  /** The route path, e.g. `/auth/login`. */
  route: string;
  /** A short machine-readable cause, e.g. `invalid_credentials`, `ip`, `ip:email`. */
  reason: string;
  /** The client IP as the Worker resolved it, or null when it had none. */
  ip: string | null;
}

/** Write one `security:` line. Returns nothing and never throws. */
export function logSecurityEvent(event: SecurityEvent): void {
  try {
    console.warn(`security: ${event.kind} ${event.route} ${event.reason}`, {
      kind: event.kind,
      route: event.route,
      reason: event.reason,
      ip: event.ip,
      at: new Date().toISOString(),
    });
  } catch {
    // A logging failure must never turn a refusal into a 500.
  }
}

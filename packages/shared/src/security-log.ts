/**
 * One log shape for every security-relevant refusal, on BOTH Workers: a failed
 * authentication (wrong password, bad reset token, wrong purge secret) and every
 * rate-limit 429 on the routes that carry one.
 *
 * ⚠️ THE `security:` PREFIX IS A CONTRACT, NOT DECORATION. Operators query
 * Cloudflare's Workers Logs for it (`observability.enabled` on both Workers). The
 * alerting pipeline does NOT read the logs: it counts in-process, through the
 * observer below, because the line carries no address and no user id and the
 * stuffing and targeted-account signals need both (security-alerting spec §1.2).
 * Do not reword the prefix, and do not log a security event any other way.
 *
 * ⚠️ NEVER PASS A SECRET. The fields are fixed on purpose: a route, a short
 * machine-readable reason, the client IP and a timestamp. A password, a reset
 * token, a purge secret, a CSRF token or a limiter KEY (login's keys embed the
 * email address) has no field to go in. Cloudflare's log retention is not ours to
 * scrub. The second argument (`SecurityEventCounting`) goes to the observer
 * ONLY, never to `console`.
 *
 * `console.warn`, not `console.error`: a refusal is the system WORKING. The level
 * still lands in Workers Logs, and keeps these out of the error-rate signal.
 */
/**
 * `alerting_fault` is the alerting pipeline reporting on itself (an unreachable
 * ledger, a missing key, §2.4 and §4.1), so a query for `security:` finds it.
 * The `security:` lines are therefore not all attacks: a query that counts
 * attacks filters on `auth_failure` and `rate_limited`. The observer may see an
 * `alerting_fault` (the missing-key line is logged inside a request's
 * `waitUntil`), but no rule matches it, and `missing_client_ip` excludes it.
 */
export type SecurityEventKind = "auth_failure" | "rate_limited" | "alerting_fault";

export interface SecurityEvent {
  kind: SecurityEventKind;
  /** The route path, e.g. `/auth/login`. */
  route: string;
  /** A short machine-readable cause, e.g. `invalid_credentials`, `ip`, `ip:email`. */
  reason: string;
  /** The client IP as the Worker resolved it, or null when it had none. */
  ip: string | null;
}

/**
 * What the COUNTER may know about an event that the LOG must never carry.
 * Handed to the observer only; never written to `console`.
 */
export interface SecurityEventCounting {
  /** The lowercased address a login attempt named (distinct-email counting). */
  readonly email?: string;
  /** The account the attempt resolved to, when one exists (per-account counting). */
  readonly userId?: string;
}

/** Called once per event, after the log line. Must not throw; a throw is swallowed. */
export type SecurityEventObserver = (event: SecurityEvent, at: Date, counting: SecurityEventCounting) => void;

let observer: SecurityEventObserver | null = null;

/** Installed once at module scope by a Worker's entry module; null uninstalls (tests). */
export function setSecurityEventObserver(next: SecurityEventObserver | null): void {
  observer = next;
}

/** Write one `security:` line, then tell the observer. Returns nothing and never throws. */
export function logSecurityEvent(event: SecurityEvent, counting: SecurityEventCounting = {}): void {
  const at = new Date();
  try {
    console.warn(`security: ${event.kind} ${event.route} ${event.reason}`, {
      kind: event.kind,
      route: event.route,
      reason: event.reason,
      ip: event.ip,
      at: at.toISOString(),
    });
  } catch {
    // A logging failure must never turn a refusal into a 500.
  }
  try {
    observer?.(event, at, counting);
  } catch {
    // Nor may a counting failure.
  }
}

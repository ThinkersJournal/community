/** Every signal this design counts. §1.3's table is the source of truth. */
export type SecurityAlertSignal =
  | "login_ip_burst"
  | "credential_stuffing"
  | "slow_stuffing"
  | "targeted_account"
  | "distributed_account_guess"
  | "purge_secret_failure"
  | "reset_token_burst"
  | "reset_token_storm"
  | "login_failure_storm"
  | "rate_limit_storm"
  | "missing_client_ip";

/**
 * Each class has its own budget and cooldowns, so no signal can spend another
 * class's alerts (§2.6, PM ruling on C1).
 */
export type SignalClass = "account" | "stuffing" | "ip_burst" | "purge" | "storm" | "infra";

/**
 * Who or what an alert is about. Never an email address, never a user id.
 * `ip_prefix` appears only on the ip-subject classes, where blocking the
 * prefix is the action (§3.2).
 */
export type SecurityAlertSubject =
  | { readonly kind: "ip_prefix"; readonly value: string }
  | { readonly kind: "no_ip" }
  | { readonly kind: "account"; readonly ref: string }
  | { readonly kind: "site" };

/** One threshold crossing that the ledger let through. */
export interface SecurityAlert {
  readonly type: "alert";
  readonly signal: SecurityAlertSignal;
  readonly signalClass: SignalClass;
  readonly severity: "warning" | "critical";
  readonly subject: SecurityAlertSubject;
  /** ISO-8601, the first minute bucket counted. */
  readonly windowStart: string;
  /** ISO-8601, when the threshold was crossed. */
  readonly windowEnd: string;
  /** Distinct members, or events, counted in the window (a distinct count is capped at 2 × threshold). */
  readonly observed: number;
  /** Events in the window, never capped: what floor-class ranking uses. */
  readonly events: number;
  readonly threshold: number;
  /** Event count per route in the window, e.g. `{ "/auth/login": 61 }`. */
  readonly byRoute: Readonly<Record<string, number>>;
  /** `CF_VERSION_METADATA.id` of the api Worker that raised it, or null. */
  readonly versionId: string | null;
}

/** Sent once per class per UTC day, the moment that class's budget refuses its first alert. */
export interface SecurityBudgetExhausted {
  readonly type: "budget_exhausted";
  readonly signalClass: SignalClass;
  readonly day: string;
  readonly budget: number;
  readonly suppressedSoFar: number;
}

/** Per class, for the digest: counts only, so the digest's size is fixed. */
export interface DigestClassLine {
  readonly signalClass: SignalClass;
  readonly sent: number;
  readonly suppressedByCooldown: number;
  readonly suppressedByBudget: number;
  /** Held subjects not yet covered by a delivered held-subject report. */
  readonly heldOpen: number;
  /**
   * Plan ruling P-3: subjects the row cap made the ledger COUNT instead of
   * store, today (§2.6 F3: "every digest and held-subject report carries the counts").
   */
  readonly heldCountedNotStored: number;
  /**
   * Summary classes: events in the period, by signal. Plan ruling I-8 (PM):
   * `distinctPrefixes` is dropped — §2.3's `classify` collects no members for
   * summary rules, and any capped collection would report a silently truncated
   * count. Thresholds are on events, so no signal is lost (spec amended in PR 1).
   */
  readonly activity: Readonly<Record<string, { readonly events: number }>>;
}

/** Hourly while anything is unreported. Counts only; never a subject list. Exempt from every budget. */
export interface SecurityDigest {
  readonly type: "digest";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly classes: readonly DigestClassLine[];
  /** Alerts the sink refused four times (§2.6), since the last digest. */
  readonly undeliverable: number;
  /** Increments a Worker folded into its overflow count instead of a per-subject counter (§2.4). */
  readonly overflowEvents: number;
  /** True when the site counter could not be read for `activity`. */
  readonly siteSummaryUnavailable: boolean;
  /**
   * Plan ruling P-3: deferred account notices that ended in a Postmark drop
   * state since the last digest. The first of each state per day also sends
   * `notice_dropped`; the rest are counted here (§4.4).
   */
  readonly noticesDropped: Readonly<Record<SecurityNoticeDropped["endState"], number>>;
}

/** One held subject, as a held-subject report names it. */
export interface HeldEntry {
  readonly signal: SecurityAlertSignal;
  readonly subject: SecurityAlertSubject;
  /** Uncapped events across every report while held: the ranking key. */
  readonly events: number;
  readonly suppressed: number;
}

/**
 * The held subjects, by name, up to a byte cap (§2.6). Its own message and its
 * own alarm step, so neither the digest nor the heartbeat depends on it.
 */
export interface SecurityHeldReport {
  readonly type: "held_report";
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Class-priority order (`HELD_PRIORITY`), then uncapped events, most first. */
  readonly entries: readonly HeldEntry[];
  /** Past the cap: how many more per class, all listed on the admin page. */
  readonly more: readonly { readonly signalClass: SignalClass; readonly count: number }[];
  /**
   * The admin page that pages through the full held list. Plan ruling I-11
   * (PM): null until that page ships (PR 3), so no shipped message links to a 404.
   */
  readonly adminUrl: string | null;
  /** Plan ruling P-3: per class, subjects counted but not stored today (not on the admin page either). */
  readonly countedNotStored: readonly { readonly signalClass: SignalClass; readonly count: number }[];
}

/**
 * Once per UTC day: the first ledger alarm at or after 09:00 sends it. Small and
 * fixed-size, its own alarm step, so silence means the pipeline is broken.
 */
export interface SecurityHeartbeat {
  readonly type: "heartbeat";
  readonly day: string;
  /** Minutes after 09:00 UTC that it went out; > 0 means the ledger's alarm ran late. */
  readonly lateMinutes: number;
  /** Today's totals so far, per class: alerts sent and subjects held. */
  readonly totals: readonly { readonly signalClass: SignalClass; readonly sent: number; readonly held: number }[];
}

/**
 * Sent once per class per UTC day, the moment that class's held-row cap first
 * makes the ledger COUNT a subject instead of storing it (§2.6). Exempt from budgets.
 */
export interface SecurityHeldCapped {
  readonly type: "held_capped";
  readonly signalClass: SignalClass;
  readonly day: string;
  readonly cap: number;
  /** Subjects counted, not stored, so far today. */
  readonly countedNotStored: number;
}

/**
 * A deferred account notice reached a drop state (§4.4): at most one per drop
 * state per UTC day, carrying how many notices ended that way so far today.
 * Never the account, the address or the user id. Exempt from budgets.
 */
export interface SecurityNoticeDropped {
  readonly type: "notice_dropped";
  readonly endState: "dropped_permanent_refusal" | "dropped_expired";
  readonly day: string;
  readonly countToday: number;
}

/** A configuration fault the operator must fix; at most one per key per UTC day. */
export interface SecurityConfigFault {
  readonly type: "config_fault";
  readonly key: "DEVICE_HASH_KEY";
  readonly detail: "missing";
}

export type SecurityAlertMessage =
  | SecurityAlert
  | SecurityBudgetExhausted
  | SecurityDigest
  | SecurityHeldReport
  | SecurityHeartbeat
  | SecurityHeldCapped
  | SecurityNoticeDropped
  | SecurityConfigFault;

export type SecurityAlertDelivery =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

/**
 * THE SEAM. Board 131 supplies the real implementation; until then the log sink
 * runs. `send` must resolve, never reject; `deliverSecurityAlert` enforces that
 * for a sink that breaks the contract.
 */
export interface SecurityAlertSink {
  readonly name: string;
  send(message: SecurityAlertMessage): Promise<SecurityAlertDelivery>;
}

/** The pre-131 sink: one `security-alert:` line per message. Never the `security:` prefix. */
export class LogSecurityAlertSink implements SecurityAlertSink {
  readonly name = "log";

  async send(message: SecurityAlertMessage): Promise<SecurityAlertDelivery> {
    try {
      console.warn(`security-alert: ${message.type}`, message);
    } catch {
      // A log failure is not a delivery failure worth retrying.
    }
    return { delivered: true };
  }
}

/** The env keys the seam reads. Values are never logged. */
export interface SecurityAlertEnv {
  /** `"1"` routes alerts to the transport; anything else keeps the log sink. */
  readonly SECURITY_ALERTS_ENABLED?: string;
  /** Worker secret: where alerts go. */
  readonly SECURITY_ALERT_EMAIL?: string;
  /** Worker secret: the transport's credential (board 131). */
  readonly SECURITY_ALERT_RELAY_TOKEN?: string;
}

/** Builds the board-131 sink from env. `null` until that PR lands. */
export type SecurityAlertTransportFactory = (env: SecurityAlertEnv) => SecurityAlertSink;

/**
 * Pick the sink. Falls back to the log sink, LOUDLY, whenever the transport is
 * switched on but cannot run: an alert must never vanish because a secret is unset.
 */
export function selectSecurityAlertSink(
  env: SecurityAlertEnv,
  transport: SecurityAlertTransportFactory | null,
): SecurityAlertSink {
  if (env.SECURITY_ALERTS_ENABLED !== "1") return new LogSecurityAlertSink();
  const missing = [
    transport === null ? "transport" : null,
    (env.SECURITY_ALERT_EMAIL ?? "") === "" ? "SECURITY_ALERT_EMAIL" : null,
    (env.SECURITY_ALERT_RELAY_TOKEN ?? "") === "" ? "SECURITY_ALERT_RELAY_TOKEN" : null,
  ].filter((m): m is string => m !== null);
  if (transport === null || missing.length > 0) {
    console.error("security-alert: transport enabled but not configured; using the log sink", { missing });
    return new LogSecurityAlertSink();
  }
  return transport(env);
}

/** The only way anything calls a sink: bounded in time, and never throws. */
export async function deliverSecurityAlert(
  sink: SecurityAlertSink,
  message: SecurityAlertMessage,
  timeoutMs = 10_000,
): Promise<SecurityAlertDelivery> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SecurityAlertDelivery>((resolve) => {
    timer = setTimeout(() => resolve({ delivered: false, reason: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([sink.send(message), timeout]);
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.name : "threw" };
  } finally {
    clearTimeout(timer);
  }
}

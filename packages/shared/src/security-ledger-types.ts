import type { SecurityAlertSignal, SignalClass } from "./security-alert";
import type { SubjectKind } from "./security-signals";

/**
 * One threshold crossing, as a counter instance hands it to the ledger
 * (security-alerting spec §2.4 step 4). The subject is RAW here (a /64, a
 * network, a user id, "none" or "site"): only the ledger mints account refs,
 * so no message ever carries a user id (§3.3).
 */
export interface CounterReport {
  readonly signal: SecurityAlertSignal;
  readonly signalClass: SignalClass;
  readonly subjectKind: SubjectKind;
  readonly subject: string;
  /** Epoch ms of the first minute bucket counted. */
  readonly windowStartMs: number;
  /** Epoch ms when the threshold was crossed (widened when reports merge). */
  readonly windowEndMs: number;
  /** Distinct members, or events, in the window (a distinct count is capped at 2 × threshold). */
  readonly observed: number;
  /** Events in the window, never capped; summed when reports merge. */
  readonly events: number;
  readonly threshold: number;
  readonly severity: "warning" | "critical";
  readonly byRoute: Readonly<Record<string, number>>;
}

/** What one `ledger.report()` call carries (§2.4, alarm step 1). */
export interface LedgerReportBatch {
  readonly reports: readonly CounterReport[];
  /**
   * Reports a counter COUNTED instead of storing, because 10,000 were already
   * pending (§2.4 m4), per class. The ledger adds them to `held_overflow`.
   */
  readonly countedOverflow: Readonly<Partial<Record<SignalClass, number>>>;
}

/** The ledger's RPC surface as a counter sees it. */
export interface SecurityLedgerReportRpc {
  report(batch: LedgerReportBatch): Promise<void>;
}

/** Summary-class activity for one signal over a period (§3.2 `DigestClassLine.activity`; I-8). */
export interface SignalActivity {
  readonly events: number;
}

/** `site.summarise(fromMinute, toMinute)`'s answer (§2.6, alarm step 5), over `[fromMinute, toMinute)`. */
export interface SiteSummary {
  /** Only the summary-class signals the site counter saw: a missing key means none. */
  readonly activity: Readonly<Partial<Record<string, SignalActivity>>>;
  /** Increments a Worker folded into `overflowEvents` (§2.5), summed over the period. */
  readonly overflowEvents: number;
}

/** The `site` counter instance's read surface, as the ledger sees it. */
export interface SiteSummaryRpc {
  summarise(fromMinute: number, toMinute: number): Promise<SiteSummary>;
}

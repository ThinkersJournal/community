import type { HeldEntry, SecurityAlertSignal, SignalClass } from "./security-alert";

export interface ClassPolicy {
  /** `subject`: one alert per (signal, subject) per cooldown. `summary`: one onset alert per signal per UTC day, then the digest. */
  readonly mode: "subject" | "summary";
  /** Subject mode only. */
  readonly cooldownMinutes: number;
  /** Alerts per UTC day for this class alone. Nothing else can spend it. */
  readonly dailyBudget: number;
  /**
   * Floor classes: EVERY subject over threshold is named, in an alert or in the
   * next digest, ranked by its uncapped event count. The budget limits mails,
   * never which subjects are reported (§2.6).
   */
  readonly floor: boolean;
}

/** §2.6's table, as code. */
export const CLASS_POLICY: Readonly<Record<SignalClass, ClassPolicy>> = {
  account: { mode: "subject", cooldownMinutes: 360, dailyBudget: 12, floor: true },
  stuffing: { mode: "subject", cooldownMinutes: 60, dailyBudget: 12, floor: true },
  ip_burst: { mode: "subject", cooldownMinutes: 60, dailyBudget: 6, floor: false },
  infra: { mode: "subject", cooldownMinutes: 360, dailyBudget: 2, floor: false },
  purge: { mode: "summary", cooldownMinutes: 0, dailyBudget: 1, floor: false },
  storm: { mode: "summary", cooldownMinutes: 0, dailyBudget: 3, floor: false },
};

const POLICY_BY_CLASS: ReadonlyMap<string, ClassPolicy> = new Map(Object.entries(CLASS_POLICY));

/**
 * One class's policy, looked up through a Map rather than by indexing the
 * object with a runtime key. An unknown class throws, as reading `.mode` of the
 * missing entry did.
 */
export function classPolicy(signalClass: SignalClass): ClassPolicy {
  const p = POLICY_BY_CLASS.get(signalClass);
  if (p === undefined) throw new TypeError("unknown signal class");
  return p;
}

/** What the ledger knows when a crossing arrives. */
export interface LedgerState {
  readonly nowMs: number;
  /** Subject mode: this (signal, subject)'s cooldown end, or null. */
  readonly cooldownUntilMs: number | null;
  /** Summary mode: an onset alert for this signal was already sent this UTC day. */
  readonly onsetSentToday: boolean;
  /** Alerts this class has sent this UTC day. */
  readonly classSentToday: number;
  /** This class's budget_exhausted message was already queued this UTC day. */
  readonly exhaustedQueuedToday: boolean;
}

export type LedgerAction =
  | { readonly action: "send"; readonly cooldownUntilMs: number | null }
  | { readonly action: "summarise" }
  | { readonly action: "suppress_cooldown" }
  | { readonly action: "suppress_budget"; readonly queueExhausted: boolean };

/** The ledger's one decision, pure. Every non-send outcome is counted for the digest. */
export function decide(signalClass: SignalClass, s: LedgerState): LedgerAction {
  const p = classPolicy(signalClass);
  if (p.mode === "summary" && s.onsetSentToday) return { action: "summarise" };
  if (p.mode === "subject" && s.cooldownUntilMs !== null && s.cooldownUntilMs > s.nowMs) {
    return { action: "suppress_cooldown" };
  }
  if (s.classSentToday >= p.dailyBudget) {
    return { action: "suppress_budget", queueExhausted: !s.exhaustedQueuedToday };
  }
  return {
    action: "send",
    cooldownUntilMs: p.mode === "subject" ? s.nowMs + p.cooldownMinutes * 60_000 : null,
  };
}

/**
 * Stored `held` rows per class. Past the cap, a NEW subject is counted, not stored
 * (§2.6, D6), after first evicting the oldest already-covered row. Generous for
 * the floor classes. Summary classes hold nothing.
 */
export const HELD_ROW_CAP: Readonly<Record<SignalClass, number>> = {
  account: 20_000,
  stuffing: 20_000,
  ip_burst: 2_000,
  infra: 2_000,
  purge: 0,
  storm: 0,
};

/**
 * The most the ledger can send in one UTC day: every budget; one `budget_exhausted`
 * and one `held_capped` per SUBJECT-mode class (a summary class's budget is at
 * least its signal count, so `decide` returns `summarise` before it can be
 * refused; a test pins that); 24 digests; 24 held-subject reports; one heartbeat;
 * one `config_fault`; one `notice_dropped` per drop state.
 */
export function dailyMessageCeiling(): number {
  const classes = Object.values(CLASS_POLICY);
  const budgets = classes.reduce((sum, p) => sum + p.dailyBudget, 0);
  const subjectClasses = classes.filter((p) => p.mode === "subject").length;
  // + 2: one `notice_dropped` per drop state per day.
  return budgets + subjectClasses * 2 + 24 + 24 + 1 + 1 + 2;
}

/** The order a held-subject report names signals in: targeted accounts, then stuffing, then the rest. */
export const HELD_PRIORITY: readonly SecurityAlertSignal[] = [
  "targeted_account",
  "credential_stuffing",
  "slow_stuffing",
  "distributed_account_guess",
  "login_ip_burst",
  "reset_token_burst",
  "missing_client_ip",
];

/** Rows fetched per query while building a report: bounds memory per step. */
export const HELD_PAGE_SIZE = 200;
/** Bytes of entries per report: far under the 2 MB DO row limit and any mail transport's. */
export const HELD_REPORT_BYTE_CAP = 64 * 1024;

/**
 * Accumulates entries until the byte cap. The ledger pages `held` in
 * `HELD_PRIORITY` order, `HELD_PAGE_SIZE` rows a query, and stops paging at the
 * first `false`; everything after it becomes the report's `more` counts.
 */
export class HeldReportBuilder {
  private bytes = 0;
  private readonly list: HeldEntry[] = [];

  constructor(private readonly capBytes: number = HELD_REPORT_BYTE_CAP) {}

  tryAdd(entry: HeldEntry): boolean {
    const size = JSON.stringify(entry).length + 1;
    if (this.bytes + size > this.capBytes) return false;
    this.bytes += size;
    this.list.push(entry);
    return true;
  }

  get entries(): readonly HeldEntry[] {
    return this.list;
  }
}

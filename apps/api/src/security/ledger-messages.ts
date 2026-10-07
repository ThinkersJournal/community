/**
 * The ledger's message builders (security-alerting spec §3.2). Pure apart from
 * reading counts through `LedgerStore`; every message is bounded and carries
 * no user id and no address (§3.2 I7).
 */
import {
  CLASS_POLICY,
  classPolicy,
  SIGNAL_RULES,
  type CounterReport,
  type DigestClassLine,
  type SecurityAlert,
  type SecurityAlertSubject,
  type SecurityDigest,
  type SecurityHeartbeat,
  type SignalClass,
  type SiteSummary,
} from "@thinkersjournal/shared";

import { countedSince, HELD_CLASSES, heldStored, openCount } from "./ledger-held";
import { utcDay, type LedgerStore, type Nullable } from "./ledger-store";

const ALL_CLASSES = Object.keys(CLASS_POLICY) as SignalClass[];
/** The heartbeat's hour (§2.6 step 3): the first alarm at or after 09:00 UTC. */
export const HEARTBEAT_HOUR_UTC = 9;

export function alertFrom(r: CounterReport, subject: SecurityAlertSubject, versionId: string | null): SecurityAlert {
  return {
    type: "alert",
    signal: r.signal,
    signalClass: r.signalClass,
    severity: r.severity,
    subject,
    windowStart: new Date(r.windowStartMs).toISOString(),
    windowEnd: new Date(r.windowEndMs).toISOString(),
    observed: r.observed,
    events: r.events,
    threshold: r.threshold,
    byRoute: r.byRoute,
    versionId,
  };
}

/** Fixed size: one line per class, whatever an attacker does (§2.6 step 3). */
export function heartbeatFrom(store: LedgerStore, nowMs: number): SecurityHeartbeat {
  const day = utcDay(nowMs);
  const nineUtc = Date.parse(`${day}T${String(HEARTBEAT_HOUR_UTC).padStart(2, "0")}:00:00.000Z`);
  return {
    type: "heartbeat",
    day,
    lateMinutes: Math.max(0, Math.floor((nowMs - nineUtc) / 60_000)),
    totals: ALL_CLASSES.map((c) => ({
      signalClass: c,
      sent: store.classDay(c, day).sent,
      held: heldStored(store, c),
    })),
  };
}

function activityFor(c: SignalClass, site: Nullable<SiteSummary>): DigestClassLine["activity"] {
  if (site === null || classPolicy(c).mode !== "summary") return {};
  const out: Record<string, { events: number }> = {};
  for (const rule of SIGNAL_RULES) {
    const a = site.activity[rule.signal];
    if (rule.signalClass === c && a !== undefined) out[rule.signal] = a;
  }
  return out;
}

/** Counts only, so its size is fixed (§3.2). Null when nothing happened this period. */
export function digestFrom(
  store: LedgerStore,
  period: { readonly startMs: number; readonly endMs: number; readonly countedFromMs: number },
  site: Nullable<SiteSummary>,
  undeliverable: number,
  noticesDropped: SecurityDigest["noticesDropped"],
): Nullable<SecurityDigest> {
  const classes: DigestClassLine[] = ALL_CLASSES.map((c) => {
    const p = store.period(c);
    return {
      signalClass: c,
      sent: p.sent,
      suppressedByCooldown: p.by_cooldown,
      suppressedByBudget: p.by_budget,
      heldOpen: HELD_CLASSES.includes(c) ? openCount(store, c) : 0,
      heldCountedNotStored: countedSince(store, c, period.countedFromMs, period.endMs),
      activity: activityFor(c, site),
    };
  });
  const overflowEvents = site?.overflowEvents ?? 0;
  const anything =
    undeliverable > 0 ||
    noticesDropped.dropped_permanent_refusal + noticesDropped.dropped_expired > 0 ||
    overflowEvents > 0 ||
    site === null ||
    classes.some(
      (l) =>
        l.sent + l.suppressedByCooldown + l.suppressedByBudget + l.heldOpen + l.heldCountedNotStored > 0 ||
        Object.values(l.activity).some((a) => a.events > 0),
    );
  if (!anything) return null;
  return {
    type: "digest",
    periodStart: new Date(period.startMs).toISOString(),
    periodEnd: new Date(period.endMs).toISOString(),
    classes,
    undeliverable,
    overflowEvents,
    siteSummaryUnavailable: site === null,
    noticesDropped,
  };
}

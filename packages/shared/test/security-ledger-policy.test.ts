import { describe, expect, it } from "vitest";

import {
  CLASS_POLICY,
  dailyMessageCeiling,
  decide,
  HeldReportBuilder,
  type LedgerState,
} from "../src/security-ledger-policy";
import { SIGNAL_RULES } from "../src/security-signals";

import type { SignalClass } from "../src/security-alert";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const fresh: LedgerState = {
  nowMs: NOW,
  cooldownUntilMs: null,
  onsetSentToday: false,
  classSentToday: 0,
  exhaustedQueuedToday: false,
};

/** Drive `decide` the way the ledger does, for one (signal, subject), `n` crossings an hour apart. */
function run(signalClass: SignalClass, n: number): string[] {
  let s = fresh;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const now = NOW + i * 3_600_000;
    const a = decide(signalClass, { ...s, nowMs: now });
    out.push(a.action);
    if (a.action === "send") s = { ...s, nowMs: now, cooldownUntilMs: a.cooldownUntilMs, onsetSentToday: true, classSentToday: s.classSentToday + 1 };
    if (a.action === "suppress_budget" && a.queueExhausted) s = { ...s, exhaustedQueuedToday: true };
  }
  return out;
}

describe("decide (security-alerting spec §2.6)", () => {
  it("subject mode: send, then cooldown, then send after the cooldown", () => {
    const first = decide("stuffing", fresh);
    expect(first).toEqual({ action: "send", cooldownUntilMs: NOW + 60 * 60_000 });
    expect(decide("stuffing", { ...fresh, cooldownUntilMs: NOW + 1 }).action).toBe("suppress_cooldown");
    expect(decide("stuffing", { ...fresh, cooldownUntilMs: NOW }).action).toBe("send");
  });

  it("the first budget refusal of a subject class queues budget_exhausted; the second does not", () => {
    const budget = CLASS_POLICY.ip_burst.dailyBudget;
    expect(decide("ip_burst", { ...fresh, classSentToday: budget })).toEqual({ action: "suppress_budget", queueExhausted: true });
    expect(decide("ip_burst", { ...fresh, classSentToday: budget, exhaustedQueuedToday: true })).toEqual({
      action: "suppress_budget",
      queueExhausted: false,
    });
    expect(run("ip_burst", budget + 2).filter((a) => a === "send")).toHaveLength(budget);
  });

  it("a summary class summarises after its onset and is never refused", () => {
    expect(decide("storm", fresh).action).toBe("send");
    expect(decide("storm", { ...fresh, onsetSentToday: true, classSentToday: 99 }).action).toBe("summarise");
  });

  it("THE DECOY TEST: purge, storm and ip_burst exhausted → a targeted_account crossing still sends", () => {
    const spent = (c: SignalClass) => ({ ...fresh, onsetSentToday: true, classSentToday: CLASS_POLICY[c].dailyBudget });
    expect(decide("purge", spent("purge")).action).toBe("summarise");
    expect(decide("storm", spent("storm")).action).toBe("summarise");
    expect(decide("ip_burst", spent("ip_burst")).action).toBe("suppress_budget");
    expect(decide("account", fresh).action).toBe("send");
  });

  it("dailyMessageCeiling() is 96", () => {
    expect(dailyMessageCeiling()).toBe(96);
  });

  it("SUMMARY INVARIANT (m-c): every summary class's budget ≥ its number of signals", () => {
    for (const [c, p] of Object.entries(CLASS_POLICY)) {
      if (p.mode !== "summary") continue;
      const signals = SIGNAL_RULES.filter((r) => r.signalClass === c).length;
      expect(p.dailyBudget, c).toBeGreaterThanOrEqual(signals);
    }
  });
});

describe("HeldReportBuilder", () => {
  it("refuses the entry that would pass the byte cap, and every one after it", () => {
    const entry = { signal: "credential_stuffing" as const, subject: { kind: "ip_prefix" as const, value: "2001:db8::/64" }, events: 12, suppressed: 1 };
    const size = JSON.stringify(entry).length + 1;
    const b = new HeldReportBuilder(size * 2);
    expect(b.tryAdd(entry)).toBe(true);
    expect(b.tryAdd(entry)).toBe(true);
    expect(b.tryAdd(entry)).toBe(false);
    expect(b.entries).toHaveLength(2);
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";

import type {
  CounterReport,
  CounterRow,
  SecurityAlertMessage,
  SecurityAlertSignal,
  SecurityAlertSink,
} from "@thinkersjournal/shared";

/**
 * Security-alerting test helpers (plan Tasks 8–9). Every stub is a FRESH
 * instance (a unique name), so tests never share storage. Production uses the
 * names `ip:0`…`site` and `ledger`; nothing in either class depends on its name.
 *
 * ⚠️ NO TEST SLEEPS. Both classes expose `recordAt`/`reportAt`/`alarmAt` with an
 * explicit clock (spec §2.4 "Clock"); tests call them through
 * `runInDurableObject`. This repo had no Durable Object alarm test before this
 * plan (0 hits for `alarm` in apps/api/test at f3da62d; the same grep finds
 * `evictAllDurableObjects` in test/user-security-do.test.ts).
 */
export const T0 = Date.parse("2026-10-07T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export function freshCounter() {
  return env.SECURITY_COUNTER.getByName(`test-counter-${crypto.randomUUID()}`);
}

export function freshLedger() {
  return env.SECURITY_LEDGER.getByName(`test-ledger-${crypto.randomUUID()}`);
}

/** One aggregated buffer row, as `SecurityEventBuffer.flush` would send it. */
export function counterRow(
  signal: SecurityAlertSignal,
  subject: string,
  n: number,
  nowMs: number,
  members: readonly string[] = [],
  route = "/auth/login",
): CounterRow {
  return { signal, subject, route, minute: Math.floor(nowMs / MINUTE), n, members };
}

/** A crossing as a counter would report it. */
export function crossing(over: Partial<CounterReport> = {}): CounterReport {
  return {
    signal: "credential_stuffing",
    signalClass: "stuffing",
    subjectKind: "ip",
    subject: "2001:db8:1:2::/64",
    windowStartMs: T0 - 10 * MINUTE,
    windowEndMs: T0,
    observed: 10,
    events: 12,
    threshold: 10,
    severity: "critical",
    byRoute: { "/auth/login": 12 },
    ...over,
  };
}

/** A sink that records what it was sent; `fail` decides per call whether to refuse. */
export function capturingSink(fail: (m: SecurityAlertMessage) => boolean = () => false) {
  const sent: SecurityAlertMessage[] = [];
  const sink: SecurityAlertSink = {
    name: "capture",
    send: async (m) => {
      if (fail(m)) return { delivered: false, reason: "test" };
      sent.push(m);
      return { delivered: true };
    },
  };
  return { sink, sent };
}

/** Only the messages of one type, narrowed. */
export function ofType<T extends SecurityAlertMessage["type"]>(
  sent: readonly SecurityAlertMessage[],
  type: T,
): Extract<SecurityAlertMessage, { type: T }>[] {
  return sent.filter((m): m is Extract<SecurityAlertMessage, { type: T }> => m.type === type);
}

/**
 * Replace a Durable Object's `armAt` seam with a recorder. ⚠️ Without this a
 * REAL alarm, set for an instant in the past of the wall clock, fires during the
 * test and runs `alarm()` at the real time, racing the test's explicit clock.
 */
export function quiet(instance: { armAt: (ms: number) => Promise<void> }): number[] {
  const armed: number[] = [];
  instance.armAt = async (ms) => {
    armed.push(ms);
  };
  return armed;
}

const FAULT_PREFIX = "security: alerting_fault ";

/**
 * File-level guard (batch-2 review I-3): fails any test that logs a
 * `security: alerting_fault` line it did not declare with `allowFaults`.
 *
 * ⚠️ WHY. `alarm()` runs every step inside a try/catch that only LOGS, so a step
 * that fails on every run passes any test that does not look at the log. The
 * plan's own 25,000-decoy test passed through a deliver step that threw every
 * time (batch 2, D4). With this guard it fails.
 *
 * Call once at file scope. It replaces the file's `afterEach(restoreAllMocks)`:
 * it reads `console.warn` (whichever spy a test installed on top) BEFORE it
 * restores the mocks, so the calls are still there to read.
 * `allowFaults("security-ledger deliver")` allows lines starting with that
 * route and reason, for the current test only.
 */
export function guardAlertingFaults(): { allowFaults: (...routeAndReason: string[]) => void } {
  let allowed: string[] = [];
  let warn: MockInstance<typeof console.warn> | null = null;
  beforeEach(() => {
    allowed = [];
    warn = vi.spyOn(console, "warn");
  });
  afterEach(() => {
    const lines = (warn?.mock.calls ?? []).map((c) => String(c[0]));
    vi.restoreAllMocks();
    const unexpected = lines.filter((l) => l.startsWith(FAULT_PREFIX) && !allowed.some((a) => l.startsWith(FAULT_PREFIX + a)));
    expect(unexpected, "alerting_fault lines this test did not allow").toEqual([]);
  });
  return {
    allowFaults: (...routeAndReason) => {
      allowed.push(...routeAndReason);
    },
  };
}

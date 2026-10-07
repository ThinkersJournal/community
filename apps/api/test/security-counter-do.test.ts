import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { SIGNAL_RULES, type CounterReport, type LedgerReportBatch } from "@thinkersjournal/shared";

import { reportRetryDelayMs } from "../src/durable-objects/SecurityCounterDO";

import { counterRow, freshCounter, guardAlertingFaults, HOUR, MINUTE, quiet, T0 } from "./helpers/security-do";

/**
 * `SecurityCounterDO` (security-alerting spec §2.4). Pool project,
 * real Durable Object storage, explicit clock through `runInDurableObject`.
 */
const { allowFaults } = guardAlertingFaults();

type Count = { n: number };

/** A ledger fake: records each batch; `fail` makes `report` reject. */
function fakeLedger(fail = false) {
  const batches: LedgerReportBatch[] = [];
  return {
    batches,
    rpc: {
      report: async (b: LedgerReportBatch) => {
        if (fail) throw new Error("ledger down");
        batches.push(b);
      },
    },
  };
}

function pendingReports(sql: SqlStorage): CounterReport[] {
  return sql
    .exec<{ report: string }>("SELECT report FROM reports ORDER BY id")
    .toArray()
    .map((r) => JSON.parse(r.report) as CounterReport);
}

const EVENTS_RULES = SIGNAL_RULES.filter((r) => r.measure === "events");

describe("threshold boundary, every events rule", () => {
  it.each(EVENTS_RULES.map((r) => [r.signal, r] as const))("%s: threshold − 1 → none; threshold → one; more → still one", async (_s, rule) => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const subject = rule.subject === "site" ? "site" : rule.subject === "account" ? "user-1" : "203.0.113.0/24";
      const route = rule.signal.startsWith("reset") ? "/auth/reset-password" : "/auth/login";
      await c.recordAt({ rows: [counterRow(rule.signal, subject, rule.threshold - 1, T0, [], route)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(0);
      await c.recordAt({ rows: [counterRow(rule.signal, subject, 1, T0, [], route)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(1);
      await c.recordAt({ rows: [counterRow(rule.signal, subject, 5, T0, [], route)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(1);
    });
  });

  it("the next window still over threshold → a second crossing (merged while the first is pending)", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      const later = T0 + 11 * MINUTE;
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, later)], overflowEvents: 0 }, later);
      const reports = pendingReports(state.storage.sql);
      expect(reports).toHaveLength(1); // m4: merged, not duplicated
      expect(reports[0]?.events).toBe(100);
    });
  });

  it("events older than the window do not count; a burst straddling a minute boundary does", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const old = T0 - 11 * MINUTE;
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 49, old)], overflowEvents: 0 }, old);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 1, T0)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(0);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 48, T0 + MINUTE)], overflowEvents: 0 }, T0 + MINUTE);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 1, T0 + MINUTE)], overflowEvents: 0 }, T0 + MINUTE);
      expect(pendingReports(state.storage.sql)).toHaveLength(1);
    });
  });
});

describe("distinct measures (m2) and member privacy", () => {
  const addresses = (n: number) => Array.from({ length: n }, (_, i) => `person${i}@example.invalid`);

  it("12 failures for 12 addresses from one /64 → 10 counted → one report; 11 → none", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8:1:2::/64", 12, T0, addresses(12))], overflowEvents: 0 }, T0);
      const r = pendingReports(state.storage.sql);
      expect(r).toHaveLength(1);
      expect(r[0]?.observed).toBe(10);
    });
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8:1:2::/64", 11, T0, addresses(11))], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(0);
    });
  });

  it("no `members` row equals or contains an address (control: 10 rows exist)", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const list = addresses(12);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8:1:2::/64", 12, T0, list)], overflowEvents: 0 }, T0);
      const stored = state.storage.sql.exec<{ member: string }>("SELECT member FROM members").toArray().map((m) => m.member);
      expect(stored).toHaveLength(10);
      for (const m of stored) for (const a of list) expect(m.includes(a) || a.includes(m)).toBe(false);
    });
  });

  it("500 failures against one account: events 500, a distinct count capped at 2 × threshold", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const prefixes = Array.from({ length: 500 }, (_, i) => `2001:db8:${i.toString(16)}::/64`);
      await c.recordAt(
        {
          rows: [
            counterRow("targeted_account", "user-1", 500, T0),
            counterRow("distributed_account_guess", "user-1", 500, T0, prefixes),
          ],
          overflowEvents: 0,
        },
        T0,
      );
      const bySignal = new Map(pendingReports(state.storage.sql).map((r) => [r.signal, r]));
      expect(bySignal.get("targeted_account")?.events).toBe(500);
      expect(bySignal.get("distributed_account_guess")?.observed).toBe(10);
      expect(bySignal.get("distributed_account_guess")?.events).toBe(500);
    });
  });
});

describe("an unreachable ledger (N3)", () => {
  it("keeps the report through every alarm, backs off 1, 5, 15, 15 min, logs one fault each, never deletes", async () => {
    allowFaults("security-ledger ledger_unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const down = fakeLedger(true);
      c.ledgerFor = () => down.rpc;
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      let now = T0;
      const delays: number[] = [];
      for (let i = 1; i <= 4; i++) {
        await c.alarmAt(now);
        const next = state.storage.sql.exec<{ next_ms: number }>("SELECT next_ms FROM reports").one().next_ms;
        delays.push((next - now) / MINUTE);
        now = next;
      }
      expect(delays).toEqual([1, 5, 15, 15]);
      expect(warn.mock.calls.filter((a) => String(a[0]).startsWith("security: alerting_fault security-ledger ledger_unreachable"))).toHaveLength(4);
      const up = fakeLedger(false);
      c.ledgerFor = () => up.rpc;
      await c.alarmAt(now);
      expect(up.batches[0]?.reports).toHaveLength(1);
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM reports").one().n).toBe(0);
    });
    expect(reportRetryDelayMs(9)).toBe(15 * MINUTE);
  });
});

describe("a crossing that arrives during the ledger call (audit I-2)", () => {
  it("is kept, not deleted with the reports that call delivered", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      const later = T0 + 11 * MINUTE;
      const received: LedgerReportBatch[] = [];
      c.ledgerFor = () => ({
        report: async (b: LedgerReportBatch) => {
          received.push(b);
          // The input gate is open while this RPC is awaited: a record lands now.
          await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 60, later)], overflowEvents: 0 }, later);
        },
      });
      await c.alarmAt(T0);
      expect(received[0]?.reports.map((r) => r.events)).toEqual([50]);
      const left = pendingReports(state.storage.sql);
      expect(left.map((r) => r.events)).toEqual([60]);
    });
  });
});

describe("retention", () => {
  it("after alarm(now + 61 min) with nothing pending, storage is empty; a later record makes a new salt", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8::/64", 3, T0, ["a@example.invalid", "b@example.invalid", "c@example.invalid"])], overflowEvents: 0 }, T0);
      const salt1 = state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'salt'").one().v;
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM buckets").one().n).toBeGreaterThan(0); // positive control
      await c.alarmAt(T0 + 61 * MINUTE);
      for (const t of ["buckets", "members", "reports", "last_report", "overflow", "meta"]) {
        expect(state.storage.sql.exec<Count>(`SELECT COUNT(*) AS n FROM ${t}`).one().n, t).toBe(0);
      }
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 1, T0 + 2 * HOUR)], overflowEvents: 0 }, T0 + 2 * HOUR);
      const salt2 = state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'salt'").one().v;
      expect(salt2).not.toBe(salt1);
    });
  });
});

describe("summarise (site)", () => {
  it("returns summary-class events and overflow over the half-open period [from, to) (M-5)", async () => {
    await runInDurableObject(freshCounter(), async (c) => {
      quiet(c);
      const m = Math.floor(T0 / MINUTE);
      await c.recordAt({ rows: [counterRow("rate_limit_storm", "site", 7, T0, [], "/comments")], overflowEvents: 4 }, T0);
      const s = await c.summarise(m - 5, m + 1);
      expect(s.activity.rate_limit_storm).toEqual({ events: 7 });
      expect(s.overflowEvents).toBe(4);
      // The boundary minute belongs to the period that STARTS there, never to both.
      expect((await c.summarise(m - 5, m)).activity.rate_limit_storm).toEqual({ events: 0 });
      expect((await c.summarise(m, m + 1)).activity.rate_limit_storm).toEqual({ events: 7 });
    });
  });
});

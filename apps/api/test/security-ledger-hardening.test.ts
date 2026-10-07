import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CLASS_POLICY } from "@thinkersjournal/shared";

import { MAX_PENDING_REPORTS } from "../src/durable-objects/SecurityCounterDO";

import { crossing, freshLedger, guardAlertingFaults, HOUR, MINUTE, ofType, T0, wire } from "./helpers/security-do";

/**
 * `SecurityLedgerDO` fixes from the batch-2 review (security-alerting plan,
 * Tasks 7–9 fix round 1). Same conventions as security-ledger-do.test.ts:
 * explicit clock, `armAt` recorded, and no `alerting_fault` a test did not allow.
 */
const { allowFaults } = guardAlertingFaults();

describe("I-1: a queued message brings the alarm forward", () => {
  it("an alert queued by report() arms for now even when a far alarm is set, and the next tick sends it", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      await state.storage.setAlarm(Date.now() + 30 * 86_400_000);
      const { sent, armed } = wire(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0);
      expect(armed).toEqual([T0]);
      await ledger.alarmAt(T0);
      expect(ofType(sent, "alert")).toHaveLength(1);
      await state.storage.deleteAlarm();
    });
  });

  it("a report that queues nothing leaves a set alarm alone (control)", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { armed } = wire(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0); // sends; cooldown 1 h
      await state.storage.setAlarm(Date.now() + 30 * 86_400_000);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0 + 1); // held only
      expect(armed).toHaveLength(1); // the first report's arming only
      await state.storage.deleteAlarm();
    });
  });
});

/** A valid outbox message, queued by hand so a test can put a bad row in front of it. */
const GOOD = JSON.stringify({ type: "budget_exhausted", signalClass: "ip_burst", day: "2026-10-07", budget: 6, suppressedSoFar: 1 });

function queueRaw(sql: SqlStorage, message: string, covers: string | null, nextMs: number): void {
  sql.exec("INSERT INTO outbox (message, covers, attempts, next_ms) VALUES (?, ?, 0, ?)", message, covers, nextMs);
}

describe("I-2: one outbox row cannot block or re-send the others", () => {
  it("a sent row whose post-send bookkeeping throws is gone, sent once, and the row behind it still goes", async () => {
    allowFaults("security-ledger deliver_bookkeeping");
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sent } = wire(ledger);
      queueRaw(state.storage.sql, GOOD, "{not json", T0);
      queueRaw(state.storage.sql, GOOD.replace("ip_burst", "stuffing"), null, T0);
      await ledger.alarmAt(T0);
      await ledger.alarmAt(T0 + 1);
      expect(ofType(sent, "budget_exhausted").map((m) => m.signalClass)).toEqual(["ip_burst", "stuffing"]);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
    });
  });

  it("a row that throws before sending backs off, is quarantined on its 4th attempt with ONE fault, and blocks nothing", async () => {
    allowFaults("security-ledger deliver_poison");
    const warn = vi.spyOn(console, "warn");
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sent, armed } = wire(ledger);
      queueRaw(state.storage.sql, "{not json", null, T0);
      queueRaw(state.storage.sql, GOOD, null, T0);
      await ledger.alarmAt(T0);
      expect(ofType(sent, "budget_exhausted")).toHaveLength(1); // the row behind it
      const poisonNext = state.storage.sql.exec<{ next_ms: number }>("SELECT next_ms FROM outbox WHERE message = ?", "{not json").one();
      expect(poisonNext.next_ms).toBe(T0 + MINUTE); // backoff, not an immediate re-fire
      for (const at of [T0 + MINUTE, T0 + 6 * MINUTE, T0 + 36 * MINUTE]) await ledger.alarmAt(at);
      const sql = state.storage.sql;
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
      expect(sql.exec<{ message: string }>("SELECT message FROM outbox_poison").toArray()).toEqual([{ message: "{not json" }]);
      expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("security: alerting_fault security-ledger deliver_poison"))).toHaveLength(1);
    });
  });

  it("a deliver step that throws outright re-arms a minute out, never for an instant already past", async () => {
    allowFaults("security-ledger deliver");
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { armed } = wire(ledger);
      ledger.sinkFactory = () => {
        throw new Error("sink construction failed");
      };
      queueRaw(state.storage.sql, GOOD, null, T0 - HOUR);
      await ledger.alarmAt(T0);
      expect(armed.at(-1)).toBe(T0 + MINUTE);
    });
  });
});

describe("m-5: one bad report does not block its batch", () => {
  it("a report of an unknown class is skipped with one fault; the good report beside it is processed", async () => {
    allowFaults("security-ledger report_invalid");
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      const bad = crossing({ signalClass: "renamed_class" as never, subject: "198.51.100.1" });
      await ledger.reportAt({ reports: [bad, crossing()], countedOverflow: {} }, T0);
      await ledger.alarmAt(T0);
      expect(ofType(sent, "alert").map((a) => a.signal)).toEqual(["credential_stuffing"]);
    });
  });

  it("a report that THROWS while processed is dropped alone: the batch is redone one entry at a time", async () => {
    allowFaults("security-ledger report_invalid");
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      const broken = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: undefined as never });
      await ledger.reportAt({ reports: [crossing(), broken], countedOverflow: {} }, T0);
      await ledger.alarmAt(T0);
      expect(ofType(sent, "alert").map((a) => a.signal)).toEqual(["credential_stuffing"]);
    });
  });
});

describe("m-2: forget leaves no raw user id behind", () => {
  it("the sweep cursor and a pending held report's covers no longer name the account", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      wire(ledger);
      const acct = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-x" });
      await ledger.reportAt({ reports: [acct, acct], countedOverflow: {} }, T0); // sent + held
      await ledger.alarmAt(T0 + 1); // queues the held report, its covers naming the held row
      expect(await ledger.accountIdsPage(1)).toEqual(["user-x"]);
      const sql = state.storage.sql;
      const mentions = () =>
        sql.exec<{ n: number }>(
          `SELECT (SELECT COUNT(*) FROM meta WHERE v LIKE '%user-x%')
                + (SELECT COUNT(*) FROM outbox WHERE covers LIKE '%user-x%') AS n`,
        ).one().n;
      expect(mentions()).toBe(2); // control: the cursor and the covers both name it
      await ledger.forgetAccountAt("user-x", T0 + 2);
      expect(mentions()).toBe(0);
    });
  });
});

describe("m-3 and m-10: the UTC day boundary", () => {
  const ELEVEN_PM = Date.parse("2026-10-07T23:00:00.000Z");
  const AFTER_MIDNIGHT = Date.parse("2026-10-08T00:00:30.000Z");

  it("overflow counted at 23:59:30 reaches the first digest after midnight", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      await ledger.alarmAt(ELEVEN_PM); // the day's last digest period starts here
      await ledger.reportAt({ reports: [], countedOverflow: { stuffing: 7 } }, ELEVEN_PM + 59 * MINUTE + 30_000);
      await ledger.alarmAt(AFTER_MIDNIGHT); // queues the digest …
      await ledger.alarmAt(AFTER_MIDNIGHT + 1); // … delivered here
      const line = ofType(sent, "digest").at(-1)?.classes.find((c) => c.signalClass === "stuffing");
      expect(line?.heldCountedNotStored).toBe(7);
    });
  });
});

describe("m-4: held_capped names the cap that was hit", () => {
  it("overflow counted by a COUNTER reports the counter's pending-report cap, not the ledger's row cap", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      await ledger.reportAt({ reports: [], countedOverflow: { stuffing: 3, purge: 2 } }, T0);
      await ledger.alarmAt(T0);
      const caps = Object.fromEntries(ofType(sent, "held_capped").map((m) => [m.signalClass, m.cap]));
      expect(caps).toEqual({ stuffing: MAX_PENDING_REPORTS, purge: MAX_PENDING_REPORTS });
    });
  });
});

describe("m-9: rows past the 64 KB cap are not covered by a report that did not name them", () => {
  it("the next hour's report names the rows the first one only counted in `more`", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sent } = wire(ledger);
      const subjects = Array.from({ length: 150 }, (_, i) => `2001:db8:${i.toString(16)}::/64#${"x".repeat(500)}`);
      await ledger.reportAt({ reports: subjects.flatMap((s) => [crossing({ subject: s }), crossing({ subject: s })]), countedOverflow: {} }, T0);
      await ledger.alarmAt(T0 + 1); // queues report #1
      await ledger.alarmAt(T0 + 2); // delivers it
      const first = ofType(sent, "held_report")[0];
      const named = first?.entries.length ?? 0;
      expect(named).toBeLessThan(150); // control: the byte cap really cut it short
      expect(first?.more).toEqual([{ signalClass: "stuffing", count: 150 - named }]);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM held").one().n).toBe(150 - named);
      await ledger.alarmAt(T0 + HOUR); // report #2 …
      await ledger.alarmAt(T0 + HOUR + 1); // … delivered
      const second = ofType(sent, "held_report")[1];
      expect(second?.entries.length).toBeGreaterThan(0);
      const firstNames = new Set(first?.entries.map((e) => JSON.stringify(e.subject)));
      expect(second?.entries.some((e) => firstNames.has(JSON.stringify(e.subject)))).toBe(false);
    });
  });
});

describe("m-10: a UTC day rollover between report and alarm", () => {
  const MIDNIGHT = Date.parse("2026-10-08T00:00:00.000Z");
  const burst = (i: number) => crossing({ signal: "login_ip_burst", signalClass: "ip_burst", subject: `203.0.113.${i}`, threshold: 50 });

  it("a class's daily budget spent at 23:59 is fresh at 00:00:30; budget_exhausted stays one per day", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      const budget = CLASS_POLICY.ip_burst.dailyBudget;
      await ledger.reportAt({ reports: Array.from({ length: budget + 1 }, (_, i) => burst(i)), countedOverflow: {} }, MIDNIGHT - MINUTE);
      await ledger.alarmAt(MIDNIGHT + 30_000); // delivers yesterday's, after midnight
      await ledger.reportAt({ reports: [burst(200)], countedOverflow: {} }, MIDNIGHT + 31_000);
      await ledger.alarmAt(MIDNIGHT + 32_000);
      expect(ofType(sent, "alert")).toHaveLength(budget + 1);
      expect(ofType(sent, "budget_exhausted").map((m) => m.day)).toEqual(["2026-10-07"]);
    });
  });

  it("an alarm that first runs three days late delivers, beats once for ITS day, and faults nowhere", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0);
      const late = T0 + 3 * 86_400_000 + 10 * HOUR; // 2026-10-10T22:00Z
      await ledger.alarmAt(late);
      await ledger.alarmAt(late + 1);
      expect(ofType(sent, "alert")).toHaveLength(1);
      expect(ofType(sent, "heartbeat").map((h) => [h.day, h.lateMinutes])).toEqual([["2026-10-10", 13 * 60]]);
    });
  });
});

describe("N-1: the per-entry fallback never drops a batch silently", () => {
  const broken = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: undefined as never });

  it("when every entry throws, reportAt rejects, so the counter keeps the batch and retries it", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      wire(ledger);
      await expect(ledger.reportAt({ reports: [broken, broken], countedOverflow: {} }, T0)).rejects.toThrow();
    });
  });

  it("a valid-class entry dropped by a throw is counted, and the next digest reports it", async () => {
    allowFaults("security-ledger report_invalid");
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sent } = wire(ledger);
      await ledger.reportAt({ reports: [crossing(), broken], countedOverflow: {} }, T0);
      await ledger.alarmAt(T0); // queues the digest …
      await ledger.alarmAt(T0 + 1); // … delivered here
      const line = ofType(sent, "digest").at(-1)?.classes.find((c) => c.signalClass === "account");
      expect(line?.heldCountedNotStored).toBe(1);
    });
  });
});

describe("m-A: a sent row whose DELETE throws is never sent again", () => {
  it("the row is marked sent before the delete; later alarms skip it and clean it up once the delete works", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sent } = wire(ledger);
      const sql = state.storage.sql;
      queueRaw(sql, GOOD, null, T0);
      sql.exec("CREATE TRIGGER refuse_outbox_delete BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'delete refused'); END");
      for (const at of [T0, T0 + MINUTE, T0 + 6 * MINUTE, T0 + 36 * MINUTE, T0 + 2 * HOUR]) await ledger.alarmAt(at);
      expect(ofType(sent, "budget_exhausted")).toHaveLength(1);
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox_poison").one().n).toBe(0);
      sql.exec("DROP TRIGGER refuse_outbox_delete");
      await ledger.alarmAt(T0 + 3 * HOUR);
      expect(ofType(sent, "budget_exhausted")).toHaveLength(1);
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE message = ?", GOOD).one().n).toBe(0);
    });
  });
});

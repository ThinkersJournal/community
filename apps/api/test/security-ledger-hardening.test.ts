import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

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

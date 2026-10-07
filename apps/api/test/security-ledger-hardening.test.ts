import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { crossing, freshLedger, guardAlertingFaults, ofType, T0, wire } from "./helpers/security-do";

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

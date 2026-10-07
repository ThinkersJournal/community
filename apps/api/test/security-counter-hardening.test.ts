import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_PENDING_REPORTS } from "../src/durable-objects/SecurityCounterDO";

import { counterRow, freshCounter, guardAlertingFaults, MINUTE, quiet, T0 } from "./helpers/security-do";

/**
 * `SecurityCounterDO` fixes from the batch-2 review (m-6, m-7, m-8). Explicit
 * clock, `armAt` recorded, no `alerting_fault` a test did not allow.
 */
const { allowFaults } = guardAlertingFaults();

type Count = { n: number };
const down = { report: async () => Promise.reject(new Error("ledger down")) };
const meta = (sql: SqlStorage, k: string) => sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v;

describe("m-6: counted-only overflow keeps the instance alive", () => {
  it("with no other rows, an unsent overflow count survives the alarm instead of being wiped by deleteAll", async () => {
    allowFaults("security-ledger ledger_unreachable");
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      c.ledgerFor = () => down;
      state.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('reports_overflow:stuffing', '5')");
      await c.alarmAt(T0);
      expect(meta(state.storage.sql, "reports_overflow:stuffing")).toBe("5");
    });
  });
});

describe("m-7 and m-8: the pending-report cap is a maintained count, per class", () => {
  it("a full ip_burst class counts its next crossing; a stuffing crossing is still stored", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const sql = state.storage.sql;
      sql.exec("INSERT INTO meta (k, v) VALUES ('pending_n:ip_burst', ?)", String(MAX_PENDING_REPORTS));
      const addresses = Array.from({ length: 12 }, (_, i) => `p${i}@example.invalid`);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8::/64", 12, T0, addresses)], overflowEvents: 0 }, T0);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      const stored = sql.exec<{ rkey: string }>("SELECT rkey FROM reports").toArray().map((r) => r.rkey);
      expect(stored).toEqual(["credential_stuffing|2001:db8::/64"]);
      expect(meta(sql, "reports_overflow:ip_burst")).toBe("1");
    });
  });

  it("the maintained count equals the rows through a failed send, a merge during it, and a delivery", async () => {
    allowFaults("security-ledger ledger_unreachable");
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const sql = state.storage.sql;
      const exact = () => expect(Number(meta(sql, "pending_n:ip_burst") ?? "0")).toBe(sql.exec<Count>("SELECT COUNT(*) AS n FROM reports").one().n);
      const burst = (ip: string, at: number) => c.recordAt({ rows: [counterRow("login_ip_burst", ip, 50, at)], overflowEvents: 0 }, at);
      for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) await burst(ip, T0);
      exact();
      c.ledgerFor = () => ({ report: async () => { await burst("203.0.113.1", T0 + 11 * MINUTE); throw new Error("ledger down"); } });
      await c.alarmAt(T0); // fails; the crossing that landed meanwhile merges into the detached row
      exact();
      c.ledgerFor = () => ({ report: async () => undefined });
      await c.alarmAt(T0 + 20 * MINUTE);
      exact();
      expect(sql.exec<Count>("SELECT COUNT(*) AS n FROM reports").one().n).toBe(0); // control: it did drain
    });
  });
});

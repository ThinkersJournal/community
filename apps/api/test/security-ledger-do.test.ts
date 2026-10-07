import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLASS_POLICY, HELD_ROW_CAP, type SecurityAlertMessage } from "@thinkersjournal/shared";

import { LIVENESS_KEY } from "../src/durable-objects/SecurityLedgerDO";
import { ensureLedgerAlarm } from "../src/security/ledger-cron";
import { PRUNE_CHUNK, PRUNE_CHUNKS_PER_RUN } from "../src/security/ledger-prune";

import { capturingSink, crossing, freshLedger, HOUR, MINUTE, ofType, quiet, T0 } from "./helpers/security-do";

/**
 * `SecurityLedgerDO` (security-alerting spec §2.6). Pool
 * project; `sinkFactory` and `siteFor` replaced on the instance (spec §3.3).
 * Messages queued by one alarm are delivered by the next, so the helper runs
 * the alarm twice at the same instant.
 */
afterEach(() => vi.restoreAllMocks());

type Count = { n: number };

/** Polls `read` every 50 ms, at most 5 s, until it is non-null. Only for the one REAL-alarm test. */
async function eventually<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
const NINE_UTC = Date.parse("2026-10-07T09:00:00.000Z");
const noSite = { summarise: async () => ({ activity: {}, overflowEvents: 0 }) };

describe("sending, cooldowns and held subjects (C2)", () => {
  it("a suppressed subject survives the alarm and is named, with its count, by the next held report", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0); // send; cooldown 1 h
      await ledger.reportAt({ reports: [crossing({ events: 20 })], countedOverflow: {} }, T0 + MINUTE);
      await ledger.reportAt({ reports: [crossing({ events: 30 })], countedOverflow: {} }, T0 + 2 * MINUTE);
      await ledger.alarmAt(T0 + HOUR + 1_000); // prunes the expired cooldown row
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0 + HOUR + 2_000);
      await ledger.alarmAt(T0 + HOUR + 3_000);
      expect(ofType(sent, "alert")).toHaveLength(2);
      const held = ofType(sent, "held_report")[0];
      expect(held?.entries[0]).toMatchObject({ signal: "credential_stuffing", suppressed: 2, events: 50 });
    });
  });

  it("a held report the sink refuses 4 times is dropped; the held row survives and the next hour names it", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      let refusals = 0;
      const { sink, sent } = capturingSink((m) => m.type === "held_report" && refusals++ < 4);
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing(), crossing()], countedOverflow: {} }, T0);
      const queued = T0 + 1_000;
      await ledger.alarmAt(queued); // step 4 queues the held report, after this run's deliver step
      for (const at of [queued + 1, queued + 1 + MINUTE, queued + 1 + 6 * MINUTE, queued + 1 + 36 * MINUTE]) {
        await ledger.alarmAt(at);
      }
      expect(refusals).toBe(4);
      const heldReportsLeft = state.storage.sql
        .exec<Count>(`SELECT COUNT(*) AS n FROM outbox WHERE message LIKE '%"type":"held_report"%'`)
        .one().n;
      expect(heldReportsLeft).toBe(0);
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(1);
      await ledger.alarmAt(T0 + 2 * HOUR); // the next hour queues a fresh report …
      await ledger.alarmAt(T0 + 2 * HOUR + 1); // … delivered here
      expect(ofType(sent, "held_report")[0]?.entries[0]?.subject).toEqual({ kind: "ip_prefix", value: "2001:db8:1:2::/64" });
    });
  });

  it("I-7: nothing the ledger sends about an account carries its user id", async () => {
    const userId = "11111111-2222-4333-8444-555555555555";
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const acct = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: userId });
      await ledger.reportAt({ reports: [acct, acct], countedOverflow: {} }, NINE_UTC);
      for (const t of [NINE_UTC + 1, NINE_UTC + 2]) await ledger.alarmAt(t);
      expect(new Set(sent.map((m) => m.type))).toEqual(new Set(["alert", "held_report", "heartbeat", "digest"])); // control
      expect(JSON.stringify(sent)).not.toContain(userId);
      expect(ofType(sent, "alert")[0]?.subject).toEqual({ kind: "account", ref: expect.stringMatching(/^[0-9a-f]{32}$/) });
    });
  });
});

describe("budgets (C1, decoys)", () => {
  it("the 7th ip_burst alert in a day is refused; exactly one budget_exhausted; the digest counts it", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const budget = CLASS_POLICY.ip_burst.dailyBudget;
      const reports = Array.from({ length: budget + 2 }, (_, i) =>
        crossing({ signal: "login_ip_burst", signalClass: "ip_burst", subject: `203.0.113.${i}`, threshold: 50 }),
      );
      await ledger.reportAt({ reports, countedOverflow: {} }, T0);
      await ledger.alarmAt(T0 + HOUR);
      await ledger.alarmAt(T0 + HOUR + 1);
      expect(ofType(sent, "alert")).toHaveLength(budget);
      expect(ofType(sent, "budget_exhausted")).toHaveLength(1);
      const line = ofType(sent, "digest")[0]?.classes.find((c) => c.signalClass === "ip_burst");
      expect(line?.suppressedByBudget).toBe(2);
    });
  });

  it("purge, storm and ip_burst exhausted → a targeted_account crossing is still sent", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const decoys = [
        ...Array.from({ length: 10 }, (_, i) => crossing({ signal: "login_ip_burst", signalClass: "ip_burst", subject: `198.51.100.${i}` })),
        crossing({ signal: "purge_secret_failure", signalClass: "purge", subjectKind: "site", subject: "site" }),
        crossing({ signal: "rate_limit_storm", signalClass: "storm", subjectKind: "site", subject: "site" }),
      ];
      await ledger.reportAt({ reports: decoys, countedOverflow: {} }, T0);
      const target = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-target" });
      await ledger.reportAt({ reports: [target], countedOverflow: {} }, T0 + 1);
      await ledger.alarmAt(T0 + 2);
      expect(ofType(sent, "alert").some((a) => a.signal === "targeted_account")).toBe(true);
    });
  });
});

describe("versions and coverage (F2)", () => {
  it("a subject that crosses again after the snapshot survives delivery and is named again", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      let deliverHeld = false;
      const { sink, sent } = capturingSink((m) => m.type === "held_report" && !deliverHeld);
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing(), crossing()], countedOverflow: {} }, T0); // send + hold
      await ledger.alarmAt(T0 + 1); // queues report #1, built at S
      await ledger.reportAt({ reports: [crossing({ events: 7 })], countedOverflow: {} }, T0 + 2); // re-crosses after S
      deliverHeld = true;
      await ledger.alarmAt(T0 + 3); // report #1 delivered
      expect(ofType(sent, "held_report")).toHaveLength(1);
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(1);
      await ledger.alarmAt(T0 + 2 * HOUR); // the next hour queues report #2 …
      await ledger.alarmAt(T0 + 2 * HOUR + 1); // … and this run delivers it
      const second = ofType(sent, "held_report")[1];
      expect(second?.entries[0]).toMatchObject({ signal: "credential_stuffing", events: 7 + 12 });
    });
  });
});

describe("row caps (F3, D6) and bounded reports (R1)", () => {
  it("25,000 stuffing decoys: 20,000 stored, 5,000 counted, one held_capped; the real target is named first", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const spend = Array.from({ length: 24 }, (_, i) => [
        crossing({ subject: `spend-s-${i}` }),
        crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: `spend-a-${i}` }),
      ]).flat();
      await ledger.reportAt({ reports: spend, countedOverflow: {} }, T0);
      for (let i = 0; i < 25_000; i += 500) {
        const batch = Array.from({ length: 500 }, (_, j) => crossing({ subject: `2001:db8:${(i + j).toString(16)}::/64` }));
        await ledger.reportAt({ reports: batch, countedOverflow: {} }, T0 + 1);
      }
      const target = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-real", events: 31 });
      await ledger.reportAt({ reports: [target], countedOverflow: {} }, T0 + 2);
      const stored = state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM held WHERE signal_class = 'stuffing'").one().n;
      expect(stored).toBe(HELD_ROW_CAP.stuffing);
      await ledger.alarmAt(T0 + 3);
      await ledger.alarmAt(T0 + 4);
      expect(ofType(sent, "held_capped").filter((m) => m.signalClass === "stuffing")).toHaveLength(1);
      const report = ofType(sent, "held_report")[0];
      expect(report?.entries[0]?.signal).toBe("targeted_account");
      expect(JSON.stringify(report?.entries).length).toBeLessThanOrEqual(64 * 1024);
      expect(report?.countedNotStored.find((c) => c.signalClass === "stuffing")?.count).toBeGreaterThanOrEqual(5_000);
    });
  });
});

describe("pruning keeps up (F3; plan ruling P-4; audit I-1)", () => {
  it("a short chunk then a large target: every call stays inside its budget, and the backlog drains", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sink } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      const armed = quiet(ledger);
      const sql = state.storage.sql;
      sql.exec("INSERT INTO meta (k, v) VALUES ('w:account', '100000'), ('held_n:account', '4500')");
      for (let i = 0; i < 4_500; i++) {
        sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('account', ?, 'targeted_account', 'account', ?, 1, 1, ?, ?)`,
          `targeted_account|a${i}`,
          `a${i}`,
          i + 1,
          T0 - 8 * 86_400_000,
        );
      }
      for (let i = 0; i < 6_000; i++) sql.exec("INSERT INTO cooldowns (signal, subject, until_ms) VALUES ('login_ip_burst', ?, ?)", `c${i}`, T0 - 1);
      const rows = () =>
        sql.exec<Count>("SELECT (SELECT COUNT(*) FROM held) + (SELECT COUNT(*) FROM cooldowns) AS n").one().n;
      const perCall: number[] = [];
      for (let run = 0; run < 10 && rows() > 0; run++) {
        const before = rows();
        await ledger.alarmAt(T0 + run);
        perCall.push(before - rows());
      }
      expect(rows()).toBe(0);
      for (const n of perCall) expect(n).toBeLessThanOrEqual(PRUNE_CHUNK * PRUNE_CHUNKS_PER_RUN);
      expect(perCall).toEqual([4_500, 5_000, 1_000]);
      expect(armed.length).toBeGreaterThan(0);
    });
  });

  it("10,000 aged covered rows: one alarm prunes its chunk budget and re-arms for now; the next finishes", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sink } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const sql = state.storage.sql;
      sql.exec("INSERT INTO meta (k, v) VALUES ('w:stuffing', '20000')");
      for (let i = 0; i < 10_000; i++) {
        sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('stuffing', ?, 'credential_stuffing', 'ip', ?, 1, 1, ?, ?)`,
          `credential_stuffing|s${i}`,
          `s${i}`,
          i + 1,
          T0 - 8 * 86_400_000,
        );
      }
      sql.exec("INSERT INTO meta (k, v) VALUES ('held_n:stuffing', '10000')");
      const armed = quiet(ledger);
      await ledger.alarmAt(T0);
      expect(sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(10_000 - PRUNE_CHUNK * PRUNE_CHUNKS_PER_RUN);
      expect(armed.at(-1)).toBe(T0); // work remains → re-armed for NOW
      await ledger.alarmAt(T0 + 1);
      expect(sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(0);
      expect(sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'held_n:stuffing'").one().v).toBe("0");
    });
  });
});

describe("independent steps (R1), heartbeat (N2) and liveness (R2)", () => {
  it("with the DELIVER step throwing and summarise failing, the later steps still run and the KV key is written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      ledger.sinkFactory = () => {
        throw new Error("sink construction failed"); // deliver() throws before any send
      };
      ledger.siteFor = () => ({
        summarise: async () => {
          throw new Error("site down");
        },
      });
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing(), crossing()], countedOverflow: {} }, NINE_UTC);
      await ledger.alarmAt(NINE_UTC + 1);
      expect(warn.mock.calls.some((c) => c[0] === "security: alerting_fault security-ledger deliver")).toBe(true);
      const queued = state.storage.sql
        .exec<{ message: string }>("SELECT message FROM outbox")
        .toArray()
        .map((r) => (JSON.parse(r.message) as SecurityAlertMessage).type);
      expect(queued).toEqual(expect.arrayContaining(["alert", "heartbeat", "held_report", "digest"]));
      const digest = state.storage.sql
        .exec<{ message: string }>(`SELECT message FROM outbox WHERE message LIKE '%"type":"digest"%'`)
        .one().message;
      expect(digest).toContain('"siteSummaryUnavailable":true');
      expect(await env.HEALTH.get(LIVENESS_KEY)).toBe(String(NINE_UTC + 1));
    });
  });

  it("a quiet day → exactly one heartbeat with lateMinutes 0; first alarm at 10:05 → lateMinutes 65", async () => {
    const runs: readonly (readonly [readonly number[], number])[] = [
      [[NINE_UTC - 1, NINE_UTC, NINE_UTC + 1, NINE_UTC + 2 * HOUR], 0],
      [[NINE_UTC + 65 * MINUTE, NINE_UTC + 65 * MINUTE + 1, NINE_UTC + 3 * HOUR], 65],
    ];
    for (const [times, late] of runs) {
      await runInDurableObject(freshLedger(), async (ledger) => {
        const { sink, sent } = capturingSink();
        ledger.sinkFactory = () => sink;
        ledger.siteFor = () => noSite;
        quiet(ledger);
        for (const t of times) await ledger.alarmAt(t);
        const beats = ofType(sent, "heartbeat");
        expect(beats).toHaveLength(1);
        expect(beats[0]?.lateMinutes).toBe(late);
      });
    }
  });

  it("report() with nothing queued still arms an alarm (N2)", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const armed = quiet(ledger);
      await ledger.reportAt({ reports: [], countedOverflow: {} }, T0);
      expect(armed).toHaveLength(1);
    });
  });

  it("the cron's ensureLedgerAlarm sets an alarm on the real `ledger` when none is set", async () => {
    // The production instance name: ensureLedgerAlarm takes no name, by design (m-d).
    const stub = env.SECURITY_LEDGER.getByName("ledger");
    await runInDurableObject(stub, (_l, state) => state.storage.deleteAlarm());
    await ensureLedgerAlarm(env);
    // A REAL alarm, set for now: it may already have run and re-armed, so poll (bounded) for "set".
    expect(await eventually(() => runInDurableObject(stub, (_l, state) => state.storage.getAlarm()))).not.toBeNull();
  });

  it("ensureAlarm leaves an alarm that is already set alone (a second cron call changes nothing)", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const far = Date.now() + 30 * 86_400_000;
      await state.storage.setAlarm(far);
      await ledger.ensureAlarm();
      await ledger.ensureAlarm();
      expect(await state.storage.getAlarm()).toBe(far);
    });
  });
});

describe("undeliverable", () => {
  it("after 4 failures the message is logged in full through the log sink, dropped, and counted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      let refuse = true;
      const { sink, sent } = capturingSink((m: SecurityAlertMessage) => refuse && m.type === "alert");
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0);
      let now = T0;
      for (const step of [0, 1, 5, 30]) {
        now += step * MINUTE;
        await ledger.alarmAt(now);
      }
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM outbox WHERE message LIKE '%\"type\":\"alert\"%'").one().n).toBe(0);
      expect(warn.mock.calls.some((c) => c[0] === "security-alert: alert")).toBe(true);
      refuse = false;
      await ledger.alarmAt(T0 + 2 * HOUR); // queues the next hour's digest …
      await ledger.alarmAt(T0 + 2 * HOUR + 1); // … delivered here
      expect(ofType(sent, "digest").at(-1)?.undeliverable).toBe(1);
    });
  });
});

/** Forget and tombstone (N7, m-e) — PR 1, with the ledger (audit I-11). */
describe("forgetAccount", () => {
  it("deletes refs, held rows and cooldowns; a late report re-creates nothing; after 30 days it would", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      quiet(ledger);
      const acct = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-x" });
      await ledger.reportAt({ reports: [acct, acct], countedOverflow: {} }, T0);
      const rows = () =>
        state.storage.sql
          .exec<Count>(
            `SELECT (SELECT COUNT(*) FROM account_refs) + (SELECT COUNT(*) FROM held) + (SELECT COUNT(*) FROM cooldowns) AS n`,
          )
          .one().n;
      expect(rows()).toBe(3);
      await ledger.forgetAccountAt("user-x", T0 + 1);
      await ledger.forgetAccountAt("user-x", T0 + 2); // twice is harmless
      expect(rows()).toBe(0);
      await ledger.reportAt({ reports: [acct], countedOverflow: {} }, T0 + 3);
      expect(rows()).toBe(0);
      await ledger.reportAt({ reports: [acct], countedOverflow: {} }, T0 + 31 * 86_400_000);
      expect(rows()).toBeGreaterThan(0);
    });
  });
});

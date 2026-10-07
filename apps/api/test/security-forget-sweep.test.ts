import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withClient } from "../src/db/client";
import { forgetAccountEverywhere } from "../src/security/forget";
import { SWEEP_BATCH, sweepForgottenAccounts } from "../src/security/forget-sweep";

import { quiet } from "./helpers/security-do";

/**
 * The nightly N7 sweep (security-alerting spec §2.6 N7, m-e; PM ruling R2-1).
 * Each test uses a FRESH ledger instance, passed to the sweep, so the real
 * `ledger` and other files' rows never matter.
 */
const created: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.splice(0)]));
  await waitOnExecutionContext(ctx);
});

async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => (await c.query(text, params)).rows as T[]);
  await waitOnExecutionContext(ctx);
  return rows;
}

async function newUser(): Promise<string> {
  const row = (
    await sql<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [
      `sweep_${crypto.randomUUID()}@example.test`,
    ])
  ).at(0);
  const id = row?.id ?? "";
  created.push(id);
  return id;
}

const crossing = (subject: string, nowMs: number) => ({
  signal: "targeted_account" as const,
  signalClass: "account" as const,
  subjectKind: "account" as const,
  subject,
  windowStartMs: nowMs - 3_600_000,
  windowEndMs: nowMs,
  observed: 30,
  events: 30,
  threshold: 30,
  severity: "critical" as const,
  byRoute: { "/auth/login": 30 },
});

describe("sweepForgottenAccounts (R2-1)", () => {
  it("a forget LOST by a failing ledger call is recovered by the sweep: anonymised and deleted accounts, live control kept", { timeout: 60_000 }, async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = env.SECURITY_LEDGER.getByName(`sweep-${crypto.randomUUID()}`);
    const [anonymised, deleted, live] = [await newUser(), await newUser(), await newUser()];
    const now = Date.now();
    await runInDurableObject(ledger, async (l) => {
      quiet(l);
      for (const id of [anonymised, deleted, live]) await l.reportAt({ reports: [crossing(id, now), crossing(id, now)], countedOverflow: {} }, now);
    });
    const rowsFor = (id: string) =>
      runInDurableObject(ledger, (_l, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM account_refs WHERE user_id = ?1)
                  + (SELECT COUNT(*) FROM held WHERE subject_kind = 'account' AND subject = ?1) AS n`,
            id,
          )
          .one().n,
      );
    // The reaper's forget, LOST: the ledger call fails (logged once, continued).
    const failing = { ...env, SECURITY_LEDGER: { getByName: () => ({ forgetAccount: async () => Promise.reject(new Error("down")) }) } };
    await forgetAccountEverywhere(failing as unknown as Env, anonymised, "anonymise-accounts");
    expect(err).toHaveBeenCalled();
    await sql("UPDATE users SET anonymised_at = now() WHERE id = $1", [anonymised]);
    await sql("DELETE FROM users WHERE id = $1", [deleted]);
    expect([await rowsFor(anonymised), await rowsFor(deleted), await rowsFor(live)]).toEqual([2, 2, 2]); // positive control

    const ctx = createExecutionContext();
    const counts = await sweepForgottenAccounts(env, ctx, ledger);
    await waitOnExecutionContext(ctx);
    expect([await rowsFor(anonymised), await rowsFor(deleted), await rowsFor(live)]).toEqual([0, 0, 2]);
    // Step 1 (anonymised in the last 3 days) forgot `anonymised`; step 2 then found
    // only `deleted` and `live` in the ledger, and forgot the one Postgres no longer has.
    expect(counts?.recentAnonymised).toBeGreaterThanOrEqual(1);
    expect(counts?.recentAnonymised).toBeLessThanOrEqual(SWEEP_BATCH);
    expect(counts?.ledgerChecked).toBe(2);
    expect(counts?.ledgerForgotten).toBe(1);

    // Idempotent: a second run forgets nothing more and still keeps the live account.
    const again = await sweepForgottenAccounts(env, createExecutionContext(), ledger);
    expect(again?.ledgerForgotten).toBe(0);
    expect(await rowsFor(live)).toBe(2);
    // The tombstone the sweep left stops a late report re-creating the anonymised account's rows.
    await runInDurableObject(ledger, (l) => l.reportAt({ reports: [crossing(anonymised, now + 1)], countedOverflow: {} }, now + 1));
    expect(await rowsFor(anonymised)).toBe(0);
  });
});

// Split from the describe above only to keep each callback under 50 lines (Codacy).
describe("sweepForgottenAccounts (R2-1) — bounds", () => {
  it("is bounded per run: the ledger page never exceeds SWEEP_BATCH, and its cursor wraps to visit every id", { timeout: 60_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = env.SECURITY_LEDGER.getByName(`sweep-${crypto.randomUUID()}`);
    await runInDurableObject(ledger, (_l, s) => {
      for (let i = 0; i < SWEEP_BATCH + 5; i++) {
        s.storage.sql.exec("INSERT INTO account_refs (user_id, ref, last_used_ms) VALUES (?, ?, ?)", `ghost-${String(i).padStart(4, "0")}`, `r${i}`, Date.now());
      }
    });
    const first = await sweepForgottenAccounts(env, createExecutionContext(), ledger);
    const second = await sweepForgottenAccounts(env, createExecutionContext(), ledger);
    expect([first?.ledgerChecked, second?.ledgerChecked]).toEqual([SWEEP_BATCH, 5]);
    const left = await runInDurableObject(ledger, (_l, s) => s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM account_refs").one().n);
    expect(left).toBe(0); // none of the ghosts is a live user
  });
});

/**
 * Final review I-2: a failed forget must not write the id of the account being
 * erased into Workers Logs (whose retention is not ours to scrub). The nightly
 * sweep finds the account itself; the log needs only the step and the error name.
 */
describe("forgetAccountEverywhere — a failure logs no user id", () => {
  it("logs the source, the step and the error's name, and never the id or the error's message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userId = crypto.randomUUID();
    const failing = {
      SECURITY_LEDGER: {
        getByName: () => ({ forgetAccount: async () => Promise.reject(new TypeError(`ledger refused ${userId}`)) }),
      },
    };
    await forgetAccountEverywhere(failing as unknown as Env, userId, "anonymise-accounts");
    const text = err.mock.calls.flat().map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack ?? ""}` : String(a)));
    expect(text.some((t) => t.includes("anonymise-accounts: forgetAccount failed"))).toBe(true); // control: it did log
    expect(text).toContain("TypeError");
    expect(text.filter((t) => t.includes(userId))).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer } from "../src/security-buffer";

import type { CounterBatch, SecurityRequestScope } from "../src/security-buffer";
import type { SecurityEvent } from "../src/security-log";

const AT = new Date("2026-10-07T12:00:00.000Z");

/** A fake scope: records every `record` call by shard, and every waitUntil promise. */
function fakeScope(reject = false) {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  const pending: Promise<unknown>[] = [];
  const scope: SecurityRequestScope = {
    waitUntil: (p) => {
      pending.push(p);
    },
    stubFor: (shard) => ({
      record: async (batch) => {
        calls.push({ shard, batch });
        if (reject) throw new Error("record failed");
      },
    }),
  };
  return { scope, calls, pending };
}

/** A `sleep` the test releases by hand: no wall clock anywhere. */
function manualSleep() {
  let release: () => void = () => undefined;
  const sleep = () =>
    new Promise<void>((r) => {
      release = r;
    });
  return { sleep, release: () => release() };
}

const loginFail = (ip: string): SecurityEvent => ({ kind: "auth_failure", route: "/auth/login", reason: "invalid_credentials", ip });

afterEach(() => vi.restoreAllMocks());

describe("SecurityEventBuffer (security-alerting spec §2.5): one record per shard, capped subjects", () => {
  it("100 user-keyed 429s → no record until sleep resolves, then ONE record to `site` with n = 100", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    const e: SecurityEvent = { kind: "rate_limited", route: "/comments", reason: "user", ip: "203.0.113.9" };
    for (let i = 0; i < 100; i++) buffer.add(e, AT, {}, scope);
    expect(calls).toHaveLength(0);
    expect(pending).toHaveLength(1);
    release();
    await Promise.all(pending);
    expect(calls.map((c) => c.shard)).toEqual(["site"]);
    expect(calls[0]?.batch.rows.map((r) => r.n)).toEqual([100]);
  });

  it("60 failures from 60 /64s → 50 /64 subjects; the other 10 events' 20 ip increments become overflow on `site`", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    for (let i = 0; i < 60; i++) buffer.add(loginFail(`2001:db8:${i.toString(16)}::1`), AT, { email: `p${i}@example.invalid` }, scope);
    release();
    await Promise.all(pending);
    const ipSubjects = new Set(calls.filter((c) => c.shard.startsWith("ip:")).flatMap((c) => c.batch.rows.map((r) => r.subject)));
    expect(ipSubjects.size).toBe(50); // a literal: the test must not move with the constant (M-8)
    const site = calls.find((c) => c.shard === "site");
    expect(site?.batch.overflowEvents).toBe(20);
    const storm = site?.batch.rows.find((r) => r.signal === "login_failure_storm");
    expect(storm?.n).toBe(60);
  });

  it("300 account failures across 300 accounts → accounts capped at 200, independently of the /64 cap", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    for (let i = 0; i < 300; i++) {
      buffer.add(loginFail(`2001:db8:${(i % 60).toString(16)}::1`), AT, { email: `p${i}@example.invalid`, userId: `u${i}` }, scope);
    }
    release();
    await Promise.all(pending);
    const accounts = new Set(calls.filter((c) => c.shard.startsWith("acct:")).flatMap((c) => c.batch.rows.map((r) => r.subject)));
    expect(accounts.size).toBe(200);
    const ips = new Set(calls.filter((c) => c.shard.startsWith("ip:")).flatMap((c) => c.batch.rows.map((r) => r.subject)));
    expect(ips.size).toBe(50);
  });

});

describe("SecurityEventBuffer (security-alerting spec §2.5): separate caps and failures", () => {
  it("I-10: a reset-token flood from 60 networks never pushes a stuffing /64 into overflow (its own cap)", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    for (let i = 0; i < 60; i++) {
      const e: SecurityEvent = { kind: "auth_failure", route: "/auth/reset-password", reason: "invalid_reset_token", ip: `198.51.${i}.7` };
      buffer.add(e, AT, {}, scope);
    }
    buffer.add(loginFail("2001:db8:aa:1::9"), AT, { email: "p@example.invalid" }, scope);
    release();
    await Promise.all(pending);
    const rows = calls.filter((c) => c.shard.startsWith("ip:")).flatMap((c) => c.batch.rows);
    expect(rows.some((r) => r.signal === "credential_stuffing" && r.subject === "2001:db8:aa:1::/64")).toBe(true);
    expect(new Set(rows.filter((r) => r.signal === "reset_token_burst").map((r) => r.subject)).size).toBe(50);
    expect(calls.find((c) => c.shard === "site")?.batch.overflowEvents).toBe(10);
  });

  it("a record that rejects → one count-only console.error, and flush resolves", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, pending } = fakeScope(true);
    buffer.add(loginFail("203.0.113.9"), AT, { email: "p@example.invalid", userId: "u1" }, scope);
    release();
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]?.[1]).toEqual({ failed: expect.any(Number), of: expect.any(Number) });
    expect(JSON.stringify(err.mock.calls)).not.toContain("203.0.113.9");
  });
});

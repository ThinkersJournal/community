import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  limiterIpKey,
  logSecurityEvent,
  SecurityEventBuffer,
  shardFor,
  type CounterBatch,
  type SecurityEvent,
} from "@thinkersjournal/shared";

import { setSecurityScopeOverridesForTests, withSecurityScope } from "../src/security/scope";

/**
 * `withSecurityScope` (security-alerting spec §2.2 item 3). It must
 * return EXACTLY what the handler returns, call it once, and never let counting
 * change a response, whatever counting does.
 */
afterEach(() => {
  setSecurityScopeOverridesForTests(null);
  vi.restoreAllMocks();
});

const FAIL: SecurityEvent = { kind: "auth_failure", route: "/auth/login", reason: "invalid_credentials", ip: "203.0.113.9" };
const now = () => Promise.resolve();
const never = () => new Promise<void>(() => undefined);

function recorder(reject = false) {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  return {
    calls,
    stubFor: (shard: string) => ({
      record: (batch: CounterBatch) => {
        calls.push({ shard, batch });
        return reject ? Promise.reject(new Error("counter down")) : Promise.resolve();
      },
    }),
  };
}

class ThrowingBuffer extends SecurityEventBuffer {
  override add(): void {
    throw new Error("buffer broke");
  }
}

describe("withSecurityScope", () => {
  it("returns the handler's own Response object and calls it once", async () => {
    const response = new Response("handler body");
    const handler = vi.fn(() => Promise.resolve(response));
    expect(await withSecurityScope(env, createExecutionContext(), handler)).toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("an event logged inside the scope is flushed in a waitUntil, one record per shard", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(now), stubFor: r.stubFor });
    const ctx = createExecutionContext();
    await withSecurityScope(env, ctx, () => {
      logSecurityEvent(FAIL, { email: "p@example.invalid" });
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    await waitOnExecutionContext(ctx);
    expect(r.calls.map((c) => c.shard).sort()).toEqual(expect.arrayContaining(["site"]));
    expect(r.calls.some((c) => c.shard.startsWith("ip:"))).toBe(true);
  });

  it.each([
    ["counting off", { SECURITY_COUNTING: "off" }, () => recorder()],
    ["a throwing buffer", {}, () => recorder()],
    ["a rejecting stub", {}, () => recorder(true)],
  ] as const)("with %s: the same response, called once, nothing thrown", async (name, envOver, make) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = make();
    const buffer = name === "a throwing buffer" ? new ThrowingBuffer(now) : new SecurityEventBuffer(now);
    setSecurityScopeOverridesForTests({ buffer, stubFor: r.stubFor });
    const response = new Response("x");
    const handler = vi.fn(() => {
      logSecurityEvent(FAIL);
      return Promise.resolve(response);
    });
    const ctx = createExecutionContext();
    expect(await withSecurityScope({ ...env, ...envOver }, ctx, handler)).toBe(response);
    await waitOnExecutionContext(ctx);
    expect(handler).toHaveBeenCalledTimes(1);
    if (name === "counting off") expect(r.calls).toHaveLength(0);
  });
});

// Split from the describe above only to keep each callback under 50 lines (Codacy).
describe("withSecurityScope — where counting reaches, and where it never does", () => {
  it("confirmation 3: with the DEFAULT stubFor, a flush in a request's waitUntil reaches the REAL counter instance", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(now) }); // stubFor left at its default
    const ip = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}::9`;
    const ctx = createExecutionContext();
    await withSecurityScope(env, ctx, () => {
      logSecurityEvent({ ...FAIL, ip }, { email: "p@example.invalid" });
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    await waitOnExecutionContext(ctx);
    const subject = limiterIpKey(ip);
    const rows = await runInDurableObject(env.SECURITY_COUNTER.getByName(shardFor("ip", subject)), (_c, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM buckets WHERE subject = ?", subject).one().n,
    );
    expect(rows).toBe(1);
  });

  it("outside any scope (the cron) an event is logged but never counted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(now), stubFor: r.stubFor });
    logSecurityEvent(FAIL);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.calls).toHaveLength(0);
  });

  it("no DO call on the response path: with a sleep that never ends, the response resolves and nothing is recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(never), stubFor: r.stubFor });
    const res = await withSecurityScope(env, createExecutionContext(), () => {
      logSecurityEvent(FAIL);
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    expect(res.status).toBe(401);
    expect(r.calls).toHaveLength(0);
  });
});

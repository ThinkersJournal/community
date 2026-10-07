import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer, type CounterBatch, type SecurityCounterRpc } from "@thinkersjournal/shared";

import { handlePurgeRequest } from "../src/lib/purge";
import { purgeSecurityEventSink } from "../src/lib/security-counting";

import type { PurgeContext, PurgeFailureLimiter } from "../src/lib/purge";

/**
 * The web Worker's purge counting (security-alerting spec §2.2 item 4; plan
 * Task 12). Plain Node, like test/purge.test.ts: the DO binding is a fake.
 */
afterEach(() => vi.restoreAllMocks());

const SECRET = "dev-purge-secret-not-for-production";

function ctxWith(secret: string, ip = "203.0.113.9"): PurgeContext {
  return {
    request: new Request("https://community.thinkersjournal.com/internal/purge", {
      method: "POST",
      headers: { "X-Purge-Secret": secret, "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ tags: ["post:1"] }),
    }),
    cache: { invalidate: vi.fn(() => Promise.resolve()) },
  };
}

const allow: PurgeFailureLimiter = { limit: () => Promise.resolve({ success: true }) };

function fakeEnv(counting = "on") {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  const stub = (shard: string): SecurityCounterRpc => ({
    record: (batch) => {
      calls.push({ shard, batch });
      return Promise.resolve();
    },
  });
  return { calls, env: { SECURITY_COUNTING: counting, SECURITY_COUNTER: { getByName: stub } } };
}

describe("purge counting", () => {
  it("a wrong secret calls onSecurityEvent once; a right one never (positive control first)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen = vi.fn();
    expect((await handlePurgeRequest(ctxWith(SECRET), SECRET, allow, seen)).status).toBe(200);
    expect(seen).not.toHaveBeenCalled();
    expect((await handlePurgeRequest(ctxWith("wrong-secret-of-the-same-length-000000"), SECRET, allow, seen)).status).toBe(403);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]).toMatchObject({ kind: "auth_failure", route: "/internal/purge", reason: "bad_purge_secret" });
  });

  it("a flood of 50 wrong secrets → ONE record per flush, to `site`, not 50", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { calls, env } = fakeEnv();
    const pending: Promise<unknown>[] = [];
    let release: () => void = () => undefined;
    const buffer = new SecurityEventBuffer(() => new Promise<void>((r) => (release = r)));
    const sink = purgeSecurityEventSink(env, (p) => pending.push(p), buffer);
    for (let i = 0; i < 50; i++) await handlePurgeRequest(ctxWith(`wrong-${i}`), SECRET, allow, sink);
    expect(calls).toHaveLength(0);
    release();
    await Promise.all(pending);
    expect(calls.map((c) => c.shard)).toEqual(["site"]);
    expect(calls[0]?.batch.rows.find((r) => r.signal === "purge_secret_failure")?.n).toBe(50);
  });

  it('SECURITY_COUNTING="off" → a no-op: no waitUntil, no record', async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { calls, env } = fakeEnv("off");
    const waitUntil = vi.fn();
    const sink = purgeSecurityEventSink(env, waitUntil, new SecurityEventBuffer(() => Promise.resolve()));
    await handlePurgeRequest(ctxWith("wrong"), SECRET, allow, sink);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a throwing onSecurityEvent never turns the 403 into a 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom = () => {
      throw new Error("counting broke");
    };
    expect((await handlePurgeRequest(ctxWith("wrong"), SECRET, allow, boom)).status).toBe(403);
  });
});

/**
 * PM ruling (I-5, option A): the cross-script counter call may fail (it does
 * across two local `wrangler dev` processes, the E2E's topology). It must
 * never reach the purge response, and it must never be silent.
 */
describe("a failing SECURITY_COUNTER binding (PM ruling I-5)", () => {
  const throwsOnGet = { getByName: (): SecurityCounterRpc => { throw new Error("binding broke"); } };
  const rejectsRecord = { getByName: (): SecurityCounterRpc => ({ record: async () => Promise.reject(new Error("Network connection lost.")) }) };

  it.each([
    ["getByName throws", throwsOnGet],
    ["record rejects", rejectsRecord],
  ])("%s: the purge response is unchanged, the flush resolves, and one alerting_fault line is logged", async (_name, binding) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const baseline = await handlePurgeRequest(ctxWith("wrong-secret"), SECRET, allow, () => undefined);
    const pending: Promise<unknown>[] = [];
    const env = { SECURITY_COUNTING: "on", SECURITY_COUNTER: binding };
    const sink = purgeSecurityEventSink(env, (p) => pending.push(p), new SecurityEventBuffer(() => Promise.resolve()));
    const response = await handlePurgeRequest(ctxWith("wrong-secret"), SECRET, allow, sink);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(response.status).toBe(baseline.status);
    expect(await response.text()).toBe(await baseline.text());
    const faults = warn.mock.calls.filter((c) => String(c[0]) === "security: alerting_fault security-counter counter_unreachable");
    expect(faults).toHaveLength(1);
  });
});

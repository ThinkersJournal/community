import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer, shardFor, type CounterBatch } from "@thinkersjournal/shared";

import worker from "../src";
import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import { setSecurityScopeOverridesForTests } from "../src/security/scope";

/**
 * Login is counted end to end (security-alerting spec §2.2 item 2, §5), through
 * the real router and `withSecurityScope`, with the buffer and
 * the counter stubs swapped through the scope's test seam.
 */
const ORIGIN = "https://community.thinkersjournal.com";
const PASSWORD = "correct-horse-battery-staple";
const created: string[] = [];

afterEach(async () => {
  setSecurityScopeOverridesForTests(null);
  vi.restoreAllMocks();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE email = ANY($1)", [created.splice(0)]));
  await waitOnExecutionContext(ctx);
});

async function newUser(): Promise<{ email: string; id: string }> {
  const email = `alert_${crypto.randomUUID()}@example.test`;
  created.push(email);
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, await hashPassword(PASSWORD)],
    );
    return rows[0]?.id ?? "";
  });
  await waitOnExecutionContext(ctx);
  return { email, id };
}

function recorder(reject = false) {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  return {
    calls,
    stubFor: (shard: string) => ({
      record: async (batch: CounterBatch) => {
        calls.push({ shard, batch });
        if (reject) throw new Error("counter down");
      },
    }),
  };
}

async function login(email: string, password: string, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.77" },
      body: JSON.stringify({ email, password }),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("login is counted", () => {
  it("a wrong password for a real account → one targeted_account event on that account's shard", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: r.stubFor });
    const { email, id } = await newUser();
    expect((await login(email, "wrong-password-0000")).status).toBe(401);
    const acct = r.calls.find((c) => c.shard === shardFor("account", id));
    expect(acct?.batch.rows.find((row) => row.signal === "targeted_account")).toMatchObject({ subject: id, n: 1 });
  });

  it("a nonexistent address → no account increment (control: the case above)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: r.stubFor });
    await login(`nobody_${crypto.randomUUID()}@example.test`, "wrong-password-0000");
    expect(r.calls.some((c) => c.shard.startsWith("acct:"))).toBe(false);
    expect(r.calls.some((c) => c.shard === "site")).toBe(true);
  });

  it("a rejecting counter changes nothing: byte-identical 401 body, and a correct password still gets 200 + Set-Cookie", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { email } = await newUser();
    const control = await (await login(email, "wrong-password-0000", { ...env, SECURITY_COUNTING: "off" })).text();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: recorder(true).stubFor });
    expect(await (await login(email, "wrong-password-0000")).text()).toBe(control);
    const ok = await login(email, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => c.startsWith("tj_session="))).toBe(true);
  });

  it("kill switch: SECURITY_COUNTING=off still logs the security: line and records nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: r.stubFor });
    const { email } = await newUser();
    await login(email, "wrong-password-0000", { ...env, SECURITY_COUNTING: "off" });
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("security: auth_failure /auth/login"))).toBe(true);
    expect(r.calls).toHaveLength(0);
  });
});

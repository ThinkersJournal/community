import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer } from "@thinkersjournal/shared";

import worker from "../src";
import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import { setSecurityScopeOverridesForTests } from "../src/security/scope";
import { awaitLimiterBurstWindow } from "./helpers/limiter-window";

/**
 * The Turnstile challenge on `POST /auth/login`
 * (docs/superpowers/specs/2026-10-11-login-turnstile-challenge-design.md, §8:
 * T1..T11), behind the api's `LOGIN_CHALLENGE` flag.
 *
 * The soft thresholds are per 60 s per Cloudflare location: `email` 3, `ip:email`
 * 3, `ip` 15, on `LOGIN_CHALLENGE_LIMITER` (3) and `LOGIN_CHALLENGE_IP_LIMITER`
 * (15). The three existing hard caps (30/10/10) are untouched and run first.
 *
 * ⚠️ EVERY ADDRESS AND EVERY IP IS UNIQUE PER TEST. The pool's limiter is a fixed
 * wall-clock window shared by the whole file (test/helpers/limiter-window.ts), so
 * a test only owns its buckets if it owns its keys. Each burst also waits for a
 * safe part of the window first.
 *
 * ⚠️ HOW "NEVER CALLED" IS OBSERVED. The workerd pool cannot spy on an ES module's
 * export, so the lookup is observed through the `Hyperdrive` binding it reads
 * (`withClient` reads `connectionString` exactly once per query) and the limiters
 * through a recording wrapper. Each such absence is paired with a presence on the
 * attempts that DO reach the lookup, in the same test.
 */

const ORIGIN = "https://community.thinkersjournal.com";
const PASSWORD = "correct-horse-battery-staple";
const SOFT_LIMIT = 3;
const SOFT_IP_LIMIT = 15;
const HARD_EMAIL_LIMIT = 10;

const created: string[] = [];

function uniqueEmail(): string {
  const email = `t_lc_${crypto.randomUUID()}@example.com`;
  created.push(email);
  return email;
}

/** A per-test client IP (IPv6 documentation prefix), so no IP-keyed bucket is shared. */
function uniqueIp(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}::1`;
}

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const result = await c.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
  await waitOnExecutionContext(ctx);
  return rows;
}

async function insertUser(email: string): Promise<string> {
  const rows = await query("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id", [
    email,
    await hashPassword(PASSWORD),
  ]);
  return String(rows[0]!.id);
}

/** The flag ON, the way the deploy sets it: the string "1". */
const ON: Env = { ...env, LOGIN_CHALLENGE: "1" };

/**
 * A stand-in for Cloudflare's `siteverify`: a token is valid ONCE (a replay
 * answers `timeout-or-duplicate`, as the real endpoint does), an unknown one is
 * `invalid-input-response`. `calls` records every token it was asked about, so
 * "siteverify was never called" is a count, not an inference.
 */
function stubSiteverify() {
  const valid = new Set<string>();
  const calls: string[] = [];
  const state = { down: false };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://challenges.cloudflare.com/")) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      const { response } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { response: string };
      calls.push(response);
      if (state.down) return Promise.reject(new TypeError("siteverify unreachable"));
      const ok = valid.delete(response);
      return Promise.resolve(
        new Response(JSON.stringify(ok ? { success: true } : { success: false, "error-codes": ["timeout-or-duplicate"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return {
    calls,
    /** A fresh, unused, valid token. */
    issue(): string {
      const token = `tok-${crypto.randomUUID()}`;
      valid.add(token);
      return token;
    },
    down(): void {
      state.down = true;
    },
  };
}

/**
 * `base` with a recording wrapper on every login limiter that exists, and on
 * `HYPERDRIVE_FRESH`. `limiterCalls` are `NAME|key` in call order.
 */
function observed(base: Env) {
  const limiterCalls: string[] = [];
  const reads = { n: 0 };
  const patched: Record<string, unknown> = { ...base };
  const loose = base as unknown as Record<string, RateLimit | undefined>;
  for (const name of ["LOGIN_IP_LIMITER", "LOGIN_LIMITER", "LOGIN_CHALLENGE_LIMITER", "LOGIN_CHALLENGE_IP_LIMITER"]) {
    const real = loose[name];
    if (real === undefined) continue;
    patched[name] = {
      limit: (options: RateLimitOptions) => {
        limiterCalls.push(`${name}|${options.key}`);
        return real.limit(options);
      },
    };
  }
  patched.HYPERDRIVE_FRESH = new Proxy(base.HYPERDRIVE_FRESH, {
    get(target, prop) {
      if (prop === "connectionString") reads.n += 1;
      return Reflect.get(target, prop, target) as unknown;
    },
  });
  return { env: patched as unknown as Env, limiterCalls, reads };
}

interface Attempt {
  email: string;
  password?: string;
  token?: string;
  ip?: string | null;
  env?: Env;
}

async function login(a: Attempt): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", Origin: ORIGIN };
  if (a.ip !== undefined && a.ip !== null) headers["CF-Connecting-IP"] = a.ip;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: a.email,
        password: a.password ?? "wrong-password-0000",
        ...(a.token === undefined ? {} : { turnstileToken: a.token }),
      }),
    }),
    a.env ?? ON,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { code?: string }).code;
}

/** `security:` lines logged so far, without the wall-clock `at`. */
function securityLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .filter((args) => typeof args[0] === "string" && args[0].startsWith("security:"))
    .map((args) => {
      const fields = { ...((args[1] ?? {}) as Record<string, unknown>) };
      delete fields.at;
      return `${String(args[0])} ${JSON.stringify(fields)}`;
    });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  setSecurityScopeOverridesForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (created.length > 0) {
    await query("DELETE FROM users WHERE email = ANY($1::citext[])", [created.splice(0)]);
  }
});

describe("LOGIN_CHALLENGE on: the soft threshold", () => {
  it("T1: attempts 1..3 answer 401 exactly as today, attempt 4 is CHALLENGE_REQUIRED (403)", async () => {
    const sv = stubSiteverify();
    const email = uniqueEmail();
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();

    for (let i = 1; i <= SOFT_LIMIT; i++) {
      const res = await login({ email, ip });
      expect(res.status, `attempt ${i} is inside the soft threshold`).toBe(401);
      expect(await codeOf(res)).toBe("INVALID_CREDENTIALS");
    }
    const challenged = await login({ email, ip });
    expect(challenged.status).toBe(403);
    expect(await challenged.json()).toEqual({ code: "CHALLENGE_REQUIRED" });
    expect(challenged.headers.getSetCookie()).toEqual([]);
    // Presence control for the absence in T9: a challenged attempt WITHOUT a token
    // never asks siteverify anything.
    expect(sv.calls).toEqual([]);
  }, 60_000);

  it("T1b: one IP trying fresh addresses is challenged on its 16th attempt (the ip soft key), not before", async () => {
    stubSiteverify();
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();

    for (let i = 1; i <= SOFT_IP_LIMIT; i++) {
      const res = await login({ email: uniqueEmail(), ip });
      expect(res.status, `attempt ${i} (a fresh address) is inside the ip soft threshold`).toBe(401);
    }
    const challenged = await login({ email: uniqueEmail(), ip });
    expect(challenged.status).toBe(403);
    expect(await codeOf(challenged)).toBe("CHALLENGE_REQUIRED");
  }, 60_000);

  it("T1c: an unknown IP skips the ip soft key and never pools into a shared bucket", async () => {
    stubSiteverify();
    const o = observed(ON);
    await awaitLimiterBurstWindow();
    // Asserted on the CALL SEQUENCE, not on a count that a pooled bucket would
    // only reach at some limit: no IP-keyed limiter is touched at all.
    for (let i = 1; i <= SOFT_LIMIT; i++) {
      const email = uniqueEmail();
      const before = o.limiterCalls.length;
      const res = await login({ email, ip: null, env: o.env });
      expect(res.status, `IP-less attempt ${i}`).toBe(401);
      expect(o.limiterCalls.slice(before)).toEqual([
        `LOGIN_LIMITER|unknown:${email}`,
        `LOGIN_LIMITER|email:${email}`,
        `LOGIN_CHALLENGE_LIMITER|unknown:${email}`,
        `LOGIN_CHALLENGE_LIMITER|email:${email}`,
      ]);
    }
    expect(o.limiterCalls.filter((c) => c.startsWith("LOGIN_IP_LIMITER") || c.startsWith("LOGIN_CHALLENGE_IP_LIMITER"))).toEqual([]);

    // Control: with an IP the same two ip limiters ARE called, so the filter above
    // is looking at something that exists.
    const before = o.limiterCalls.length;
    await login({ email: uniqueEmail(), ip: uniqueIp(), env: o.env });
    const withIp = o.limiterCalls.slice(before);
    expect(withIp.some((c) => c.startsWith("LOGIN_IP_LIMITER|ip:"))).toBe(true);
    expect(withIp.some((c) => c.startsWith("LOGIN_CHALLENGE_IP_LIMITER|ip:"))).toBe(true);
  }, 60_000);

  it("T7: one failed attempt is the exact 401 of main, one successful attempt the exact 200 of main", async () => {
    stubSiteverify();
    const email = uniqueEmail();
    const userId = await insertUser(email);
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();

    const failed = await login({ email, ip });
    expect(failed.status).toBe(401);
    expect(await failed.text()).toBe('{"code":"INVALID_CREDENTIALS"}');
    expect([...failed.headers]).toEqual([["content-type", "application/json"]]);

    const ok = await login({ email, ip, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId });
    expect(ok.headers.getSetCookie().some((c) => c.startsWith("tj_session="))).toBe(true);
  }, 60_000);
});

describe("LOGIN_CHALLENGE on: the token", () => {
  it("T2: a token is single-use: the second attempt with the same token is challenged again", async () => {
    const sv = stubSiteverify();
    const email = uniqueEmail();
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();
    for (let i = 0; i < SOFT_LIMIT; i++) await login({ email, ip });

    const token = sv.issue();
    const first = await login({ email, ip, token });
    expect(first.status, "a valid token lets the attempt through to the password check").toBe(401);
    expect(await codeOf(first)).toBe("INVALID_CREDENTIALS");

    const replay = await login({ email, ip, token });
    expect(replay.status).toBe(403);
    expect(await codeOf(replay)).toBe("CHALLENGE_REQUIRED");
    expect(sv.calls).toEqual([token, token]);
  }, 60_000);

  it("T3: a challenged attempt with a valid token and a WRONG password still spends all three hard caps and logs auth_failure invalid_credentials", async () => {
    const sv = stubSiteverify();
    const email = uniqueEmail();
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();
    for (let i = 0; i < SOFT_LIMIT; i++) await login({ email, ip });

    const o = observed(ON);
    const linesBefore = securityLines(warn).length;
    const res = await login({ email, ip, token: sv.issue(), env: o.env });

    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("INVALID_CREDENTIALS");
    // Order is part of the contract: hard caps first, in main's order, THEN soft.
    expect(o.limiterCalls.slice(0, 3)).toEqual([
      expect.stringMatching(/^LOGIN_IP_LIMITER\|ip:/),
      `LOGIN_LIMITER|${ip}:${email}`,
      `LOGIN_LIMITER|email:${email}`,
    ]);
    const soft = o.limiterCalls.slice(3);
    expect(soft).toHaveLength(3);
    expect(soft).toEqual(
      expect.arrayContaining([
        `LOGIN_CHALLENGE_LIMITER|${ip}:${email}`,
        `LOGIN_CHALLENGE_LIMITER|email:${email}`,
        expect.stringMatching(/^LOGIN_CHALLENGE_IP_LIMITER\|ip:/),
      ]),
    );
    expect(securityLines(warn).slice(linesBefore)).toEqual([
      `security: auth_failure /auth/login invalid_credentials ${JSON.stringify({
        kind: "auth_failure",
        route: "/auth/login",
        reason: "invalid_credentials",
        ip,
      })}`,
    ]);
  }, 60_000);

  it("T4: valid-token attempts up to the hard cap, then the next is a 429 that does not consume the token", async () => {
    const sv = stubSiteverify();
    const email = uniqueEmail();
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();

    for (let i = 1; i <= SOFT_LIMIT; i++) {
      expect((await login({ email, ip })).status).toBe(401);
    }
    for (let i = SOFT_LIMIT + 1; i <= HARD_EMAIL_LIMIT; i++) {
      const res = await login({ email, ip, token: sv.issue() });
      expect(res.status, `attempt ${i}: challenged, solved, then a wrong password`).toBe(401);
    }
    const solved = sv.calls.length;
    expect(solved).toBe(HARD_EMAIL_LIMIT - SOFT_LIMIT);

    const spare = sv.issue();
    const blocked = await login({ email, ip, token: spare });
    expect(blocked.status, "a solved challenge buys no extra attempt: the hard cap still refuses").toBe(429);
    expect(await codeOf(blocked)).toBe("RATE_LIMITED");
    expect(sv.calls.length, "a hard-capped request never reaches the token check").toBe(solved);
  }, 60_000);
});

describe("LOGIN_CHALLENGE on: no oracle, no lockout", () => {
  it("T5: an existing and a nonexistent address answer the same status+body sequence, challenged at the same index", async () => {
    const sv = stubSiteverify();
    const real = uniqueEmail();
    await insertUser(real);
    const ghost = uniqueEmail();
    await awaitLimiterBurstWindow();

    // Everything an outside observer or an operator can see: status+body, the
    // ORDER of every limiter call and the `security:` lines, with this address and
    // IP masked so the two runs are comparable.
    async function sequence(email: string, ip: string) {
      const o = observed(ON);
      const linesBefore = securityLines(warn).length;
      const out: string[] = [];
      for (let i = 1; i <= SOFT_LIMIT + 2; i++) {
        const token = i > SOFT_LIMIT + 1 ? sv.issue() : undefined;
        const res = await login({ email, ip, env: o.env, ...(token === undefined ? {} : { token }) });
        out.push(`${res.status} ${await res.text()}`);
      }
      const mask = (s: string) =>
        s.replaceAll(email, "<email>").replaceAll(ip, "<ip>").replace(/\|ip:\S+$/, "|ip:<ipkey>");
      return {
        out,
        calls: o.limiterCalls.map(mask),
        lines: securityLines(warn)
          .slice(linesBefore)
          .map((l) => l.replaceAll(ip, "<ip>")),
      };
    }
    const { out: a, calls: aCalls, lines: aLines } = await sequence(real, uniqueIp());
    const { out: b, calls: bCalls, lines: bLines } = await sequence(ghost, uniqueIp());

    expect(a).toEqual(b);
    expect(aCalls).toEqual(bCalls);
    expect(aLines).toEqual(bLines);
    // Not vacuous: all five attempts consumed limiters and logged.
    expect(aCalls.length).toBeGreaterThanOrEqual(5 * 6);
    expect(aLines.some((l) => l.includes("challenge_required"))).toBe(true);
    // Not vacuous: 401 x3, then the challenge (403), then a solved 5th attempt
    // that is back at the password check (401) on both kinds of address.
    expect(a.map((s) => s.slice(0, 3))).toEqual(["401", "401", "401", "403", "401"]);
    expect(a[3]).toContain("CHALLENGE_REQUIRED");
  }, 60_000);

  it("T8: a challenged attempt with no token, or an invalid one, never reaches the lookup (control: unchallenged attempts do)", async () => {
    const sv = stubSiteverify();
    const email = uniqueEmail();
    await insertUser(email);
    const ip = uniqueIp();
    const o = observed(ON);
    await awaitLimiterBurstWindow();

    for (let i = 0; i < SOFT_LIMIT; i++) {
      const before = o.reads.n;
      await login({ email, ip, env: o.env });
      expect(o.reads.n, `attempt ${i + 1} is below the threshold and does the lookup`).toBeGreaterThan(before);
    }

    const before = o.reads.n;
    // The CORRECT password: were it evaluated this would be a 200 and a session.
    const noToken = await login({ email, ip, password: PASSWORD, env: o.env });
    expect(noToken.status).toBe(403);
    expect(await codeOf(noToken)).toBe("CHALLENGE_REQUIRED");
    expect(noToken.headers.getSetCookie()).toEqual([]);

    const badToken = await login({ email, ip, password: PASSWORD, token: "never-issued", env: o.env });
    expect(badToken.status).toBe(403);
    expect(await codeOf(badToken)).toBe("CHALLENGE_REQUIRED");
    expect(badToken.headers.getSetCookie()).toEqual([]);

    expect(o.reads.n, "neither challenged attempt touched the database").toBe(before);
    expect(sv.calls).toEqual(["never-issued"]);
  }, 60_000);

  it("T10: a challenge rejection logs one auth_failure challenge_required and counts { email } only", async () => {
    stubSiteverify();
    const added: { event: unknown; counting: unknown }[] = [];
    setSecurityScopeOverridesForTests({
      buffer: {
        add: (event: unknown, _at: unknown, counting: unknown) => {
          added.push({ event, counting });
        },
      } as unknown as SecurityEventBuffer,
    });
    const email = uniqueEmail();
    await insertUser(email);
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();
    for (let i = 0; i < SOFT_LIMIT; i++) await login({ email, ip });
    // Control: the unchallenged failures above were counted (the buffer is live).
    expect(added.length).toBeGreaterThanOrEqual(SOFT_LIMIT);
    added.length = 0;
    const linesBefore = securityLines(warn).length;

    expect((await login({ email, ip, password: PASSWORD })).status).toBe(403);

    expect(added).toHaveLength(1);
    expect(added[0]!.event).toMatchObject({ kind: "auth_failure", route: "/auth/login", reason: "challenge_required", ip });
    // `{ email }` and nothing else: no userId, or the counter would hold an oracle.
    expect(added[0]!.counting).toEqual({ email });
    expect(securityLines(warn).slice(linesBefore)).toEqual([
      `security: auth_failure /auth/login challenge_required ${JSON.stringify({
        kind: "auth_failure",
        route: "/auth/login",
        reason: "challenge_required",
        ip,
      })}`,
    ]);
  }, 60_000);

  it("T11: strangers raising the challenge for a victim cost the victim one solve, never a refusal", async () => {
    const sv = stubSiteverify();
    const victim = uniqueEmail();
    const userId = await insertUser(victim);
    await awaitLimiterBurstWindow();

    // An attacker on three other addresses: three attempts, each its own ip:email
    // bucket, together past the victim's `email` soft threshold.
    for (let i = 0; i < SOFT_LIMIT; i++) {
      const res = await login({ email: victim, ip: uniqueIp() });
      expect(res.status).toBe(401);
    }

    const victimIp = uniqueIp();
    const asked = await login({ email: victim, ip: victimIp, password: PASSWORD });
    expect(asked.status).toBe(403);
    expect(await codeOf(asked)).toBe("CHALLENGE_REQUIRED");

    const solved = await login({ email: victim, ip: victimIp, password: PASSWORD, token: sv.issue() });
    expect(solved.status, "the challenge only adds a requirement; it never denies").toBe(200);
    expect(await solved.json()).toEqual({ userId });
    expect(solved.headers.getSetCookie().some((c) => c.startsWith("tj_session="))).toBe(true);
  }, 60_000);
});

describe("LOGIN_CHALLENGE on: siteverify unavailable", () => {
  it("T9: a throw on a challenged attempt is a 503 with no password evaluation; unchallenged logins never call siteverify", async () => {
    const sv = stubSiteverify();
    const email = uniqueEmail();
    await insertUser(email);
    const ip = uniqueIp();
    const o = observed(ON);
    await awaitLimiterBurstWindow();

    // Unchallenged, siteverify DOWN: login is entirely unaffected and never asks.
    sv.down();
    for (let i = 0; i < SOFT_LIMIT - 1; i++) {
      expect((await login({ email, ip, env: o.env })).status).toBe(401);
    }
    const ok = await login({ email, ip, password: PASSWORD, env: o.env });
    expect(ok.status, "the third attempt is still inside the threshold").toBe(200);
    expect(sv.calls, "no challenge, no siteverify call").toEqual([]);

    // The next attempt IS challenged. Control: the call count is 1 here.
    const readsBefore = o.reads.n;
    const linesBefore = securityLines(warn).length;
    const down = await login({ email, ip, password: PASSWORD, token: "any-token", env: o.env });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ code: "SERVICE_UNAVAILABLE" });
    expect(down.headers.getSetCookie()).toEqual([]);
    expect(sv.calls).toEqual(["any-token"]);
    expect(o.reads.n, "the password was not evaluated: no lookup").toBe(readsBefore);
    expect(securityLines(warn).slice(linesBefore)).toEqual([
      `security: alerting_fault /auth/login challenge_unavailable ${JSON.stringify({
        kind: "alerting_fault",
        route: "/auth/login",
        reason: "challenge_unavailable",
        ip,
      })}`,
    ]);
  }, 60_000);

  it("a token longer than siteverify's documented 2048 maximum is a 400 before any quota is spent", async () => {
    const sv = stubSiteverify();
    const o = observed(ON);
    const res = await login({ email: uniqueEmail(), ip: uniqueIp(), token: "x".repeat(2049), env: o.env });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "INVALID_INPUT", fields: ["turnstileToken"] });
    expect(o.limiterCalls).toEqual([]);
    expect(sv.calls).toEqual([]);
    // Control: 2048 exactly is accepted by the schema (falls through to a 401).
    expect((await login({ email: uniqueEmail(), ip: uniqueIp(), token: "x".repeat(2048) })).status).toBe(401);
  });
});

describe("LOGIN_CHALLENGE on: what the alerting counters see", () => {
  /** Counter rows sent per phase, through the REAL buffer and `classify`. */
  function counting() {
    const batches: { shard: string; signals: string[] }[] = [];
    setSecurityScopeOverridesForTests({
      buffer: new SecurityEventBuffer(() => Promise.resolve()),
      stubFor: (shard: string) => ({
        record: (batch: { rows: readonly { signal: string }[] }) => {
          batches.push({ shard, signals: batch.rows.map((r) => r.signal) });
          return Promise.resolve();
        },
      }),
    });
    return {
      signals: () => batches.flatMap((b) => b.signals),
      clear: () => {
        batches.length = 0;
      },
    };
  }

  it("a challenge rejection IS counted as a login failure; a Turnstile outage (challenge_unavailable) is NOT", async () => {
    const sv = stubSiteverify();
    const c = counting();
    const email = uniqueEmail();
    const ip = uniqueIp();
    await awaitLimiterBurstWindow();
    for (let i = 0; i < SOFT_LIMIT; i++) await login({ email, ip });
    c.clear();

    // 1. A rejected challenge feeds the per-IP and stuffing rules (the anti-blinding fix).
    expect((await login({ email, ip })).status).toBe(403);
    expect(c.signals()).toEqual(expect.arrayContaining(["login_ip_burst", "credential_stuffing", "login_failure_storm"]));
    c.clear();

    // 2. The same attempt during an outage writes its line and counts nothing:
    //    an outage must not be able to raise a stuffing alarm by itself.
    sv.down();
    const linesBefore = securityLines(warn).length;
    expect((await login({ email, ip, token: "any-token" })).status).toBe(503);
    expect(securityLines(warn).slice(linesBefore).join("\n")).toContain("challenge_unavailable");
    expect(c.signals()).toEqual([]);
  }, 60_000);
});

describe("LOGIN_CHALLENGE off", () => {
  // ⚠️ CHARACTERIZATION. The expected values below were taken from main BEFORE
  // the challenge was written (this test passed against it unchanged), so what it
  // pins is "byte-for-byte today's behaviour" and not the new code's own idea of it.
  const OFF: { name: string; env: Env }[] = [
    { name: "as shipped (\"0\")", env },
    { name: "unset", env: { ...env, LOGIN_CHALLENGE: undefined } as unknown as Env },
    { name: "\"true\"", env: { ...env, LOGIN_CHALLENGE: "true" } },
    { name: "\"on\"", env: { ...env, LOGIN_CHALLENGE: "on" } },
  ];

  for (const variant of OFF) {
    it(`T6: ${variant.name}: the T1 sequence is byte-identical to main, and the soft keys are not even consumed`, async () => {
      const sv = stubSiteverify();
      const email = uniqueEmail();
      const userId = await insertUser(email);
      const ip = uniqueIp();
      const o = observed(variant.env);
      await awaitLimiterBurstWindow();
      const linesBefore = securityLines(warn).length;

      const seen: { status: number; body: string; headers: [string, string][] }[] = [];
      // 1..6: far past the soft threshold, with a token supplied on two of them
      // (a web build that already forwards it, against an api with the flag off).
      for (let i = 1; i <= 6; i++) {
        const token = i >= 5 ? sv.issue() : undefined;
        const res = await login({ email, ip, env: o.env, ...(token === undefined ? {} : { token }) });
        seen.push({ status: res.status, body: await res.text(), headers: [...res.headers] });
      }
      const ok = await login({ email, ip, password: PASSWORD, env: o.env });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ userId });

      for (const [i, r] of seen.entries()) {
        expect(r, `attempt ${i + 1}`).toEqual({
          status: 401,
          body: '{"code":"INVALID_CREDENTIALS"}',
          headers: [["content-type", "application/json"]],
        });
      }
      const line = `security: auth_failure /auth/login invalid_credentials ${JSON.stringify({
        kind: "auth_failure",
        route: "/auth/login",
        reason: "invalid_credentials",
        ip,
      })}`;
      expect(securityLines(warn).slice(linesBefore)).toEqual([line, line, line, line, line, line]);

      // Exactly main's three keys per attempt, in main's order, and nothing else.
      const perAttempt = [
        expect.stringMatching(/^LOGIN_IP_LIMITER\|ip:/),
        `LOGIN_LIMITER|${ip}:${email}`,
        `LOGIN_LIMITER|email:${email}`,
      ];
      expect(o.limiterCalls).toEqual(Array.from({ length: 7 }, () => perAttempt).flat());
      expect(sv.calls, "siteverify is never asked while the flag is off").toEqual([]);
    }, 60_000);
  }
});

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_HELD_PAGE_SIZE,
  type AdminSecurityHeldResponse,
  type AdminSecurityRefResponse,
  type CounterReport,
  type SecurityAlertMessage,
} from "@thinkersjournal/shared";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { CANONICAL_ORIGIN } from "../src/auth/email-verify";
import { loadBarReason } from "../src/auth/account-status";
import { withClient } from "../src/db/client";
import { loadAccountHistory } from "../src/moderation/account-actions";

import { quiet } from "./helpers/security-do";

/**
 * The security admin routes (security-alerting spec §2.6 N6, R4, F2). The
 * Access JWT is minted the way test/admin-accounts-route.test.ts does it.
 */
const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const REF_REASON = "Security alert reference looked up by an administrator";
const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let adminEmail: string;
const createdUsers: string[] = [];

function newKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

/** An Access assertion; `signer` and `aud` vary only in the non-admin tests. */
async function makeJwt(signer: CryptoKey = keyPair.privateKey, aud: string = AUD): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [aud], sub: "admin-sub", email: adminEmail, exp: now + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

/** `jwt`: true = a valid admin assertion, false = no header, a string = that header. */
async function call(path: string, jwt: boolean | string = true, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const token = jwt === true ? await makeJwt() : jwt;
  const headers: Record<string, string> = typeof token === "string" ? { "Cf-Access-Jwt-Assertion": token } : {};
  const res = await worker.fetch(new Request(`https://api.test${path}`, { headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const ledger = () => env.SECURITY_LEDGER.getByName("ledger");

function accountCrossing(subject: string, events: number, now: number): CounterReport {
  return {
    signal: "targeted_account",
    signalClass: "account",
    subjectKind: "account",
    subject,
    windowStartMs: now - 3_600_000,
    windowEndMs: now,
    observed: 30,
    events,
    threshold: 30,
    severity: "critical",
    byRoute: { "/auth/login": events },
  };
}

/**
 * Report one account crossing to the real `ledger` instance (the one the routes
 * read) and read back the ref it minted. `armAt` is replaced first, so no REAL
 * alarm races the test (helpers/security-do.ts `quiet`).
 */
async function refFor(userId: string): Promise<string> {
  await runInDurableObject(ledger(), async (l) => {
    quiet(l);
    await l.reportAt({ reports: [accountCrossing(userId, 30, Date.now())], countedOverflow: {} }, Date.now());
  });
  return runInDurableObject(ledger(), (_l, s) =>
    s.storage.sql.exec<{ ref: string }>("SELECT ref FROM account_refs WHERE user_id = ?", userId).one().ref,
  );
}

type AuditRow = {
  actor_admin: string;
  subject_user_id: string | null;
  subject_label: string | null;
  internal_note: string | null;
  reason: string;
};

async function auditRows(ref: string): Promise<AuditRow[]> {
  return ctxRun(async (c) =>
    (
      await c.query<AuditRow>(
        `SELECT actor_admin, subject_user_id, subject_label, internal_note, reason FROM moderation_actions
          WHERE action = 'security_ref_resolved' AND internal_note = $1 ORDER BY created_at`,
        [ref],
      )
    ).rows,
  );
}

/** Every `security_ref_resolved` row whose any column names this user id. */
async function auditRowsNaming(userId: string): Promise<number> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM moderation_actions WHERE action = 'security_ref_resolved'
          AND (subject_user_id = $1 OR internal_note LIKE '%' || $2 || '%' OR subject_label LIKE '%' || $2 || '%'
               OR actor_admin LIKE '%' || $2 || '%')`,
      [userId, userId],
    );
    return rows[0]?.n ?? -1;
  });
}

/** Every page of one class's held list, through the route, as raw response text. */
async function walkHeld(signalClass: string): Promise<string> {
  const pages: string[] = [];
  let after = "";
  for (let page = 0; page < 200; page++) {
    const text = await (await call(`/admin/security/held?class=${signalClass}&after=${encodeURIComponent(after)}`)).text();
    pages.push(text);
    const next = (JSON.parse(text) as AdminSecurityHeldResponse).nextAfter;
    if (next === null) break;
    after = next;
  }
  return pages.join("\n");
}

async function newUser(withHandle = false): Promise<string> {
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [
      `ref_${crypto.randomUUID()}@example.test`,
    ]);
    const userId = rows[0]?.id ?? "";
    if (withHandle) {
      await c.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [userId, `sec${userId.replace(/-/g, "").slice(0, 16)}`]);
    }
    return userId;
  });
  createdUsers.push(id);
  return id;
}

beforeEach(async () => {
  adminEmail = `mod-${crypto.randomUUID()}@example.test`;
  keyPair = await newKeyPair();
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), { status: 200 })),
    ),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await ctxRun((c) => c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUsers.splice(0)]));
});

describe("GET /admin/security/account-ref/:ref (N6, R4)", () => {
  it("two alerts about one account carry the same ref; each resolution writes ONE audit row: the ref and the admin, never the user", async () => {
    const userId = await newUser(true);
    const ref = await refFor(userId);
    expect(await refFor(userId)).toBe(ref);
    const res = await call(`/admin/security/account-ref/${ref}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminSecurityRefResponse;
    expect(body.userId).toBe(userId);
    expect(body.handle).toMatch(/^sec[0-9a-f]{16}$/);
    const row: AuditRow = { actor_admin: adminEmail, subject_user_id: null, subject_label: null, internal_note: ref, reason: REF_REASON };
    expect(await auditRows(ref)).toEqual([row]);
    expect((await call(`/admin/security/account-ref/${ref}`)).status).toBe(200);
    expect(await auditRows(ref)).toEqual([row, row]);
    expect(await auditRowsNaming(userId)).toBe(0);
  });

  it("an unknown ref and a ref unused for 7 days give the SAME 404 and write nothing", async () => {
    const unknown = await call(`/admin/security/account-ref/${"f".repeat(32)}`);
    const userId = await newUser();
    const ref = await refFor(userId);
    await runInDurableObject(ledger(), (_l, s) =>
      s.storage.sql.exec("UPDATE account_refs SET last_used_ms = ? WHERE ref = ?", Date.now() - 8 * 86_400_000, ref),
    );
    const expired = await call(`/admin/security/account-ref/${ref}`);
    expect([unknown.status, expired.status]).toEqual([404, 404]);
    expect(await expired.text()).toBe(await unknown.text());
    expect(await auditRows(ref)).toEqual([]);
    expect(await auditRows("f".repeat(32))).toEqual([]);
  });

  it("an account with no profile resolves with a null handle", async () => {
    const userId = await newUser();
    const ref = await refFor(userId);
    const body = (await (await call(`/admin/security/account-ref/${ref}`)).json()) as AdminSecurityRefResponse;
    expect(body).toEqual({ userId, handle: null });
  });

});

describe("R3/R4: the audit row stays out of the account's member-scoped moderation record", () => {
  it("R3/R4: the member-scoped reads of the account's moderation record never return the audit row", async () => {
    const userId = await newUser();
    const ref = await refFor(userId);
    expect((await call(`/admin/security/account-ref/${ref}`)).status).toBe(200);
    // Positive control: a real ban row for the same account IS returned by both reads.
    await ctxRun((c) =>
      c.query(
        "INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason) VALUES ('a@example.test', 'user_ban', $1, 'control')",
        [userId],
      ),
    );
    const [history, reason] = await ctxRun(async (c) => [
      await loadAccountHistory(c, userId),
      await loadBarReason(c, userId, { suspended_until: null, disabled_at: new Date(), disabled_reason: "ban" }),
    ] as const);
    expect(reason).toBe("control");
    expect(history.map((h) => h.action)).toEqual(["user_ban"]);
    expect(JSON.stringify(history)).not.toContain(ref);
  });
});

describe("the security admin routes refuse a non-admin (requireAdmin: one 401 for every failure)", () => {
  const paths = (ref: string) => [`/admin/security/account-ref/${ref}`, "/admin/security/held?class=account"];

  it("no Access identity, a forged assertion, or a wrong audience → 401 ADMIN_REQUIRED, and a ref is neither resolved nor audited", async () => {
    const userId = await newUser(true);
    const ref = await refFor(userId);
    const forged = await makeJwt((await newKeyPair()).privateKey);
    const wrongAud = await makeJwt(keyPair.privateKey, "some-other-app");
    for (const jwt of [false, "", "not.a.jwt", forged, wrongAud] as const) {
      for (const path of paths(ref)) {
        const res = await call(path, jwt);
        expect(res.status, `${path} with ${String(jwt).slice(0, 12)}`).toBe(401);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ code: "ADMIN_REQUIRED" });
        expect(text).not.toContain(userId);
      }
    }
    expect(await auditRows(ref)).toEqual([]);
    // Positive control: the same ref, with a valid assertion, resolves and is audited.
    expect((await call(paths(ref)[0] ?? "")).status).toBe(200);
    expect(await auditRows(ref)).toHaveLength(1);
  });

  it("a malformed ref is the same 404 as an unknown one, and never reaches the ledger", async () => {
    const throwing = {
      ...env,
      SECURITY_LEDGER: {
        getByName: () => {
          throw new Error("a malformed ref must not reach the ledger");
        },
      },
    } as unknown as Env;
    const unknown = await (await call(`/admin/security/account-ref/${"f".repeat(32)}`)).text();
    for (const bad of ["F".repeat(32), "0".repeat(31), "0".repeat(33), "..%2F..%2Fadmin"]) {
      const res = await call(`/admin/security/account-ref/${bad}`, true, throwing);
      expect([bad, res.status]).toEqual([bad, 404]);
      expect(await res.text()).toBe(unknown);
    }
  });
});

describe("GET /admin/security/held (F2)", () => {
  it("the full walk lists every remaining row exactly once, though rows change between pages", async () => {
    const keys = await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("DELETE FROM held WHERE signal_class = 'ip_burst'");
      for (let i = 0; i < ADMIN_HELD_PAGE_SIZE + 50; i++) {
        const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
        s.storage.sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('ip_burst', ?, 'login_ip_burst', 'ip', ?, ?, 1, ?, ?)`,
          `login_ip_burst|${ip}`,
          ip,
          i,
          i + 1,
          Date.now(),
        );
      }
      return s.storage.sql
        .exec<{ k: string }>("SELECT subject_key AS k FROM held WHERE signal_class = 'ip_burst'")
        .toArray()
        .map((r) => r.k);
    });
    const page1 = (await (await call("/admin/security/held?class=ip_burst&after=")).json()) as AdminSecurityHeldResponse;
    expect(page1.rows).toHaveLength(ADMIN_HELD_PAGE_SIZE);
    const deleted = keys.find((k) => !page1.rows.some((r) => r.subjectKey === k)) ?? "";
    await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("UPDATE held SET events = 1000000 WHERE subject_key = ?", page1.rows[3]?.subjectKey ?? "");
      s.storage.sql.exec("DELETE FROM held WHERE subject_key = ?", deleted);
    });
    const after = encodeURIComponent(page1.nextAfter ?? "");
    const page2 = (await (await call(`/admin/security/held?class=ip_burst&after=${after}`)).json()) as AdminSecurityHeldResponse;
    const listed = [...page1.rows, ...page2.rows].map((r) => r.subjectKey);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(keys.filter((k) => k !== deleted).sort());
    expect(page2.nextAfter).toBeNull();
  });

  it("a summary class, an unknown class or an over-long cursor is a 400; the response orders classes as HELD_PRIORITY does", async () => {
    for (const q of ["class=storm", "class=purge", "class=nope", `class=account&after=${"a".repeat(513)}`]) {
      expect([q, (await call(`/admin/security/held?${q}`)).status]).toEqual([q, 400]);
    }
    const ok = (await (await call("/admin/security/held?class=account")).json()) as AdminSecurityHeldResponse;
    expect(ok.classOrder).toEqual(["account", "stuffing", "ip_burst", "infra"]);
  });

});

describe("GET /admin/security/held: an account cursor whose ref is gone", () => {
  it("is a 400 INVALID_INPUT (never a raw-string comparison); with the ref intact the same request is a 200", async () => {
    await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("DELETE FROM held WHERE signal_class = 'account'");
      for (let i = 0; i < ADMIN_HELD_PAGE_SIZE + 5; i++) {
        const id = crypto.randomUUID();
        s.storage.sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('account', ?, 'targeted_account', 'account', ?, 31, 0, 1, ?)`,
          `targeted_account|${id}`,
          id,
          Date.now(),
        );
      }
    });
    const page1 = (await (await call("/admin/security/held?class=account&after=")).json()) as AdminSecurityHeldResponse;
    const cursor = encodeURIComponent(page1.nextAfter ?? "");
    expect(page1.nextAfter).toMatch(/^targeted_account\|[0-9a-f]{32}$/);
    const intact = await call(`/admin/security/held?class=account&after=${cursor}`);
    expect(intact.status).toBe(200);
    const ref = (page1.nextAfter ?? "").split("|")[1] ?? "";
    await runInDurableObject(ledger(), (_l, s) => s.storage.sql.exec("DELETE FROM account_refs WHERE ref = ?", ref));
    const gone = await call(`/admin/security/held?class=account&after=${cursor}`);
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({ code: "INVALID_INPUT", fields: ["after"] });
  });
});

describe("GET /admin/security/held: account rows (P-12)", () => {
  it("account rows are listed by ref, never by user id; an existing ref is not refreshed, an unnamed row gets one minted", async () => {
    const named = await newUser();
    const unnamed = await newUser();
    const ref = await refFor(named);
    const old = Date.now() - 86_400_000;
    await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("UPDATE account_refs SET last_used_ms = ? WHERE ref = ?", old, ref);
      for (const id of [named, unnamed]) {
        s.storage.sql.exec(
          `INSERT OR REPLACE INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('account', ?, 'targeted_account', 'account', ?, 31, 0, 1, ?)`,
          `targeted_account|${id}`,
          id,
          Date.now(),
        );
      }
    });
    const all = await walkHeld("account");
    const refs = await runInDurableObject(ledger(), (_l, s) =>
      s.storage.sql
        .exec<{ user_id: string; ref: string; t: number }>(
          "SELECT user_id, ref, last_used_ms AS t FROM account_refs WHERE user_id IN (?, ?)",
          named,
          unnamed,
        )
        .toArray(),
    );
    const minted = refs.find((r) => r.user_id === unnamed)?.ref ?? "missing";
    expect(refs.find((r) => r.user_id === named)).toEqual({ user_id: named, ref, t: old });
    expect(minted).toMatch(/^[0-9a-f]{32}$/);
    expect(all).toContain(ref);
    expect(all).toContain(minted);
    for (const id of [named, unnamed]) expect(all).not.toContain(id);
  });
});

describe("GET /admin/security/held: a held account whose ref has gone stale (PM ruling a)", () => {
  it("is listed with a freshly minted ref that the lookup route resolves (200); the stale ref no longer resolves", async () => {
    const userId = await newUser();
    const stale = await refFor(userId);
    const old = Date.now() - 8 * 86_400_000;
    await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("UPDATE account_refs SET last_used_ms = ? WHERE ref = ?", old, stale);
      s.storage.sql.exec(
        `INSERT OR REPLACE INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
         VALUES ('account', ?, 'targeted_account', 'account', ?, 31, 0, 1, ?)`,
        `targeted_account|${userId}`,
        userId,
        Date.now(),
      );
    });
    // Precondition: the stale ref really is dead for the lookup route.
    expect((await call(`/admin/security/account-ref/${stale}`)).status).toBe(404);
    const listed = await walkHeld("account");
    expect(listed).not.toContain(stale);
    const fresh = await runInDurableObject(ledger(), (_l, s) =>
      s.storage.sql.exec<{ ref: string }>("SELECT ref FROM account_refs WHERE user_id = ?", userId).one().ref,
    );
    expect(fresh).not.toBe(stale);
    expect(listed).toContain(fresh);
    // The pasteable ref works (control: the fresh-ref test above resolves a ref the same way).
    expect((await call(`/admin/security/account-ref/${fresh}`)).status).toBe(200);
    expect((await call(`/admin/security/account-ref/${stale}`)).status).toBe(404);
  });
});

describe("1,000 decoy accounts (spec §5 R1/F3; PM ruling I-7)", () => {
  it("the real target is not lost: the byte-capped report counts it, links the admin page, and the admin full list names it", { timeout: 120_000 }, async () => {
    const stub = env.SECURITY_LEDGER.getByName(`decoys-${crypto.randomUUID()}`);
    const target = await newUser();
    const sent: SecurityAlertMessage[] = [];
    await runInDurableObject(stub, async (l) => {
      quiet(l);
      l.siteFor = () => ({ summarise: () => Promise.resolve({ activity: {}, overflowEvents: 0 }) });
      l.sinkFactory = () => ({ name: "capture", send: (m) => (sent.push(m), Promise.resolve({ delivered: true })) });
      const now = Date.now();
      const spend = Array.from({ length: 12 }, (_, i) => accountCrossing(`spend-${String(i)}`, 30, now));
      await l.reportAt({ reports: spend, countedOverflow: {} }, now); // the account budget, spent
      for (let i = 0; i < 1_000; i += 250) {
        const decoys = Array.from({ length: 250 }, (_, j) => accountCrossing(`decoy-${String(i + j)}`, 1_000, now));
        await l.reportAt({ reports: decoys, countedOverflow: {} }, now + 1);
      }
      await l.reportAt({ reports: [accountCrossing(target, 31, now)], countedOverflow: {} }, now + 2);
      await l.alarmAt(now + 3); // builds the held report
      await l.alarmAt(now + 4); // delivers it
    });
    const report = sent.find((m): m is Extract<SecurityAlertMessage, { type: "held_report" }> => m.type === "held_report");
    expect(JSON.stringify(report?.entries).length).toBeLessThanOrEqual(64 * 1024);
    expect(report?.more.find((m) => m.signalClass === "account")?.count).toBeGreaterThan(0);
    // I-11: the link ships with its page.
    expect(report?.adminUrl).toBe(`${CANONICAL_ORIGIN}/admin/security`);
    // Delivery deletes the rows the report NAMED (applyCoverage); the admin list pages every row still
    // stored, so the report's entries plus the list account for all 1,001 and the target is on the list.
    const named: string[] = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const res = await runInDurableObject(stub, (l) => l.listHeld("account", after));
      if (res === null) throw new Error("the cursor from the previous page must resolve");
      for (const r of res.rows) if (r.subject.kind === "account") named.push(r.subject.ref);
      if (res.nextAfter === null) break;
      after = res.nextAfter;
    }
    const ref = await runInDurableObject(stub, (_l, s) =>
      s.storage.sql.exec<{ ref: string }>("SELECT ref FROM account_refs WHERE user_id = ?", target).one().ref,
    );
    expect(named).toContain(ref);
    const more = report?.more.find((m) => m.signalClass === "account")?.count ?? -1;
    expect(named.length).toBe(more);
    expect(report?.entries.length).toBe(1_000 + 1 - more);
  });
});

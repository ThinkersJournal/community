import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { DEVICE_TTL_MS } from "@thinkersjournal/shared";

import { afterSignIn } from "../src/security/account-notices-flow";

import {
  DAY,
  DEAD_DB,
  DEV_COOKIE,
  deviceCount,
  dropRecorder,
  flow,
  HOUR,
  login,
  mails,
  newUser,
  ON,
  pendingNotice,
  pendingRows,
  postmarkCalls,
  quietAlarm,
  quietClaim,
  setPostmarkStatus,
  tokenOf,
  uniqueIp,
  useNoticeTestHooks,
} from "./helpers/account-notices";
import { guardAlertingFaults } from "./helpers/security-do";

/**
 * Account-holder notices (security-alerting spec §4): the login, signup and reset flows, through the routes (§4.1, §4.4). Pool project;
 * fixtures, the Postmark stub and the clean-up are in helpers/account-notices.ts.
 */
const { allowFaults } = guardAlertingFaults();
useNoticeTestHooks();
describe("the routes: cookies and when the flow runs (§4.1; plan Task 19)", () => {
  it("a login without a device cookie gets one AFTER the session cookie; with a well-formed one, no second Set-Cookie", async () => {
    const { email } = await newUser();
    const first = await login(email, null);
    expect(first.res.status).toBe(200);
    const cookies = first.res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.at(1)?.startsWith(DEV_COOKIE)).toBe(true);
    const again = await login(email, first.token);
    expect(again.res.headers.getSetCookie()).toHaveLength(1);
  });

  it("a FAILED login records nothing, mints no device cookie and mails nothing (control: the same browser's success does)", async () => {
    const { email, id } = await newUser();
    const failed = await login(email, null, ON, uniqueIp(), "not-the-password");
    expect(failed.res.status).toBe(401);
    expect(failed.res.headers.getSetCookie().filter((c) => c.startsWith(DEV_COOKIE))).toEqual([]);
    expect(await deviceCount(id)).toBe(0);
    expect(mails).toHaveLength(0);
    await login(email, null);
    expect(await deviceCount(id)).toBe(1);
  });
});

describe("when notices fire (§4.1; plan Task 19)", () => {
  it("signup is silent, and records its browser", async () => {
    const { id } = await newUser();
    await flow((ctx) => afterSignIn(ON, ctx, "signup", { userId: id, token: tokenOf("S"), country: null, nowMs: Date.now() }));
    expect(mails).toHaveLength(0);
    expect(await deviceCount(id)).toBe(1);
  });

  it("rollout: an empty list → the first login mails, with the 'no browser on record' sentence", async () => {
    const { email } = await newUser();
    const first = await login(email, null);
    expect(first.res.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails.at(0)?.text).toContain("had no browser on record");
    expect(mails.at(0)?.text).toContain("Germany");
    expect(mails.at(0)?.text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("a new browser mails once, without that sentence; the known one does not (control)", async () => {
    const { email } = await newUser();
    const a = await login(email, null);
    mails.length = 0;
    await login(email, a.token);
    expect(mails).toHaveLength(0);
    await login(email, null);
    expect(mails).toHaveLength(1);
    expect(mails.at(0)?.text).not.toContain("had no browser on record");
  });

  it("expiry: a browser last seen 401 days ago is pruned by the alarm, and its next login mails", async () => {
    const { email, id } = await newUser();
    const a = await login(email, null);
    await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, state) => {
      state.storage.sql.exec("UPDATE known_devices SET last_seen = ?", Date.now() - DEVICE_TTL_MS - DAY);
    });
    await quietAlarm(id, Date.now());
    mails.length = 0;
    await login(email, a.token);
    expect(mails).toHaveLength(1);
  });
});

describe("caps through the flow (§4.4; plan Task 19)", () => {
  it("cap: after one known login, four new browsers in an hour → two more mails; the rest are deferred, and say 'also covers'", async () => {
    const { email, id } = await newUser();
    await login(email, null);
    mails.length = 0;
    for (let i = 0; i < 4; i++) await login(email, null);
    expect(mails).toHaveLength(2); // the first login's own mail used one of the three slots
    const pending = await pendingNotice(id);
    expect(pending.map((p) => p.count)).toEqual([2]);
    await quietAlarm(id, pending.at(0)?.due_ms ?? 0);
    expect(mails.at(-1)?.text).toContain("also covers 1 other new sign-in since");
  });

  it("flag off: no Postmark call, one would_send line, the browser recorded, and the cap not consumed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { email, id } = await newUser();
    await login(email, null, env);
    expect(postmarkCalls()).toBe(0);
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: would_send new_sign_in")).toHaveLength(1);
    expect(await deviceCount(id)).toBe(1);
    const sent = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notices").one().n,
    );
    expect(sent).toBe(0);
  });

  it("CR-1: the address lookup THROWS on an immediate send → the notice and its folded sign-in stay, retrying", async () => {
    allowFaults("account-notice notice_send_threw");
    const { id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now - 60_000, now + HOUR); // an earlier sign-in, deferred
    await flow((ctx) => afterSignIn(DEAD_DB, ctx, "login", { userId: id, token: tokenOf("Z"), country: null, nowMs: now }));
    expect(mails).toHaveLength(0);
    const rows = await pendingRows(id);
    expect(rows.map((r) => [r.count, r.attempts])).toEqual([[2, 1]]); // the folded sign-in AND this one, retrying
    const claimed = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n,
    );
    expect(claimed).toBe(0);
  });

});

// Split from the describe above only to keep each callback under 50 lines (Codacy).

// Split from the describe above only to keep each callback under 50 lines (Codacy).
describe("an immediate send's end state (§4.4 G1; plan Task 19)", () => {
  it("a permanent refusal on an immediate send → dropped_permanent_refusal logged ONCE and reported to the ledger once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    setPostmarkStatus({ status: 422, body: { ErrorCode: 406 } });
    const dropped: string[] = [];
    const recorded = { ...ON, SECURITY_LEDGER: { getByName: dropRecorder(dropped) } } as unknown as Env;
    await flow((ctx) => afterSignIn(recorded, ctx, "login", { userId: id, token: tokenOf("P"), country: null, nowMs: Date.now() }));
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: dropped dropped_permanent_refusal new_sign_in")).toHaveLength(1);
    expect(dropped).toEqual(["dropped_permanent_refusal"]);
    expect(await pendingRows(id)).toEqual([]);
  });
});

describe("takeover under saturation (F1; plan Task 19)", () => {
  it("50 other accounts' sign-ins never change when or whether the victim is told", { timeout: 180_000 }, async () => {
    const victim = await newUser();
    for (let i = 0; i < 3; i++) await login(victim.email, null); // the victim's own cap: 3 in the hour
    const attackers = await Promise.all(Array.from({ length: 50 }, () => newUser()));
    mails.length = 0;
    await login(victim.email, null, ON, "198.51.100.200"); // the takeover sign-in, over the cap → deferred
    await login(victim.email, null, ON, "198.51.100.201");
    const before = await pendingNotice(victim.id);
    expect(before.map((p) => p.count)).toEqual([2]);
    for (const [i, a] of attackers.entries()) await login(a.email, null, ON, `192.0.2.${String(i)}`);
    expect(await pendingNotice(victim.id)).toEqual(before); // no other account's traffic moved it
    expect(mails.filter((m) => m.to === victim.email)).toHaveLength(0);
    await quietAlarm(victim.id, before.at(0)?.due_ms ?? 0);
    const told = mails.filter((m) => m.to === victim.email);
    expect(told).toHaveLength(1);
    expect(told.at(0)?.text).toContain("also covers 1 other new sign-in since");
  });
});

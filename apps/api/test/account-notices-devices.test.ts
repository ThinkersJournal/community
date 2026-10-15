import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { DEVICE_TTL_MS, WAVE_SPREAD_MS, deviceHash, keyId } from "@thinkersjournal/shared";

import { afterPasswordReset, afterSignIn } from "../src/security/account-notices-flow";
import { DEVICE_LIST_CAP } from "../src/security/user-devices";
import { deviceCookieOnly } from "../../web/src/lib/device-cookie-forward";

import {
  DAY,
  DEV_COOKIE,
  deviceCount,
  flow,
  HOUR,
  login,
  loginWithCookie,
  mails,
  newUser,
  ON,
  pendingNotice,
  pendingRows,
  quietAlarm,
  quietClaim,
  quietOn,
  quietRecord,
  tokenOf,
  tokenWithOrder,
  useNoticeTestHooks,
} from "./helpers/account-notices";
import { guardAlertingFaults } from "./helpers/security-do";

/**
 * Account-holder notices (security-alerting spec §4): the device list, its keys and its clearing (§4.1, N5). Pool project;
 * fixtures, the Postmark stub and the clean-up are in helpers/account-notices.ts.
 */
guardAlertingFaults();
useNoticeTestHooks();
describe("the device list (§4.1; plan Task 17)", () => {
  it("login: an unknown browser is new, the same browser again is known; the first finds an empty list", async () => {
    const { id } = await newUser();
    const now = Date.now();
    expect(await quietRecord(id, tokenOf("A"), "login", now)).toEqual({ knownDevice: false, listWasEmpty: true, unknownKeysOnly: false });
    expect(await quietRecord(id, tokenOf("A"), "login", now + 1)).toEqual({ knownDevice: true, listWasEmpty: false, unknownKeysOnly: false });
    expect(await quietRecord(id, tokenOf("B"), "login", now + 2)).toEqual({ knownDevice: false, listWasEmpty: false, unknownKeysOnly: false });
    expect(await deviceCount(id)).toBe(2);
  });

  it("signup and reset clear every other browser and record this one; login does not (control)", async () => {
    for (const mode of ["signup", "reset", "login"] as const) {
      const { id } = await newUser();
      const now = Date.now();
      await quietRecord(id, tokenOf("A"), "login", now);
      await quietRecord(id, tokenOf("B"), "login", now + 1);
      await quietRecord(id, tokenOf("C"), mode, now + 2);
      expect(await deviceCount(id), mode).toBe(mode === "login" ? 3 : 1);
    }
  });

  it("rotation: a _PREV match is known and rewritten to the current key; a key replaced without _PREV is unknownKeysOnly", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietRecord(id, tokenOf("A"), "login", now, { current: "K1", prev: null });
    const rotated = await quietRecord(id, tokenOf("A"), "login", now + 1, { current: "K2", prev: "K1" });
    expect(rotated.knownDevice).toBe(true);
    expect(await deviceCount(id)).toBe(1);
    expect(await quietRecord(id, tokenOf("A"), "login", now + 2, { current: "K2", prev: null })).toMatchObject({ knownDevice: true });
    const replaced = await quietRecord(id, tokenOf("A"), "login", now + 3, { current: "K3", prev: null });
    expect(replaced).toEqual({ knownDevice: false, listWasEmpty: false, unknownKeysOnly: true });
  });
});

describe("the device list: its cap, expiry and forgetDevices (§4.1)", () => {
  it(`at most ${String(DEVICE_LIST_CAP)} browsers: the least recently seen is evicted`, async () => {
    const { id } = await newUser();
    const now = Date.now();
    for (let i = 0; i <= DEVICE_LIST_CAP; i++) await quietRecord(id, tokenOf(String.fromCharCode(65 + i)), "login", now + i);
    expect(await deviceCount(id)).toBe(DEVICE_LIST_CAP);
    expect((await quietRecord(id, tokenOf("A"), "login", now + 100)).knownDevice).toBe(false); // the oldest went
  });

  it("expiry: the alarm prunes a browser unseen for 400 days, and keeps a fresher one (control)", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietRecord(id, tokenOf("A"), "login", now - DEVICE_TTL_MS - DAY);
    await quietRecord(id, tokenOf("B"), "login", now - DEVICE_TTL_MS + DAY);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quietOn(u);
      await u.alarmAt(now);
    });
    expect(await deviceCount(id)).toBe(1);
    expect((await quietRecord(id, tokenOf("A"), "login", now + 1)).knownDevice).toBe(false);
  });

  it("forgetDevices clears the list only: the epoch and a pending notice stay", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietRecord(id, tokenOf("A"), "login", now);
    await quietClaim(id, now, now + 3_600_000);
    const epoch = await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quietOn(u);
      const e = await u.bumpEpoch();
      await u.forgetDevices();
      return e;
    });
    expect(await deviceCount(id)).toBe(0);
    expect((await pendingRows(id)).map((r) => r.count)).toEqual([1]);
    expect(await env.USER_SECURITY.getByName(id).getEpoch()).toBe(epoch);
  });
});

describe("key rotation: one browser with entries under BOTH keys (review I-1)", () => {
  it.each([true, false])("prev-key entry sorts first = %s: no throw, one entry under the current key, the earliest first-seen kept", async (prevFirst) => {
    const { id } = await newUser();
    const now = Date.now();
    const token = await tokenWithOrder(id, prevFirst);
    await quietRecord(id, token, "login", now, { current: "K1", prev: null });
    await quietRecord(id, token, "login", now + 1, { current: "K2", prev: null }); // replaced WITHOUT _PREV: a second entry
    expect(await deviceCount(id)).toBe(2);
    const r = await quietRecord(id, token, "login", now + 2, { current: "K2", prev: "K1" }); // _PREV set belatedly
    expect(r.knownDevice).toBe(true);
    const rows = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec("SELECT device_hash, kid, first_seen, last_seen FROM known_devices").toArray(),
    );
    expect(rows).toEqual([{ device_hash: await deviceHash("K2", id, token), kid: await keyId("K2"), first_seen: now, last_seen: now + 2 }]);
  });
});

describe("signup and reset clear the list (§4.1; plan Task 19)", () => {
  it("re-signup clears: claimant A's browser is gone after B's signup, so A's cookie mails", async () => {
    const { email, id } = await newUser();
    await flow((ctx) => afterSignIn(ON, ctx, "signup", { userId: id, token: tokenOf("A"), country: null, nowMs: Date.now() }));
    await flow((ctx) => afterSignIn(ON, ctx, "signup", { userId: id, token: tokenOf("B"), country: null, nowMs: Date.now() }));
    await login(email, tokenOf("A"));
    expect(mails).toHaveLength(1);
  });

  it("a reset clears every browser but the resetting one; it mails 'password was changed'", async () => {
    const { email, id } = await newUser();
    await login(email, tokenOf("A"));
    await login(email, tokenOf("B"));
    mails.length = 0;
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: tokenOf("C"), country: null, nowMs: Date.now() }));
    expect(mails.map((m) => m.subject)).toEqual(["Your Thinkers Journal password was changed"]);
    expect(await deviceCount(id)).toBe(1);
    mails.length = 0;
    await login(email, tokenOf("A"));
    expect(mails).toHaveLength(1);
  });

  it("a barred reset (no token) forgets every browser and still mails", async () => {
    const { email, id } = await newUser();
    await login(email, tokenOf("A"));
    mails.length = 0;
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: null, country: null, nowMs: Date.now() }));
    expect(mails).toHaveLength(1);
    expect(await deviceCount(id)).toBe(0);
  });

  it("a barred reset (forgetDevices) leaves pending sign-in notices alone", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now, now + HOUR);
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: null, country: null, nowMs: now }));
    expect((await pendingRows(id)).map((r) => r.count)).toEqual([1]);
  });
});

describe("device keys through the flow (N5; plan Task 19)", () => {
  it("rotation with _PREV: no mail, the entry is rewritten to K2; after _PREV goes, still no mail", async () => {
    const { email, id } = await newUser();
    const k1: Env = { ...ON, DEVICE_HASH_KEY: "K1" };
    const both: Env = { ...ON, DEVICE_HASH_KEY: "K2", DEVICE_HASH_KEY_PREV: "K1" };
    const k2: Env = { ...ON, DEVICE_HASH_KEY: "K2" };
    const a = await login(email, null, k1);
    const stale = await login(email, null, k1); // a second browser that will sit the rotation out
    mails.length = 0;
    await login(email, a.token, both);
    expect(mails).toHaveLength(0);
    const kid2 = await keyId("K2");
    const underK2 = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices WHERE kid = ?", kid2).one().n,
    );
    expect(underK2).toBe(1);
    await login(email, a.token, k2);
    expect(mails).toHaveLength(0);
    await login(email, stale.token, k2); // control: unused during the rotation → mails
    expect(mails).toHaveLength(1);
  });

  it("no key: logins send nothing, record nothing and log NOTHING per login (I-3); a reset still mails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { email, id } = await newUser();
    const noKey: Env = { ...ON, DEVICE_HASH_KEY: "" };
    await login(email, null, noKey);
    await login(email, null, noKey);
    expect(mails).toHaveLength(0);
    expect(await deviceCount(id)).toBe(0);
    // The operator hears through the ledger's ONE config_fault a day (test/security-ledger-do.test.ts).
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("device_hash_key_missing"))).toEqual([]);
    await flow((ctx) => afterPasswordReset(noKey, ctx, { userId: id, token: tokenOf("R"), country: null, nowMs: Date.now() }));
    expect(mails).toHaveLength(1);
  });

});

// Split from the describe above only to keep each callback under 50 lines (Codacy).

// Split from the describe above only to keep each callback under 50 lines (Codacy).
describe("device keys through the flow: HMAC and the wave (N5, §4.4; plan Task 19)", () => {
  it("HMAC: one token under two user ids → two different stored hashes", async () => {
    expect(await deviceHash("K", "u1", tokenOf("T"))).not.toBe(await deviceHash("K", "u2", tokenOf("T")));
  });

  it("wave spread: a key replaced WITHOUT _PREV → unknownKeysOnly; pending inside 6 h; the alarm sends it", async () => {
    const { email, id } = await newUser();
    const a = await login(email, null, { ...ON, DEVICE_HASH_KEY: "OLD" });
    mails.length = 0;
    await login(email, a.token, { ...ON, DEVICE_HASH_KEY: "NEW" });
    expect(mails).toHaveLength(0);
    const due = (await pendingNotice(id)).at(0)?.due_ms ?? 0;
    expect(due - Date.now()).toBeLessThanOrEqual(WAVE_SPREAD_MS);
    await quietAlarm(id, due);
    expect(mails).toHaveLength(1);
  });
});

describe("the web Worker's forwarded device cookie (final review C-1)", () => {
  it("a second login carrying what web forwards from the browser's whole Cookie is a KNOWN browser: nothing mailed or queued", async () => {
    const { email, id } = await newUser();
    const first = await login(email, null);
    mails.length = 0;
    const browser = `tj_session_dev=stale; ${DEV_COOKIE}${first.token ?? ""}; theme=dark`;
    const forwarded = deviceCookieOnly(browser);
    expect(forwarded).toBe(`${DEV_COOKIE}${first.token ?? ""}`); // only the device pair
    const second = await loginWithCookie(email, forwarded);
    expect(second.status).toBe(200);
    expect(second.headers.getSetCookie()).toHaveLength(1); // no new device cookie
    expect(mails).toHaveLength(0);
    expect(await pendingRows(id)).toEqual([]);
    expect(await deviceCount(id)).toBe(1);
  });
});

describe("a reset without DEVICE_HASH_KEY (final review M-1)", () => {
  it("still clears every browser, so a browser recorded before is NEW once the same key is back", async () => {
    const { email, id } = await newUser();
    const before = await login(email, null); // recorded under the test key
    expect(await deviceCount(id)).toBe(1);
    const noKey: Env = { ...ON, DEVICE_HASH_KEY: "" };
    await flow((ctx) => afterPasswordReset(noKey, ctx, { userId: id, token: tokenOf("R"), country: null, nowMs: Date.now() }));
    expect(await deviceCount(id)).toBe(0);
    mails.length = 0;
    await login(email, before.token); // the SAME key restored, as the runbook says
    expect(mails).toHaveLength(1);
  });
});

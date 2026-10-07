import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_TTL_MS, NOTICE_MAX_AGE_MS, deviceHashes, type DeviceRecordMode } from "@thinkersjournal/shared";

import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import { sendNotice } from "../src/security/account-notice-send";
import { DEVICE_LIST_CAP } from "../src/security/user-devices";

import { guardAlertingFaults, quiet } from "./helpers/security-do";

/**
 * Account-holder notices (security-alerting spec §4). Pool
 * project. Postmark is intercepted the way test/forgot-password.test.ts does it
 * (`vi.stubGlobal("fetch")`); the stub reaches `UserSecurityDO` too, because the
 * pool runs the Durable Objects in the test's isolate.
 *
 * PR 2 batch A (plan Task 17) holds only the tests that drive `UserSecurityDO`
 * and `sendNotice` directly; the plan's Task 19 adds the login, signup and reset
 * flows on top of these.
 */
guardAlertingFaults();

const PASSWORD = "correct-horse-battery-staple";
const ON: Env = { ...env, ACCOUNT_NOTICES_ENABLED: "1" };
const DAY = 86_400_000;
const created: string[] = [];

interface Mail {
  to: string;
  subject: string;
  text: string;
}
let mails: Mail[] = [];
let postmarkStatus: { status: number; body: unknown } = { status: 200, body: { ErrorCode: 0 } };

beforeEach(() => {
  mails = [];
  postmarkStatus = { status: 200, body: { ErrorCode: 0 } };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.postmarkapp.com/")) throw new Error(`unexpected fetch to ${url}`);
      const b = JSON.parse(typeof init?.body === "string" ? init.body : "") as { To: string; Subject: string; TextBody: string };
      if (postmarkStatus.status === 200) mails.push({ to: b.To, subject: b.Subject, text: b.TextBody });
      return Promise.resolve(new Response(JSON.stringify(postmarkStatus.body), { status: postmarkStatus.status }));
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE email = ANY($1)", [created.splice(0)]));
  await waitOnExecutionContext(ctx);
});

async function newUser(): Promise<{ email: string; id: string }> {
  const email = `notice_${crypto.randomUUID()}@example.test`;
  created.push(email);
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, await hashPassword(PASSWORD)],
    );
    return rows.at(0)?.id ?? "";
  });
  await waitOnExecutionContext(ctx);
  return { email, id };
}

const tokenOf = (c: string) => c.padEnd(43, c).slice(0, 43);

/** A ledger stand-in that records each drop it is told about. */
function dropRecorder(dropped: string[]) {
  return () => ({
    noticeDropped: (state: string) => {
      dropped.push(state);
      return Promise.resolve();
    },
  });
}

/**
 * Claim inside the object with its alarm seam replaced (audit I-5): a claim made
 * through the production stub arms a REAL alarm for about now, which would race
 * the test's explicit clock.
 */
async function quietClaim(userId: string, atMs: number, notBeforeMs: number, country: string | null = null, listWasEmpty = false) {
  await runInDurableObject(env.USER_SECURITY.getByName(userId), async (u) => {
    quiet(u);
    await u.claimNotice("new_sign_in", { atMs, country, listWasEmpty }, atMs, notBeforeMs);
  });
}

/** Record `token`'s browser for `userId` under `keys`, inside the object with `armAt` replaced. */
async function quietRecord(userId: string, token: string, mode: DeviceRecordMode, nowMs: number, keys = { current: "K1", prev: null as string | null }) {
  const hashes = await deviceHashes(keys, userId, token);
  return runInDurableObject(env.USER_SECURITY.getByName(userId), async (u) => {
    quiet(u);
    return u.recordDevice(hashes, nowMs, mode);
  });
}

async function pendingRows(userId: string) {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, s) =>
    s.storage.sql.exec<{ count: number; due_ms: number; attempts: number }>("SELECT count, due_ms, attempts FROM pending_notice").toArray(),
  );
}

async function deviceCount(userId: string): Promise<number> {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices").one().n,
  );
}

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
      quiet(u);
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
      quiet(u);
      const e = await u.bumpEpoch();
      await u.forgetDevices();
      return e;
    });
    expect(await deviceCount(id)).toBe(0);
    expect((await pendingRows(id)).map((r) => r.count)).toEqual([1]);
    expect(await env.USER_SECURITY.getByName(id).getEpoch()).toBe(epoch);
  });
});

describe("caps and deferral (§4.4)", () => {
  it("cap: three send-now claims in the hour; the 4th is deferred until the oldest is an hour old", async () => {
    const { id } = await newUser();
    const t0 = Date.now();
    const sends: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quiet(u);
      for (let i = 0; i < 4; i++) {
        const claim = await u.claimNotice("new_sign_in", { atMs: t0 + i, country: null, listWasEmpty: false }, t0 + i, t0 + i);
        sends.push(claim.send);
      }
    });
    expect(sends).toEqual(["now", "now", "now", "deferred"]);
    expect((await pendingRows(id)).map((r) => r.due_ms)).toEqual([t0 + 3_600_000]);
  });

  it("a notBefore in the future defers even an under-cap notice (the wave's spread)", async () => {
    const { id } = await newUser();
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 2 * 3_600_000);
    expect(await pendingRows(id)).toEqual([{ count: 1, due_ms: t0 + 2 * 3_600_000, attempts: 0 }]);
  });
});

describe("end states: Postmark refusals (§4.4)", () => {
  it("ErrorCode 406 on a deferred notice → dropped_permanent_refusal at once, logged, one notice_dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const now = Date.now();
    await quietClaim(id, now, now + 60_000);
    postmarkStatus = { status: 422, body: { ErrorCode: 406 } };
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u, s) => {
      quiet(u);
      u.ledgerFor = dropRecorder(dropped);
      await u.alarmAt(now + 60_000);
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n).toBe(0);
    });
    expect(dropped).toEqual(["dropped_permanent_refusal"]);
    expect(warn.mock.calls.some((c) => c[0] === "account-notice: dropped dropped_permanent_refusal new_sign_in")).toBe(true);
  });

  it("transient refusals (HTTP 503) retry at 15, 30, 60 min … then drop as expired after 7 days", async () => {
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    postmarkStatus = { status: 503, body: {} };
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u, s) => {
      quiet(u);
      u.ledgerFor = dropRecorder(dropped);
      const delays: number[] = [];
      let at = t0 + 1;
      for (let i = 0; i < 3; i++) {
        await u.alarmAt(at);
        const next = s.storage.sql.exec<{ due_ms: number }>("SELECT due_ms FROM pending_notice").one().due_ms;
        delays.push((next - at) / 60_000);
        at = next;
      }
      expect(delays).toEqual([15, 30, 60]);
      await u.alarmAt(t0 + NOTICE_MAX_AGE_MS);
    });
    expect(dropped).toEqual(["dropped_expired"]);
  });
});

describe("end states: account gone, and a route's claim settled (§4.4; P-5)", () => {
  it("a pending notice for an account that is gone → dropped_account_gone, no Postmark call, no alert", async () => {
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const now = Date.now();
    await quietClaim(id, now, now + 1);
    await runInDurableObject(stub, async (u) => {
      quiet(u);
      await u.dropPendingNotices();
    });
    expect(mails).toHaveLength(0);
    expect(
      await runInDurableObject(stub, (_u, s) => s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n),
    ).toBe(0);
  });

  it("P-5/CR-1: a send-now claim settled 'transient' becomes the pending notice, folded, retrying after 15 min", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now - 60_000, now + 3_600_000); // an earlier sign-in, deferred
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quiet(u);
      const claim = await u.claimNotice("new_sign_in", { atMs: now, country: null, listWasEmpty: false }, now, now);
      expect(claim).toEqual({ send: "now", coalesced: { count: 1, sinceMs: now - 60_000 } });
      await u.settleClaim("new_sign_in", now, "transient", now + 1);
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(0);
    });
    expect(await pendingRows(id)).toEqual([{ count: 2, due_ms: now + 1 + 15 * 60_000, attempts: 1 }]);
  });

  it("P-5: a send-now claim settled 'sent' leaves nothing pending and nothing claimed", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quiet(u);
      await u.claimNotice("new_sign_in", { atMs: now, country: null, listWasEmpty: false }, now, now);
      await u.settleClaim("new_sign_in", now, "sent", now + 1);
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(0);
    });
    expect(await pendingRows(id)).toEqual([]);
  });
});

describe("claims cut off, and races across the send (R2-3, I-2)", () => {
  it("R2-3: a route cut off right after its send-now claim → the claim (and its fold) is still sent by the alarm", async () => {
    const { email, id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now - 60_000, now + 3_600_000); // an earlier sign-in, deferred
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quiet(u);
      const claim = await u.claimNotice("new_sign_in", { atMs: now, country: "DE", listWasEmpty: false }, now, now);
      expect(claim.send).toBe("now");
      // … and the route is cut off here: no send, no settleClaim.
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(1);
      await u.alarmAt(now + 14 * 60_000); // before its timeout: left alone
      expect(mails).toHaveLength(0);
      await u.alarmAt(now + 15 * 60_000); // past it: recovered and sent
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(0);
    });
    expect(mails.map((m) => m.to)).toEqual([email]);
    expect(mails.at(0)?.text).toContain("also covers 1 other new sign-in since");
  });

  it("I-2: a sign-in folded WHILE the alarm awaits Postmark is neither deleted (sent) nor overwritten (retry)", async () => {
    for (const outcome of ["sent", "transient"] as const) {
      const { id } = await newUser();
      const t0 = Date.now();
      await quietClaim(id, t0, t0 + 1);
      await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
        quiet(u);
        u.noticeSender = async () => {
          // The input gate is open during the real send's awaits: a new sign-in folds now.
          await u.claimNotice("new_sign_in", { atMs: t0 + 5, country: "FR", listWasEmpty: false }, t0 + 5, t0 + 3_600_000);
          return outcome;
        };
        await u.alarmAt(t0 + 1);
        const rows = s.storage.sql.exec<{ count: number; last_country: string | null }>("SELECT count, last_country FROM pending_notice").toArray();
        expect(rows.map((r) => r.count), outcome).toEqual([outcome === "sent" ? 1 : 2]);
        expect(rows.at(0)?.last_country, outcome).toBe("FR");
      });
    }
  });
});

describe("unknown owner, and what a deferred notice says (I-9, G2)", () => {
  it("I-9: an unknown owner is its own outcome — logged owner_unknown, kept retrying, never 'account gone'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quiet(u);
      s.storage.sql.exec("DELETE FROM owner");
      await u.alarmAt(t0 + 1);
      const rows = s.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM pending_notice").toArray();
      expect(rows.map((r) => r.attempts)).toEqual([1]);
    });
    expect(warn.mock.calls.some((c) => c[0] === "account-notice: owner_unknown new_sign_in")).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dropped_account_gone"))).toBe(false);
  });

  it("G2: a deferred notice reports its event's time and country, not the send time, and links CANONICAL_ORIGIN", async () => {
    const { id } = await newUser();
    const t = Date.parse("2026-10-07T03:04:05.000Z");
    await quietClaim(id, t, t + 2 * 3_600_000, null, true);
    await quietClaim(id, t + 60_000, t + 5 * 3_600_000, "DE", false); // the takeover, folded: due keeps the earlier time
    expect((await pendingRows(id)).map((r) => r.due_ms)).toEqual([t + 2 * 3_600_000]);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quiet(u);
      await u.alarmAt(t + 2 * 3_600_000);
    });
    const text = mails.at(0)?.text ?? "";
    expect(text).toContain(new Date(t + 60_000).toISOString()); // the LAST event's time
    expect(text).toContain("from Germany (approximate)"); // and its country
    expect(text).not.toContain(new Date(t + 2 * 3_600_000).toISOString()); // not the send time
    expect(text).toContain("also covers 1 other new sign-in since 2026-10-07T03:04:05.000Z");
    expect(text).toContain("had no browser on record"); // the folded empty-list event keeps the sentence
    expect(text).toContain("https://community.thinkersjournal.com/forgot-password");
  });
});

describe("sendNotice for an anonymised account (§4.5)", () => {
  it("anonymised: a direct send for an anonymised id mails nothing (control: the same call for a live id mails)", async () => {
    const live = await newUser();
    const gone = await newUser();
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [gone.id]));
    const facts = { kind: "new_sign_in" as const, atMs: Date.now(), country: null, coalesced: null, listWasEmpty: false };
    expect(await sendNotice(ON, ctx, live.id, facts)).toBe("sent");
    expect(await sendNotice(ON, ctx, gone.id, facts)).toBe("gone");
    await waitOnExecutionContext(ctx);
    expect(mails.map((m) => m.to)).toEqual([live.email]);
  });
});

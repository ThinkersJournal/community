import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEVICE_TTL_MS,
  NOTICE_MAX_AGE_MS,
  NOTICE_MAX_DELAY_MS,
  WAVE_SPREAD_MS,
  deviceHash,
  deviceHashes,
  keyId,
  type DeviceRecordMode,
} from "@thinkersjournal/shared";

import worker from "../src";
import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import { sendNotice } from "../src/security/account-notice-send";
import { afterPasswordReset, afterSignIn } from "../src/security/account-notices-flow";
import { DEVICE_LIST_CAP, type NoticeClaimResult } from "../src/security/user-devices";

import { guardAlertingFaults, quiet } from "./helpers/security-do";

/**
 * Account-holder notices (security-alerting spec §4). Pool
 * project. Postmark is intercepted the way test/forgot-password.test.ts does it
 * (`vi.stubGlobal("fetch")`); the stub reaches `UserSecurityDO` too, because the
 * pool runs the Durable Objects in the test's isolate.
 *
 * PR 2 batch A (plan Task 17) holds the tests that drive `UserSecurityDO` and
 * `sendNotice` directly; batch B (plan Task 19) adds the login, signup and reset
 * flows at the end of the file.
 */
const { allowFaults } = guardAlertingFaults();

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
const event = (atMs: number, country: string | null = null) => ({ atMs, country, listWasEmpty: false });
/** The route's handle on a send-now claim (review M-4); -1 for a deferred one. */
const claimIdOf = (c: NoticeClaimResult) => (c.send === "now" ? c.claimId : -1);
const HOUR = 3_600_000;

/** Every Postmark request the global `fetch` stub saw, refused ones included. */
const postmarkCalls = () => vi.mocked(fetch).mock.calls.length;

/** Anonymise `id` the way the reaper leaves it: the address lookup then finds no live row. */
async function anonymise(id: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [id]));
  await waitOnExecutionContext(ctx);
}

/** A token for `userId` whose K1 hash sorts before (or after) its K2 hash: the order a `WITHOUT ROWID` scan returns. */
async function tokenWithOrder(userId: string, prevFirst: boolean): Promise<string> {
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const t = tokenOf(c);
    if ((await deviceHash("K1", userId, t)) < (await deviceHash("K2", userId, t)) === prevFirst) return t;
  }
  throw new Error("no token with the wanted order in 26 tries");
}

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
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (u) => {
    quiet(u);
    return u.recordDevice(hashes, nowMs, mode);
  });
}

function pendingRows(userId: string) {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, s) =>
    s.storage.sql.exec<{ count: number; due_ms: number; attempts: number }>("SELECT count, due_ms, attempts FROM pending_notice").toArray(),
  );
}

function deviceCount(userId: string): Promise<number> {
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
  it.each([300, 406])("ErrorCode %i on a deferred notice → dropped_permanent_refusal at once, logged, one notice_dropped", async (code) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const now = Date.now();
    await quietClaim(id, now, now + 60_000);
    postmarkStatus = { status: 422, body: { ErrorCode: code } };
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n).toBe(0);
    });
    expect(dropped).toEqual(["dropped_expired"]);
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: dropped dropped_expired new_sign_in")).toHaveLength(1);
  });
});

describe("end states: account gone, and a route's claim settled (§4.4; P-5)", () => {
  it("dropPendingNotices (a reaper): dropped_account_gone, logged, no Postmark call, no ledger call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const now = Date.now();
    await quietClaim(id, now, now + 1);
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u) => {
      quiet(u);
      u.ledgerFor = dropRecorder(dropped);
      await u.dropPendingNotices();
    });
    expect(postmarkCalls()).toBe(0);
    expect(dropped).toEqual([]);
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: dropped dropped_account_gone new_sign_in")).toHaveLength(1);
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
      expect(claim).toEqual({ send: "now", claimId: expect.any(Number) as number, coalesced: { count: 1, sinceMs: now - 60_000 } });
      expect(await u.settleClaim(claimIdOf(claim), "transient", now + 1)).toBe(true);
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(0);
    });
    expect(await pendingRows(id)).toEqual([{ count: 2, due_ms: now + 1 + 15 * 60_000, attempts: 1 }]);
  });

  it("P-5: a send-now claim settled 'sent' leaves nothing pending and nothing claimed", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quiet(u);
      const claim = await u.claimNotice("new_sign_in", { atMs: now, country: null, listWasEmpty: false }, now, now);
      expect(await u.settleClaim(claimIdOf(claim), "sent", now + 1)).toBe(true);
      expect(await u.settleClaim(claimIdOf(claim), "sent", now + 2)).toBe(false); // settled once only
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

describe("the alarm isolates each notice, and always re-arms (review M-2)", () => {
  it("one kind's settle throws: the other kind is still sent, the alarm re-arms, and the stranded one goes out next run", async () => {
    allowFaults("account-notice alarm_send");
    const { id } = await newUser();
    const t0 = Date.now();
    const sent: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      const armed = quiet(u);
      await u.claimNotice("new_sign_in", event(t0), t0, t0 + 1);
      await u.claimNotice("password_reset", event(t0), t0, t0 + 2);
      u.noticeSender = (_env, _ctx, _id, facts) => {
        sent.push(facts.kind);
        // The NEXT storage transaction (this kind's settle) throws.
        if (sent.length === 1) vi.spyOn(s.storage, "transactionSync").mockImplementationOnce(() => { throw new Error("injected"); });
        return Promise.resolve("sent" as const);
      };
      await u.alarmAt(t0 + 2);
      expect(sent).toEqual(["new_sign_in", "password_reset"]);
      expect(armed.at(-1)).toBe(t0 + 2 + 60_000);
      await u.alarmAt(t0 + 2 + 60_000);
      expect(sent).toEqual(["new_sign_in", "password_reset", "new_sign_in"]);
      const left = s.storage.sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM pending_notice) + (SELECT COUNT(*) FROM inflight_notice) AS n").one().n;
      expect(left).toBe(0);
    });
  });
});

describe("the cap counts a send in progress (review M-3)", () => {
  it("a route's claim while the alarm's 3rd send of the hour awaits Postmark is deferred, never a 4th", async () => {
    const { id } = await newUser();
    const t0 = Date.now();
    const during: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quiet(u);
      for (let i = 0; i < 2; i++) await u.claimNotice("new_sign_in", event(t0 + i), t0 + i, t0 + i); // two sends this hour
      await u.claimNotice("new_sign_in", event(t0 + 2), t0 + 2, t0 + 10); // deferred, under the cap
      u.noticeSender = async () => {
        const c = await u.claimNotice("new_sign_in", event(t0 + 11), t0 + 11, t0 + 11); // a route, mid-send
        during.push(c.send);
        return "sent";
      };
      await u.alarmAt(t0 + 10);
    });
    expect(during).toEqual(["deferred"]);
  });
});

describe("two send-now claims in the same millisecond (review M-4)", () => {
  it("get distinct claims: one settled sent, the other transient → the other is retried and sent", async () => {
    const { email, id } = await newUser();
    const now = Date.now();
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quiet(u);
      const a = await u.claimNotice("new_sign_in", event(now), now, now);
      const b = await u.claimNotice("new_sign_in", event(now), now, now);
      expect(claimIdOf(a)).not.toBe(claimIdOf(b));
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(2);
      expect(await u.settleClaim(claimIdOf(a), "sent", now + 1)).toBe(true);
      expect(await u.settleClaim(claimIdOf(b), "transient", now + 1)).toBe(true);
      await u.alarmAt(now + 1 + 15 * 60_000);
    });
    expect(mails.map((m) => m.to)).toEqual([email]);
  });
});

describe("account gone at send time, and repeated folds (review M-5)", () => {
  it("the alarm finds no live account → dropped_account_gone, logged; no Postmark call, no ledger call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    await anonymise(id);
    const now = Date.now();
    await quietClaim(id, now, now + 1);
    const dropped: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quiet(u);
      u.ledgerFor = dropRecorder(dropped);
      await u.alarmAt(now + 1);
    });
    expect(postmarkCalls()).toBe(0);
    expect(dropped).toEqual([]);
    expect(await pendingRows(id)).toEqual([]);
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: dropped dropped_account_gone new_sign_in")).toHaveLength(1);
  });

  it("folds under a full daily cap, each as late as the wave allows, never push the due time past NOTICE_MAX_DELAY_MS", async () => {
    const { id } = await newUser();
    const t0 = Date.now();
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quiet(u);
      for (const ago of [23, 23, 23, 20, 20, 20, 10, 10, 10, 0]) await u.claimNotice("new_sign_in", event(t0 - ago * HOUR), t0 - ago * HOUR, t0 - ago * HOUR);
      for (let i = 1; i <= 30; i++) {
        const at = t0 + i * HOUR;
        const c = await u.claimNotice("new_sign_in", event(at), at, at + WAVE_SPREAD_MS);
        if (c.send === "deferred") expect(c.dueMs - t0 - HOUR, String(i)).toBeLessThanOrEqual(NOTICE_MAX_DELAY_MS);
      }
    });
  });
});

// ---- PR 2 batch B (plan Task 19): the login, signup and reset flows ----------

const ORIGIN = "https://community.thinkersjournal.com";
const DEV_COOKIE = "tj_device_dev=";

/**
 * A per-call-unique client IP in its own /64 (the IPv6 documentation prefix), so
 * no login here shares LOGIN_IP_LIMITER's IP-only bucket (30 a minute) with
 * another, as test/login.test.ts does.
 */
function uniqueIp(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}::1`;
}

/** POST /auth/login through the Worker; returns the response and the device token it carried or minted. */
async function login(email: string, carried: string | null, e: Env = ON, ip = uniqueIp(), password = PASSWORD) {
  const ctx = createExecutionContext();
  const headers = new Headers({ "content-type": "application/json", Origin: ORIGIN, "X-TJ-Client-Country": "DE", "CF-Connecting-IP": ip });
  if (carried !== null) headers.set("Cookie", `${DEV_COOKIE}${carried}`);
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", { method: "POST", headers, body: JSON.stringify({ email, password }) }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const minted = res.headers.getSetCookie().find((c) => c.startsWith(DEV_COOKIE));
  return { res, token: minted === undefined ? carried : (minted.split(";").at(0) ?? "").slice(DEV_COOKIE.length) };
}

/** Run a flow inside its own execution context, the way a route's waitUntil would. */
async function flow(run: (ctx: ExecutionContext) => Promise<void>): Promise<void> {
  const ctx = createExecutionContext();
  await run(ctx);
  await waitOnExecutionContext(ctx);
}

/** A Hyperdrive binding whose connect always fails: the address lookup THROWS (CR-1). */
const DEAD_DB = { ...ON, HYPERDRIVE_FRESH: { connectionString: "postgres://x:y@127.0.0.1:1/none" } } as Env;

/** Run the object's alarm at `atMs` with its alarm seam replaced. */
async function quietAlarm(userId: string, atMs: number): Promise<void> {
  await runInDurableObject(env.USER_SECURITY.getByName(userId), async (u) => {
    quiet(u);
    await u.alarmAt(atMs);
  });
}

function pendingNotice(userId: string) {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, s) =>
    s.storage.sql.exec<{ due_ms: number; count: number }>("SELECT due_ms, count FROM pending_notice").toArray(),
  );
}

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
    mails = [];
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
    mails = [];
    await login(email, a.token);
    expect(mails).toHaveLength(1);
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
    mails = [];
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: tokenOf("C"), country: null, nowMs: Date.now() }));
    expect(mails.map((m) => m.subject)).toEqual(["Your Thinkers Journal password was changed"]);
    expect(await deviceCount(id)).toBe(1);
    mails = [];
    await login(email, tokenOf("A"));
    expect(mails).toHaveLength(1);
  });

  it("a barred reset (no token) forgets every browser and still mails", async () => {
    const { email, id } = await newUser();
    await login(email, tokenOf("A"));
    mails = [];
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
    mails = [];
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
describe("device keys through the flow: HMAC and the wave (N5, §4.4; plan Task 19)", () => {
  it("HMAC: one token under two user ids → two different stored hashes", async () => {
    expect(await deviceHash("K", "u1", tokenOf("T"))).not.toBe(await deviceHash("K", "u2", tokenOf("T")));
  });

  it("wave spread: a key replaced WITHOUT _PREV → unknownKeysOnly; pending inside 6 h; the alarm sends it", async () => {
    const { email, id } = await newUser();
    const a = await login(email, null, { ...ON, DEVICE_HASH_KEY: "OLD" });
    mails = [];
    await login(email, a.token, { ...ON, DEVICE_HASH_KEY: "NEW" });
    expect(mails).toHaveLength(0);
    const due = (await pendingNotice(id)).at(0)?.due_ms ?? 0;
    expect(due - Date.now()).toBeLessThanOrEqual(WAVE_SPREAD_MS);
    await quietAlarm(id, due);
    expect(mails).toHaveLength(1);
  });
});

describe("caps through the flow (§4.4; plan Task 19)", () => {
  it("cap: after one known login, four new browsers in an hour → two more mails; the rest are deferred, and say 'also covers'", async () => {
    const { email, id } = await newUser();
    await login(email, null);
    mails = [];
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
describe("an immediate send's end state (§4.4 G1; plan Task 19)", () => {
  it("a permanent refusal on an immediate send → dropped_permanent_refusal logged ONCE and reported to the ledger once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    postmarkStatus = { status: 422, body: { ErrorCode: 406 } };
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
    mails = [];
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

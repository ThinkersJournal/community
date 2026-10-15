import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { NOTICE_MAX_AGE_MS, NOTICE_MAX_DELAY_MS, WAVE_SPREAD_MS } from "@thinkersjournal/shared";

import { withClient } from "../src/db/client";
import { sendNotice } from "../src/security/account-notice-send";

import {
  anonymise,
  claimIdOf,
  dropRecorder,
  event,
  HOUR,
  mails,
  newUser,
  ON,
  pendingRows,
  postmarkCalls,
  quietClaim,
  quietOn,
  setPostmarkStatus,
  useNoticeTestHooks,
} from "./helpers/account-notices";
import { guardAlertingFaults, quiet } from "./helpers/security-do";

/**
 * Account-holder notices (security-alerting spec §4): caps, claims, in-flight sends and their end states (§4.4). Pool project;
 * fixtures, the Postmark stub and the clean-up are in helpers/account-notices.ts.
 */
const { allowFaults } = guardAlertingFaults();
useNoticeTestHooks();
describe("caps and deferral (§4.4)", () => {
  it("cap: three send-now claims in the hour; the 4th is deferred until the oldest is an hour old", async () => {
    const { id } = await newUser();
    const t0 = Date.now();
    const sends: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quietOn(u);
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
    setPostmarkStatus({ status: 422, body: { ErrorCode: code } });
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u, s) => {
      quietOn(u);
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
    setPostmarkStatus({ status: 503, body: {} });
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u, s) => {
      quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
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
        quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
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

describe("the alarm isolates each notice, and always re-arms (review M-2)", () => {
  it("one kind's settle throws: the other kind is still sent, the alarm re-arms, and the stranded one goes out next run", async () => {
    allowFaults("account-notice alarm_send");
    const { id } = await newUser();
    const t0 = Date.now();
    const sent: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      const armed = quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
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
      quietOn(u);
      for (const ago of [23, 23, 23, 20, 20, 20, 10, 10, 10, 0]) await u.claimNotice("new_sign_in", event(t0 - ago * HOUR), t0 - ago * HOUR, t0 - ago * HOUR);
      for (let i = 1; i <= 30; i++) {
        const at = t0 + i * HOUR;
        const c = await u.claimNotice("new_sign_in", event(at), at, at + WAVE_SPREAD_MS);
        if (c.send === "deferred") expect(c.dueMs - t0 - HOUR, String(i)).toBeLessThanOrEqual(NOTICE_MAX_DELAY_MS);
      }
    });
  });
});

describe("a reaper's drop during a send in progress (final review M-2)", () => {
  it.each(["transient", "permanent", "sent"] as const)("the send ends %s: nothing comes back, and the drop is logged once", async (outcome) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    const dropped: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      quietOn(u);
      u.ledgerFor = dropRecorder(dropped);
      u.noticeSender = async () => {
        await u.dropPendingNotices(); // the reaper, while Postmark is answering
        return outcome;
      };
      await u.alarmAt(t0 + 1);
      const left = s.storage.sql.exec<{ n: number }>(
        "SELECT (SELECT COUNT(*) FROM pending_notice) + (SELECT COUNT(*) FROM inflight_notice) + (SELECT COUNT(*) FROM claimed_notice) AS n",
      ).one().n;
      expect(left).toBe(0);
    });
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("account-notice: dropped "))).toEqual([
      ["account-notice: dropped dropped_account_gone new_sign_in"],
    ]);
    expect(dropped).toEqual([]);
  });
});

describe("notices off at SEND time (final review M-5)", () => {
  it("a queued notice is HELD while the flag is off: not sent, not dropped; it goes once the flag is on", async () => {
    const { email, id } = await newUser();
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    const stub = env.USER_SECURITY.getByName(id);
    const due = await runInDurableObject(stub, async (u, s) => {
      quiet(u); // the object's own env: ACCOUNT_NOTICES_ENABLED "0"
      await u.alarmAt(t0 + 1);
      return s.storage.sql.exec<{ due_ms: number; count: number }>("SELECT due_ms, count FROM pending_notice").toArray();
    });
    expect(postmarkCalls()).toBe(0);
    expect(due.map((r) => r.count)).toEqual([1]);
    expect(due.at(0)?.due_ms ?? 0).toBeGreaterThan(t0 + 1); // re-armed later, so the alarm does not spin
    await runInDurableObject(stub, async (u) => {
      quietOn(u);
      await u.alarmAt(due.at(0)?.due_ms ?? 0);
    });
    expect(mails.map((m) => m.to)).toEqual([email]);
  });

  it("a held notice still ages out under NOTICE_MAX_AGE_MS: dropped_expired, never sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    const dropped: string[] = [];
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      quiet(u);
      u.ledgerFor = dropRecorder(dropped);
      await u.alarmAt(t0 + NOTICE_MAX_AGE_MS);
    });
    expect(postmarkCalls()).toBe(0);
    expect(await pendingRows(id)).toEqual([]);
    expect(dropped).toEqual(["dropped_expired"]);
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: dropped dropped_expired new_sign_in")).toHaveLength(1);
  });
});

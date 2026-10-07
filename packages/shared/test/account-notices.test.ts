import { describe, expect, it } from "vitest";

import {
  buildDeviceCookie,
  capAllows,
  capReopensAt,
  classifyPostmark,
  deviceHash,
  deviceHashes,
  foldedDueMs,
  keyId,
  newSignInNotice,
  NOTICE_MAX_AGE_MS,
  noticeNotBefore,
  noticeRetryDelayMs,
  passwordResetNotice,
  resolveDeviceKeys,
  WAVE_SPREAD_MS,
} from "../src/account-notices";

const H = 3_600_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const URL_ = "https://community.thinkersjournal.com/forgot-password";

describe("classifyPostmark (PR 1; security-alerting spec §4.4)", () => {
  it.each([
    [{ ok: true } as const, "sent"],
    [{ ok: false, status: 422, errorCode: 300 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 406 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 10 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 412 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 1480 } as const, "transient"],
    [{ ok: false, status: 429, errorCode: null } as const, "transient"],
    [{ ok: false, status: 500, errorCode: null } as const, "transient"],
    [{ ok: false, status: null, errorCode: null } as const, "transient"],
  ])("%j → %s", (outcome, want) => {
    expect(classifyPostmark(outcome)).toBe(want);
  });
});

describe("caps, folds and retries (PR 2)", () => {
  it("noticeRetryDelayMs: 15, 30, 60, 120, 240, then 360 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => noticeRetryDelayMs(n) / 60_000)).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });

  it("three sends in the hour close the cap; it reopens when the oldest is an hour old", () => {
    const sent = [NOW - 50 * 60_000, NOW - 20 * 60_000, NOW - 5 * 60_000];
    expect(capAllows(sent, NOW, "new_sign_in")).toBe(false);
    expect(capReopensAt(sent, NOW, "new_sign_in")).toBe(NOW + 10 * 60_000);
  });

  it("capReopensAt is never more than 24 h after now", () => {
    const sent = Array.from({ length: 10 }, (_, i) => NOW - i * 2 * H);
    expect(capReopensAt(sent, NOW, "new_sign_in") - NOW).toBeLessThanOrEqual(24 * H);
  });

  it("foldedDueMs keeps the earlier due time and never goes before the cap reopens", () => {
    expect(foldedDueMs(NOW + 2 * H, NOW + 5 * H, NOW)).toBe(NOW + 2 * H);
    expect(foldedDueMs(NOW + 2 * H, NOW + 1 * H, NOW)).toBe(NOW + 1 * H);
    expect(foldedDueMs(NOW + 2 * H, NOW + 1 * H, NOW + 3 * H)).toBe(NOW + 3 * H);
    expect(foldedDueMs(null, NOW, NOW + H)).toBe(NOW + H);
  });

  it("a wave sign-in is spread inside WAVE_SPREAD_MS; any other is now", () => {
    const wave = { knownDevice: false, listWasEmpty: false, unknownKeysOnly: true };
    expect(noticeNotBefore(wave, NOW, () => 0.5)).toBe(NOW + WAVE_SPREAD_MS / 2);
    expect(noticeNotBefore({ ...wave, unknownKeysOnly: false }, NOW, () => 0.5)).toBe(NOW);
  });

  it("transient refusals end after 7 days: ~32 attempts", () => {
    let t = 0;
    let n = 0;
    while (t < NOTICE_MAX_AGE_MS) t += noticeRetryDelayMs(++n);
    expect(n).toBeGreaterThanOrEqual(30);
    expect(n).toBeLessThanOrEqual(33);
  });
});

describe("device keys and hashes (PR 2; N5)", () => {
  it("no key → null (device notices disabled); an empty _PREV is no previous key", () => {
    expect(resolveDeviceKeys({})).toBeNull();
    expect(resolveDeviceKeys({ DEVICE_HASH_KEY: "" })).toBeNull();
    expect(resolveDeviceKeys({ DEVICE_HASH_KEY: "k1", DEVICE_HASH_KEY_PREV: "" })).toEqual({ current: "k1", prev: null });
  });

  it("one token under two user ids → two unrelated hashes, neither the token's plain SHA-256", async () => {
    const token = "A".repeat(43);
    const a = await deviceHash("k1", "user-a", token);
    const b = await deviceHash("k1", "user-b", token);
    expect(a).not.toBe(b);
    const plain = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    expect(a).not.toBe(plain);
  });

  it("deviceHashes carries both keys' ids during a rotation", async () => {
    const h = await deviceHashes({ current: "k2", prev: "k1" }, "u", "A".repeat(43));
    expect(h.currentKid).toBe(await keyId("k2"));
    expect(h.prevKid).toBe(await keyId("k1"));
    expect(h.prev).toBe(await deviceHash("k1", "u", "A".repeat(43)));
  });

  it("the cookie strings, both pinned", () => {
    expect(buildDeviceCookie({}, "tok")).toBe("__Host-tj_device=tok; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000");
    expect(buildDeviceCookie({ TEST_ROUTES: "1" }, "tok")).toBe("tj_device_dev=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000");
  });
});

describe("notice text (PR 2; §4.2)", () => {
  const base = { at: new Date(NOW), coalesced: null, forgotPasswordUrl: URL_ };

  it("names the country, never an IP; a bad code omits the phrase", () => {
    expect(newSignInNotice({ ...base, country: "DE", listWasEmpty: false }).textBody).toContain("(approximate)");
    expect(newSignInNotice({ ...base, country: "de", listWasEmpty: false }).textBody).not.toContain(" from ");
    expect(newSignInNotice({ ...base, country: null, listWasEmpty: false }).textBody).not.toContain(" from ");
  });

  it("the empty-list sentence appears only for an empty list", () => {
    expect(newSignInNotice({ ...base, country: null, listWasEmpty: true }).textBody).toContain("had no browser on record");
    expect(newSignInNotice({ ...base, country: null, listWasEmpty: false }).textBody).not.toContain("had no browser on record");
  });

  it("a coalesced notice says how many others since when", () => {
    const c = { count: 1, since: new Date(NOW - H) };
    expect(newSignInNotice({ ...base, coalesced: c, country: null, listWasEmpty: false }).textBody).toContain(
      "also covers 1 other new sign-in since 2026-10-07T11:00:00.000Z",
    );
    expect(passwordResetNotice({ ...base, country: null }).textBody).toContain(URL_);
  });
});

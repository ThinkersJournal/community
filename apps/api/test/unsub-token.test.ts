import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintUnsubToken, verifyUnsubToken } from "../src/notifications/unsub-token";

describe("unsub HMAC token", () => {
  it("round-trips a userId", async () => {
    const uid = crypto.randomUUID();
    expect(await verifyUnsubToken(env, await mintUnsubToken(env, uid))).toBe(uid);
  });
  it("rejects a tampered payload", async () => {
    const t = await mintUnsubToken(env, crypto.randomUUID());
    const [, sig] = t.split(".");
    const forged = `${btoa("attacker").replace(/=+$/, "")}.${sig}`;
    expect(await verifyUnsubToken(env, forged)).toBeNull();
  });
  it("rejects a malformed token", async () => {
    expect(await verifyUnsubToken(env, "not-a-token")).toBeNull();
    expect(await verifyUnsubToken(env, "")).toBeNull();
  });
});

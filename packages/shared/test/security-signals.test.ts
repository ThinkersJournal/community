import { describe, expect, it } from "vitest";

import { classify, networkKey, shardFor, SHARDS_PER_KIND, SIGNAL_RULES } from "../src/security-signals";

import type { SecurityEvent } from "../src/security-log";

const AT = new Date("2026-10-07T12:00:30.000Z");
const MINUTE = Math.floor(AT.getTime() / 60_000);
const loginFail = (ip: string | null): SecurityEvent => ({
  kind: "auth_failure",
  route: "/auth/login",
  reason: "invalid_credentials",
  ip,
});
const signals = (e: SecurityEvent, c = {}) => classify(e, AT, c).map((i) => i.signal).sort();

describe("classify (security-alerting spec §2.3): which signals an event yields", () => {
  it("a login failure with an account yields exactly six increments, by name", () => {
    expect(signals(loginFail("203.0.113.9"), { email: "a@example.invalid", userId: "u1" })).toEqual([
      "credential_stuffing",
      "distributed_account_guess",
      "login_failure_storm",
      "login_ip_burst",
      "slow_stuffing",
      "targeted_account",
    ]);
  });

  it("without an account: four", () => {
    expect(signals(loginFail("203.0.113.9"), { email: "a@example.invalid" })).toEqual([
      "credential_stuffing",
      "login_failure_storm",
      "login_ip_burst",
      "slow_stuffing",
    ]);
  });

  it("a login 429 yields ONLY rate_limit_storm — no per-/64 row (control: the failure above yields login_ip_burst)", () => {
    const e: SecurityEvent = { kind: "rate_limited", route: "/auth/login", reason: "ip", ip: "2001:db8:1:2::9" };
    expect(signals(e)).toEqual(["rate_limit_storm"]);
    expect(signals(loginFail("2001:db8:1:2::9"))).toContain("login_ip_burst");
  });

  it("a user-keyed 429 yields exactly one increment", () => {
    const e: SecurityEvent = { kind: "rate_limited", route: "/comments", reason: "user", ip: "203.0.113.9" };
    expect(signals(e)).toEqual(["rate_limit_storm"]);
  });

});

describe("classify (security-alerting spec §2.3): subjects and shards", () => {
  it("two IPv6 addresses in one /64 share a subject and a shard; another /64 does not", () => {
    const sub = (ip: string) => classify(loginFail(ip), AT, {}).find((i) => i.signal === "login_ip_burst");
    const a = sub("2001:db8:1:2::1");
    const b = sub("2001:db8:1:2:ffff::9");
    const c = sub("2001:db8:1:3::1");
    expect(a?.subject).toBe("2001:db8:1:2::/64");
    expect(b?.subject).toBe(a?.subject);
    expect(b?.shard).toBe(a?.shard);
    expect(c?.subject).not.toBe(a?.subject);
  });

  it("an IPv4-mapped address is its IPv4 subject", () => {
    const sub = (ip: string) => classify(loginFail(ip), AT, {}).find((i) => i.signal === "login_ip_burst")?.subject;
    expect(sub("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("reset_token_burst counts per /48 and per /24 (control: login_ip_burst gives two subjects)", () => {
    const reset = (ip: string): SecurityEvent => ({ kind: "auth_failure", route: "/auth/reset-password", reason: "invalid_reset_token", ip });
    const net = (ip: string) => classify(reset(ip), AT, {}).find((i) => i.signal === "reset_token_burst")?.subject;
    expect(net("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(net("2001:db8:1:7::1")).toBe("2001:db8:1::/48");
    expect(net("203.0.113.9")).toBe("203.0.113.0/24");
    expect(net("203.0.113.200")).toBe("203.0.113.0/24");
    expect(net("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(networkKey("300.1.1.1")).toBe("300.1.1.1");
    const burst = (ip: string) => classify(loginFail(ip), AT, {}).find((i) => i.signal === "login_ip_burst")?.subject;
    expect(burst("203.0.113.9")).not.toBe(burst("203.0.113.200"));
  });

  it("ip: null → subject `none` and missing_client_ip, except purge and alerting_fault", () => {
    expect(classify(loginFail(null), AT, {}).find((i) => i.signal === "login_ip_burst")?.subject).toBe("none");
    expect(signals(loginFail(null))).toContain("missing_client_ip");
    const purge: SecurityEvent = { kind: "auth_failure", route: "/internal/purge", reason: "bad_purge_secret", ip: null };
    expect(signals(purge)).toEqual(["purge_secret_failure"]);
    const fault: SecurityEvent = { kind: "alerting_fault", route: "/auth/login", reason: "device_hash_key_missing", ip: null };
    expect(signals(fault)).toEqual([]);
  });

});

describe("classify (security-alerting spec §2.3): shards, minutes, members and rules", () => {
  it("shardFor always returns one of the 33 names", () => {
    const names = new Set(["site", ...Array.from({ length: SHARDS_PER_KIND }, (_, i) => [`ip:${i}`, `acct:${i}`]).flat()]);
    expect(names.size).toBe(33);
    for (let i = 0; i < 500; i++) {
      expect(names.has(shardFor("ip", `2001:db8:${i}::/64`))).toBe(true);
      expect(names.has(shardFor("account", `user-${i}`))).toBe(true);
    }
  });

  it("every increment is stamped with the event's minute", () => {
    for (const inc of classify(loginFail("203.0.113.9"), AT, { email: "a@example.invalid" })) expect(inc.minute).toBe(MINUTE);
  });

  it("events rules carry no member (the spec's classify, as merged; ruling I-8)", () => {
    for (const inc of classify(loginFail("2001:db8:1:2::9"), AT, {})) expect(inc.member, inc.signal).toBeNull();
  });

  it.each(SIGNAL_RULES.map((r) => [r.signal, r] as const))("%s matches its own event and not a control", (_s, rule) => {
    const route = rule.signal.startsWith("reset") ? "/auth/reset-password" : rule.signal === "purge_secret_failure" ? "/internal/purge" : "/auth/login";
    const kind = rule.signal === "rate_limit_storm" ? "rate_limited" : "auth_failure";
    const ip = rule.signal === "missing_client_ip" ? null : "203.0.113.9";
    const hit: SecurityEvent = { kind, route, reason: "x", ip };
    expect(rule.matches(hit, { email: "a@example.invalid", userId: "u1" })).toBe(true);
    const control: SecurityEvent = { kind: "alerting_fault", route: "/elsewhere", reason: "x", ip: "203.0.113.9" };
    expect(rule.matches(control, {})).toBe(false);
  });
});

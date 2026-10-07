import { afterEach, describe, expect, it, vi } from "vitest";

import { logSecurityEvent, setSecurityEventObserver } from "../src/security-log";

import type { SecurityEvent, SecurityEventCounting } from "../src/security-log";

const EVENT: SecurityEvent = { kind: "auth_failure", route: "/auth/login", reason: "invalid_credentials", ip: "203.0.113.9" };
const ADDRESS = "fixture-person@example.invalid";

afterEach(() => {
  setSecurityEventObserver(null);
  vi.restoreAllMocks();
});

describe("logSecurityEvent (security-alerting spec §2.2)", () => {
  it("writes the SAME line as before, byte for byte", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSecurityEvent(EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("security: auth_failure /auth/login invalid_credentials");
    expect(Object.keys(warn.mock.calls[0]?.[1] as object)).toEqual(["kind", "route", "reason", "ip", "at"]);
  });

  it("calls the observer once per event, with the counting argument and the line's own time", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: [SecurityEvent, Date, SecurityEventCounting][] = [];
    setSecurityEventObserver((e, at, c) => seen.push([e, at, c]));
    logSecurityEvent(EVENT, { email: ADDRESS, userId: "u1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[2]).toEqual({ email: ADDRESS, userId: "u1" });
  });

  it("never puts the counting argument into the log (positive control: the observer got it)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const got: string[] = [];
    setSecurityEventObserver((_e, _at, c) => got.push(c.email ?? ""));
    logSecurityEvent(EVENT, { email: ADDRESS, userId: "user-id-fixture" });
    expect(got).toEqual([ADDRESS]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(ADDRESS);
    expect(logged).not.toContain("user-id-fixture");
  });

  it("an observer that throws neither throws out nor stops the line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setSecurityEventObserver(() => {
      throw new Error("observer broke");
    });
    expect(() => {
      logSecurityEvent(EVENT);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an `alerting_fault` line uses the same prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "ledger_unreachable", ip: null });
    expect(warn.mock.calls[0]?.[0]).toBe("security: alerting_fault security-ledger ledger_unreachable");
  });
});

/**
 * Final review M-3: a throwing observer must not stop counting SILENTLY. The
 * first throw in an isolate logs one PII-free line (the error's name); later
 * throws stay quiet so a broken observer cannot flood the log on every event.
 */
describe("logSecurityEvent — a throwing observer is reported once", () => {
  class ClassifyBroke extends Error {
    override name = "ClassifyBroke";
  }

  it("logs the first throw once, by name, and never again for the same observer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setSecurityEventObserver(() => {
      throw new ClassifyBroke(`bad subject ${ADDRESS}`);
    });
    for (let i = 0; i < 3; i++) logSecurityEvent(EVENT, { email: ADDRESS });
    expect(err.mock.calls).toEqual([["security-counter: observer threw; counting is not recording", "ClassifyBroke"]]);
  });

  it("a newly installed observer that throws is reported again (control: the flag is per observer)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = () => {
      throw new ClassifyBroke("x");
    };
    setSecurityEventObserver(broken);
    logSecurityEvent(EVENT);
    setSecurityEventObserver(broken);
    logSecurityEvent(EVENT);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

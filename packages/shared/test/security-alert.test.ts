import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverSecurityAlert,
  LogSecurityAlertSink,
  selectSecurityAlertSink,
  type SecurityAlertMessage,
  type SecurityAlertSink,
} from "../src/security-alert";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SECRET_EMAIL = "alerts-fixture@example.invalid";
const SECRET_TOKEN = "relay-token-fixture-0000";
const fakeSink: SecurityAlertSink = { name: "fake", send: () => Promise.resolve({ delivered: true }) };

describe("selectSecurityAlertSink (security-alerting spec §3.2)", () => {
  it("flag off → the log sink, whatever is configured", () => {
    const sink = selectSecurityAlertSink({ SECURITY_ALERTS_ENABLED: "0", SECURITY_ALERT_EMAIL: SECRET_EMAIL }, () => fakeSink);
    expect(sink).toBeInstanceOf(LogSecurityAlertSink);
  });

  it("flag on, factory present, address empty → the log sink, LOUDLY, naming the key and no value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { SECURITY_ALERTS_ENABLED: "1", SECURITY_ALERT_EMAIL: "", SECURITY_ALERT_RELAY_TOKEN: SECRET_TOKEN };
    expect(selectSecurityAlertSink(env, () => fakeSink)).toBeInstanceOf(LogSecurityAlertSink);
    expect(err).toHaveBeenCalledWith(expect.any(String), { missing: ["SECURITY_ALERT_EMAIL"] });
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET_TOKEN);
  });

  it("flag on and the transport is still null (phase 1) → the log sink, naming `transport`", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { SECURITY_ALERTS_ENABLED: "1", SECURITY_ALERT_EMAIL: SECRET_EMAIL, SECURITY_ALERT_RELAY_TOKEN: SECRET_TOKEN };
    expect(selectSecurityAlertSink(env, null)).toBeInstanceOf(LogSecurityAlertSink);
    expect(err).toHaveBeenCalledWith(expect.any(String), { missing: ["transport"] });
  });

  it("fully configured → the factory's sink", () => {
    const env = { SECURITY_ALERTS_ENABLED: "1", SECURITY_ALERT_EMAIL: SECRET_EMAIL, SECURITY_ALERT_RELAY_TOKEN: SECRET_TOKEN };
    expect(selectSecurityAlertSink(env, () => fakeSink)).toBe(fakeSink);
  });
});

describe("deliverSecurityAlert", () => {
  const msg: SecurityAlertMessage = { type: "config_fault", key: "DEVICE_HASH_KEY", detail: "missing" };

  it("a throwing sink → delivered: false, never a throw", async () => {
    const sink: SecurityAlertSink = {
      name: "t",
      send: () => Promise.reject(new TypeError("boom")),
    };
    expect(await deliverSecurityAlert(sink, msg)).toEqual({ delivered: false, reason: "TypeError" });
  });

  it("a sink that never resolves → `timeout` after 10 s (fake timers)", async () => {
    vi.useFakeTimers();
    const sink: SecurityAlertSink = { name: "hang", send: () => new Promise(() => undefined) };
    const pending = deliverSecurityAlert(sink, msg);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ delivered: false, reason: "timeout" });
  });
});

describe("LogSecurityAlertSink", () => {
  it("writes one `security-alert:` line — never the `security:` prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new LogSecurityAlertSink().send({ type: "heartbeat", day: "2026-10-07", lateMinutes: 0, totals: [] })).toEqual({
      delivered: true,
    });
    expect(warn.mock.calls[0]?.[0]).toBe("security-alert: heartbeat");
    expect(String(warn.mock.calls[0]?.[0]).startsWith("security:")).toBe(false);
  });
});

// §5's "No PII in messages" is pinned on the ledger's REAL output (test/security-ledger-do.test.ts),
// not on hand-written literals here, which would test nothing (audit I-7).

import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefsInput } from "../src";

describe("prefs", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      masterEnabled: true, direct: "instant", reactions: "digest", follows: "digest",
    });
  });
  it("accepts a full valid payload", () => {
    expect(NotificationPrefsInput.safeParse({
      masterEnabled: false, direct: "off", reactions: "instant", follows: "digest",
    }).success).toBe(true);
  });
  it("rejects an unknown channel", () => {
    expect(NotificationPrefsInput.safeParse({
      masterEnabled: true, direct: "hourly", reactions: "digest", follows: "digest",
    }).success).toBe(false);
  });
  it("rejects a missing field (all four required — PUT replaces the whole row)", () => {
    expect(NotificationPrefsInput.safeParse({ direct: "off" }).success).toBe(false);
  });
});

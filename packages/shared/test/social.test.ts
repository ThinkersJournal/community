import { describe, expect, it } from "vitest";

import { ChooseUsernameInput, FollowInput, USERNAME_PATTERN } from "../src/social";

describe("ChooseUsernameInput", () => {
  it("accepts a valid lowercased handle", () => {
    const parsed = ChooseUsernameInput.parse({ username: "ada_lovelace" });
    expect(parsed.username).toBe("ada_lovelace");
  });

  it("lowercases and trims before validating", () => {
    const parsed = ChooseUsernameInput.parse({ username: "  AdaLovelace  " });
    expect(parsed.username).toBe("adalovelace");
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(31)],
    ["a hyphen", "ada-lovelace"],
    ["a dot", "ada.lovelace"],
    ["a space", "ada lovelace"],
    ["unicode", "adaé"],
  ])("rejects %s", (_name, username) => {
    expect(ChooseUsernameInput.safeParse({ username }).success).toBe(false);
  });
});

describe("USERNAME_PATTERN", () => {
  it("matches 3–30 chars of [a-z0-9_]", () => {
    expect(USERNAME_PATTERN.test("abc")).toBe(true);
    expect(USERNAME_PATTERN.test("a".repeat(30))).toBe(true);
    expect(USERNAME_PATTERN.test("AB")).toBe(false);
  });
});

describe("FollowInput", () => {
  it("accepts a uuid followeeId", () => {
    const id = "018f6c1e-0000-7000-8000-000000000000";
    expect(FollowInput.parse({ followeeId: id }).followeeId).toBe(id);
  });
  it("rejects a non-uuid followeeId", () => {
    expect(FollowInput.safeParse({ followeeId: "nope" }).success).toBe(false);
  });
});

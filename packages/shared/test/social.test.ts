import { describe, expect, it } from "vitest";

import { FollowInput, USERNAME_PATTERN } from "../src/social";

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

import { describe, expect, it } from "vitest";

import { BlockInput, ReportInput } from "../src";

describe("ReportInput", () => {
  const reason = "spam" as const;

  it("accepts exactly one target with a valid reason", () => {
    expect(ReportInput.safeParse({ postId: crypto.randomUUID(), reason }).success).toBe(true);
    expect(ReportInput.safeParse({ commentId: crypto.randomUUID(), reason }).success).toBe(true);
  });

  it("rejects zero targets and two targets", () => {
    expect(ReportInput.safeParse({ reason }).success).toBe(false);
    expect(
      ReportInput.safeParse({
        postId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        reason,
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid reason", () => {
    expect(
      ReportInput.safeParse({ postId: crypto.randomUUID(), reason: "nonsense" }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    expect(ReportInput.safeParse({ postId: "nope", reason }).success).toBe(false);
  });
});

describe("BlockInput", () => {
  it("accepts a uuid blockedId", () => {
    const id = crypto.randomUUID();
    expect(BlockInput.parse({ blockedId: id }).blockedId).toBe(id);
  });

  it("rejects a non-uuid blockedId", () => {
    expect(BlockInput.safeParse({ blockedId: "nope" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { categoryForKind } from "../src";
import { NOTIFICATION_KINDS } from "../src";

describe("categoryForKind", () => {
  it("maps each kind to its category", () => {
    expect(categoryForKind("post_comment")).toBe("direct");
    expect(categoryForKind("comment_reply")).toBe("direct");
    expect(categoryForKind("post_reaction")).toBe("reactions");
    expect(categoryForKind("comment_reaction")).toBe("reactions");
    expect(categoryForKind("follow")).toBe("follows");
  });
  it("covers every kind (no kind falls through)", () => {
    for (const k of NOTIFICATION_KINDS) expect(categoryForKind(k)).toBeTruthy();
  });
});

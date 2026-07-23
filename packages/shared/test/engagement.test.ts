import { describe, expect, it } from "vitest";

import {
  COMMENT_MAX,
  CreateCommentInput,
  REACTION_KINDS,
  REACTION_LABELS,
  ReactionInput,
  UpdateCommentInput,
} from "../src";

describe("CreateCommentInput", () => {
  const base = { postId: crypto.randomUUID(), markdownSource: "hi" };
  it("accepts top-level and nested shapes", () => {
    expect(CreateCommentInput.safeParse(base).success).toBe(true);
    expect(
      CreateCommentInput.safeParse({ ...base, parentId: crypto.randomUUID() }).success,
    ).toBe(true);
  });
  it("rejects an empty body, an over-cap body, and a non-uuid parent", () => {
    expect(CreateCommentInput.safeParse({ ...base, markdownSource: "" }).success).toBe(false);
    expect(
      CreateCommentInput.safeParse({ ...base, markdownSource: "a".repeat(COMMENT_MAX + 1) }).success,
    ).toBe(false);
    expect(CreateCommentInput.safeParse({ ...base, parentId: "nope" }).success).toBe(false);
  });
});

describe("UpdateCommentInput", () => {
  it("accepts a body and rejects empty/over-cap", () => {
    expect(UpdateCommentInput.safeParse({ markdownSource: "x" }).success).toBe(true);
    expect(UpdateCommentInput.safeParse({ markdownSource: "" }).success).toBe(false);
  });
});

describe("ReactionInput", () => {
  const kind = "agree";
  it("accepts exactly one target", () => {
    expect(ReactionInput.safeParse({ postId: crypto.randomUUID(), kind }).success).toBe(true);
    expect(ReactionInput.safeParse({ commentId: crypto.randomUUID(), kind }).success).toBe(true);
  });
  it("rejects zero targets and two targets", () => {
    expect(ReactionInput.safeParse({ kind }).success).toBe(false);
    expect(
      ReactionInput.safeParse({
        postId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        kind,
      }).success,
    ).toBe(false);
  });
  it("kind stays a free string here — the route maps unknown kinds to INVALID_REACTION_KIND", () => {
    expect(ReactionInput.safeParse({ postId: crypto.randomUUID(), kind: "love" }).success).toBe(true);
  });
});

describe("reaction constants", () => {
  it("four tones, each with a label", () => {
    expect(REACTION_KINDS).toEqual(["insightful", "curious", "agree", "challenging"]);
    for (const k of REACTION_KINDS) expect(typeof REACTION_LABELS[k]).toBe("string");
  });
});

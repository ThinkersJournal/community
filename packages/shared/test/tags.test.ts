import { describe, expect, it } from "vitest";
import { CreatePostInput, UpdatePostInput } from "../src";

describe("post input tags", () => {
  it("defaults tags to [] and accepts up to 5 label strings", () => {
    expect(CreatePostInput.parse({ title: "T", markdownSource: "b" }).tags).toEqual([]);
    const five = ["a", "b", "c", "d", "e"];
    expect(CreatePostInput.parse({ title: "T", markdownSource: "b", tags: five }).tags).toEqual(five);
  });
  it("rejects more than 5 tags and blank/oversize labels", () => {
    expect(CreatePostInput.safeParse({ title: "T", markdownSource: "b", tags: ["a","b","c","d","e","f"] }).success).toBe(false);
    expect(CreatePostInput.safeParse({ title: "T", markdownSource: "b", tags: [""] }).success).toBe(false);
    expect(UpdatePostInput.safeParse({ title: "T", markdownSource: "b", status: "draft", tags: ["x".repeat(51)] }).success).toBe(false);
  });
  it("trims label whitespace", () => {
    expect(CreatePostInput.parse({ title: "T", markdownSource: "b", tags: ["  ai  "] }).tags).toEqual(["ai"]);
  });
});

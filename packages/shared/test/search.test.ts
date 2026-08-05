import { describe, expect, it } from "vitest";
import { SEARCH_TYPES, SEARCH_PAGE_SIZE, SEARCH_Q_MIN, SEARCH_Q_MAX, SEARCH_MAX_OFFSET } from "../src";

describe("search constants", () => {
  it("exposes the type tuple and limits", () => {
    expect(SEARCH_TYPES).toEqual(["posts", "people"]);
    expect(SEARCH_PAGE_SIZE).toBe(20);
    expect(SEARCH_Q_MIN).toBe(2);
    expect(SEARCH_Q_MAX).toBe(100);
    expect(SEARCH_MAX_OFFSET).toBe(200);
  });
});

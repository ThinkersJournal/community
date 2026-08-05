import { describe, expect, it } from "vitest";

import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE } from "@thinkersjournal/shared";

import { nextOffsetFor } from "../src/routes/search";

// Pure unit coverage for the pagination decision extracted from the handler.
// Exercises every branch of the hasMore sentinel + offset-cap so a regression
// (dropping the cap, or forgetting the +1 sentinel) can no longer ship green.
describe("nextOffsetFor", () => {
  it("returns null for exactly a full page (no +1 sentinel)", () => {
    expect(nextOffsetFor(SEARCH_PAGE_SIZE, 0)).toBeNull(); // 20 rows, no more
  });

  it("advances one page when the sentinel row is present and there is room under the cap", () => {
    expect(nextOffsetFor(SEARCH_PAGE_SIZE + 1, 0)).toBe(SEARCH_PAGE_SIZE); // 21 -> 20
  });

  it("advances to the last offset that still fits the cap", () => {
    // 180 + 20 = 200 = SEARCH_MAX_OFFSET, which is allowed (<=).
    expect(nextOffsetFor(SEARCH_PAGE_SIZE + 1, SEARCH_MAX_OFFSET - SEARCH_PAGE_SIZE)).toBe(
      SEARCH_MAX_OFFSET,
    );
  });

  it("returns null at the cap even when a sentinel row exists", () => {
    // 200 + 20 = 220 > SEARCH_MAX_OFFSET, so the next page is refused.
    expect(nextOffsetFor(SEARCH_PAGE_SIZE + 1, SEARCH_MAX_OFFSET)).toBeNull();
  });

  it("returns null for an empty result set", () => {
    expect(nextOffsetFor(0, 0)).toBeNull();
  });
});

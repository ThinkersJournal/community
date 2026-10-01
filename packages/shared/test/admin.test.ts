import { describe, expect, it } from "vitest";

import { SAME_ADMIN_HAND_CASES, sameAdminHand } from "../src";

/**
 * #98 — the JS side of the two-person rule. The SAME table is run through
 * the SQL side (approveMediaAccess + the 0016 CHECK) in
 * apps/api/test/media-restricted-route.test.ts, so a change to either side's
 * normalization breaks a test instead of silently diverging.
 */
describe("sameAdminHand — the shared case table", () => {
  it("the table has both arms (a same-hand case and a distinct-hands case)", () => {
    expect(SAME_ADMIN_HAND_CASES.some((c) => c.same)).toBe(true);
    expect(SAME_ADMIN_HAND_CASES.some((c) => !c.same)).toBe(true);
  });

  for (const { a, b, same } of SAME_ADMIN_HAND_CASES) {
    it(`${JSON.stringify(a)} vs ${JSON.stringify(b)} → ${same ? "same hand" : "two hands"} (both orders)`, () => {
      expect(sameAdminHand(a, b)).toBe(same);
      expect(sameAdminHand(b, a)).toBe(same);
    });
  }
});

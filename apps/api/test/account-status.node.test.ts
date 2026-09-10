import { describe, expect, it } from "vitest";

import { isBarred } from "../src/auth/account-status";

/**
 * Unit coverage for `isBarred` (src/auth/account-status.ts), issue #35.
 *
 * ⚠️ WHY A `.node.test.ts` (no DB, no workerd): `account-status.ts` is pure
 * TypeScript over two `Date | null` fields — no I/O, no binding. Running it
 * through the `pool` project would pay a full workerd + Postgres round trip
 * to exercise a function that touches neither; this runs in about a
 * millisecond instead. `test/login-barred.test.ts` (pool) still covers the
 * end-to-end route; this file covers the boundary logic in isolation.
 *
 * `now` is always passed explicitly so every case is deterministic — no
 * fixture here races the clock.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 1000);
const FUTURE = new Date(NOW.getTime() + 1000);

describe("isBarred", () => {
  it("a clean account (both columns null) is not barred", () => {
    expect(isBarred({ suspended_until: null, disabled_at: null }, NOW)).toBe(
      false,
    );
  });

  it("disabled_at set (permanent) bars the account", () => {
    expect(
      isBarred({ suspended_until: null, disabled_at: NOW }, NOW),
    ).toBe(true);
  });

  it("suspended_until in the future bars the account", () => {
    expect(
      isBarred({ suspended_until: FUTURE, disabled_at: null }, NOW),
    ).toBe(true);
  });

  it("suspended_until in the past does not bar the account — the suspension lapsed", () => {
    expect(
      isBarred({ suspended_until: PAST, disabled_at: null }, NOW),
    ).toBe(false);
  });

  // ⚠️ PINS THE `>` FROM account-status.ts:19. At the INSTANT a suspension
  // expires the user is free (see that file's docblock) — flipping this to
  // `>=` would still bar the account for the one instant `suspended_until`
  // equals `now`, and that flip is exactly the tidy-up this test exists to
  // catch.
  it("suspended_until === now exactly does not bar the account", () => {
    expect(
      isBarred(
        { suspended_until: new Date(NOW.getTime()), disabled_at: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("disabled_at set WITH a lapsed suspended_until still bars the account — the permanent bar wins", () => {
    expect(
      isBarred({ suspended_until: PAST, disabled_at: NOW }, NOW),
    ).toBe(true);
  });
});

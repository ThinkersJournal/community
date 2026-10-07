import { describe, expect, it } from "vitest";

import { classifyPostmark } from "../src/account-notices";

describe("classifyPostmark (PR 1; security-alerting spec §4.4)", () => {
  it.each([
    [{ ok: true } as const, "sent"],
    [{ ok: false, status: 422, errorCode: 300 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 406 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 10 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 412 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 1480 } as const, "transient"],
    [{ ok: false, status: 429, errorCode: null } as const, "transient"],
    [{ ok: false, status: 500, errorCode: null } as const, "transient"],
    [{ ok: false, status: null, errorCode: null } as const, "transient"],
  ])("%j → %s", (outcome, want) => {
    expect(classifyPostmark(outcome)).toBe(want);
  });
});

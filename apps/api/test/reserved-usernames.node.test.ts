import { describe, expect, it } from "vitest";

import { isReservedUsername } from "../src/auth/reserved-usernames";

describe("isReservedUsername", () => {
  it("reserves `guidelines`: /guidelines is a static page and a handle there would be unreachable", () => {
    expect(isReservedUsername("guidelines")).toBe(true);
  });
  it("control: an ordinary handle is not reserved", () => {
    expect(isReservedUsername("some-writer")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { suggestNextRung } from "../src";

/**
 * Spec §5: warn → suspend → ban, "proportionate to severity and history". The
 * suggestion is ADVISORY (a severe violation skips the ladder; the moderator
 * picks), so this only says where history alone points.
 */
const e = (action: "user_warn" | "user_suspend" | "user_ban" | "user_terminate", counts = true) => ({
  action,
  countsTowardEscalation: counts,
});

describe("suggestNextRung", () => {
  it("no history → warn", () => expect(suggestNextRung([])).toBe("warn"));
  it("a counted warning → suspend", () => expect(suggestNextRung([e("user_warn")])).toBe("suspend"));
  it("a counted suspension → ban", () => expect(suggestNextRung([e("user_warn"), e("user_suspend")])).toBe("ban"));
  it("history older than the window does not escalate", () =>
    expect(suggestNextRung([e("user_warn", false), e("user_suspend", false)])).toBe("warn"));
  it("a suspension outside the window but a warning inside → suspend", () =>
    expect(suggestNextRung([e("user_suspend", false), e("user_warn")])).toBe("suspend"));
});

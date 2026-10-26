// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import { fileCounterNotice, restoreDmcaNotice } from "../src/moderation/dmca-counter";

/**
 * Same Codacy finding as dmca-rollback-errors.test.ts (#253), for the counter-notice
 * and restore transactions: a failed ROLLBACK must be LOGGED and must never replace
 * the root error.
 */

function deadClient() {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.trim().split(/\s+/)[0] ?? "");
      if (/^ROLLBACK/i.test(sql.trim())) throw new Error("connection terminated");
      if (/FOR UPDATE/.test(sql)) throw new Error("root cause");
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client, statements };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DMCA counter-notice and restore: a failed ROLLBACK", () => {
  it.each([
    [
      "counter-notice",
      (c: never) =>
        fileCounterNotice(c, { token: "t", authorName: "a", authorAddress: "b", authorPhone: "c", signature: "d" }),
    ],
    ["restore", (c: never) => restoreDmcaNotice(c, { noticeId: "n", actorAdmin: "system", cause: "counter_notice", timer: true })],
  ])("%s: rethrows the ROOT error and logs the failed ROLLBACK", async (_name, run) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, statements } = deadClient();

    await expect(run(client as never)).rejects.toThrow("root cause");

    expect(statements.some((s) => /^ROLLBACK/i.test(s))).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("ROLLBACK");
  });
});

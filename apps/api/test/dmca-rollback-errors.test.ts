// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import { rejectDmcaNotice, takedownDmcaNotice } from "../src/moderation/dmca-decisions";

/**
 * Codacy (PR 253) flagged the DMCA decisions' ROLLBACK helper as an unhandled error
 * path: a failed ROLLBACK was swallowed with no trace. The root error must still win
 * (a dead connection must not replace it), and the failed ROLLBACK must now be LOGGED,
 * so a transaction left open by a dying connection is visible in the logs.
 */

/** A pg client whose first statement after BEGIN fails and whose ROLLBACK fails too. */
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

describe("DMCA decisions: a failed ROLLBACK", () => {
  it.each([
    ["takedown", (c: never) => takedownDmcaNotice(c, { noticeId: "n", actorAdmin: "a@example.test", origin: "https://x.test" })],
    ["reject", (c: never) => rejectDmcaNotice(c, { noticeId: "n", actorAdmin: "a@example.test", reason: "r" })],
  ])("%s: rethrows the ROOT error and logs the failed ROLLBACK", async (_name, run) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, statements } = deadClient();

    await expect(run(client as never)).rejects.toThrow("root cause");

    expect(statements.some((s) => /^ROLLBACK/i.test(s))).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("ROLLBACK");
  });
});

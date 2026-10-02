import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import {
  hasActiveAccountHold,
  imposeAccountHoldInTx,
  imposeManualAccountHold,
  listAccountHolds,
  releaseAccountHold,
} from "../src/moderation/account-holds";

/**
 * account-legal-hold spec (Task 2) — impose, release, list. Pool project:
 * real workerd + the test DB through HYPERDRIVE_FRESH, same as
 * account-actions.test.ts. `account_legal_holds` is append-only (the
 * release-only trigger), so every case uses FRESH RANDOM user ids and
 * asserts only over those ids, never a table-wide count.
 */
const madeUsers: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  // account_legal_holds has no FK on user_id (bare, by design) — deleting the
  // user never needs to touch the holds table, which couldn't be deleted anyway.
  if (madeUsers.length > 0) await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]));
  madeUsers.length = 0;
});

async function mkUser(): Promise<string> {
  const id = crypto.randomUUID();
  await ctxRun((c) =>
    c.query(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, 'h', now())`, [id, `${id}@holds.test`]),
  );
  madeUsers.push(id);
  return id;
}

async function holdsFor(userId: string) {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string; category: string; released_at: Date | null }>(
      `SELECT id, category, released_at FROM account_legal_holds WHERE user_id = $1`,
      [userId],
    );
    return rows;
  });
}

async function actionsFor(userId: string) {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ action: string; subject_label: string | null }>(
      `SELECT action, subject_label FROM moderation_actions WHERE subject_user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows;
  });
}

describe("imposeAccountHoldInTx", () => {
  it("creates a hold, and a second impose of the same category returns created: false with no new row (RF5)", async () => {
    const u = await mkUser();
    await ctxRun(async (c) => {
      await c.query("BEGIN");
      const first = await imposeAccountHoldInTx(c, { userId: u, category: "other", imposedBy: "system", reason: "r1" });
      expect(first.created).toBe(true);
      const second = await imposeAccountHoldInTx(c, { userId: u, category: "other", imposedBy: "system", reason: "r2" });
      expect(second.created).toBe(false);
      await c.query("COMMIT");
    });
    const rows = await holdsFor(u);
    expect(rows).toHaveLength(1);
  });
});

describe("imposeManualAccountHold", () => {
  it("created: exactly one account_hold log row, labeled with the handle not the email", async () => {
    const u = await mkUser();
    const out = await ctxRun((c) =>
      imposeManualAccountHold(c, { userId: u, subjectLabel: "some_handle", category: "dmca", imposedBy: "mod1@example.com", reason: "copyright" }),
    );
    expect(out.kind).toBe("created");

    const rows = await holdsFor(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("dmca");

    const actions = await actionsFor(u);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("account_hold");
    expect(actions[0]!.subject_label).toBe("some_handle");
    expect(actions[0]!.subject_label).not.toContain("@holds.test");
  });

  it("the same category again returns exists, with still one log row", async () => {
    const u = await mkUser();
    const first = await ctxRun((c) =>
      imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "dmca", imposedBy: "mod1@example.com", reason: "r" }),
    );
    expect(first.kind).toBe("created");
    const second = await ctxRun((c) =>
      imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "dmca", imposedBy: "mod2@example.com", reason: "r2" }),
    );
    expect(second.kind).toBe("exists");

    expect(await holdsFor(u)).toHaveLength(1);
    expect(await actionsFor(u)).toHaveLength(1);
  });

  it("an unknown user id returns not_found", async () => {
    const out = await ctxRun((c) =>
      imposeManualAccountHold(c, { userId: crypto.randomUUID(), subjectLabel: "h", category: "other", imposedBy: "mod1@example.com", reason: "r" }),
    );
    expect(out.kind).toBe("not_found");
  });

  it("concurrent: two calls on two clients → exactly one created, one exists, one hold, one log row (audit #8)", async () => {
    const u = await mkUser();
    const [a, b] = await Promise.all([
      ctxRun((c) => imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "other", imposedBy: "mod1@example.com", reason: "r1" })),
      ctxRun((c) => imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "other", imposedBy: "mod2@example.com", reason: "r2" })),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["created", "exists"]);

    expect(await holdsFor(u)).toHaveLength(1);
    expect(await actionsFor(u)).toHaveLength(1);
  });
});

describe("hasActiveAccountHold", () => {
  it("is true while a hold is active, then false after a release", async () => {
    const u = await mkUser();
    expect(await ctxRun((c) => hasActiveAccountHold(c, u))).toBe(false);

    const imposed = await ctxRun((c) =>
      imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "other", imposedBy: "mod1@example.com", reason: "r" }),
    );
    expect(imposed.kind).toBe("created");
    expect(await ctxRun((c) => hasActiveAccountHold(c, u))).toBe(true);

    const holdId = (await holdsFor(u))[0]!.id;
    const released = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: u, releasedBy: "mod2@example.com", reason: "resolved", subjectLabel: "h" }),
    );
    expect(released.kind).toBe("released");
    expect(await ctxRun((c) => hasActiveAccountHold(c, u))).toBe(false);
  });
});

describe("releaseAccountHold", () => {
  async function imposeOne(u: string, category: "dmca" | "other" | "csam", imposedBy: string) {
    if (category === "csam") {
      // Manual impose only allows "dmca" | "other"; insert the csam hold directly.
      const holdId = await ctxRun(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason) VALUES ($1, 'csam', $2, 'r') RETURNING id`,
          [u, imposedBy],
        );
        return rows[0]!.id;
      });
      return holdId;
    }
    const out = await ctxRun((c) =>
      imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category, imposedBy, reason: "r" }),
    );
    if (out.kind !== "created") throw new Error(`setup failed: ${out.kind}`);
    return out.holdId;
  }

  it("by a different admin → released, with a moderation_actions row of kind account_hold_release", async () => {
    const u = await mkUser();
    const holdId = await imposeOne(u, "dmca", "mod1@example.com");
    const out = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: u, releasedBy: "mod2@example.com", reason: "resolved", subjectLabel: "h" }),
    );
    expect(out.kind).toBe("released");
    const actions = await actionsFor(u);
    expect(actions.map((a) => a.action)).toContain("account_hold_release");
  });

  it("RF4: release by the imposer in different case → same_admin, with no change and no log row", async () => {
    const u = await mkUser();
    const holdId = await imposeOne(u, "dmca", "Mod@X");
    const out = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: u, releasedBy: "mod@x ", reason: "nope", subjectLabel: "h" }),
    );
    expect(out.kind).toBe("same_admin");

    const rows = await holdsFor(u);
    expect(rows[0]!.released_at).toBeNull();
    const actions = await actionsFor(u);
    expect(actions.map((a) => a.action)).not.toContain("account_hold_release");
  });

  it("a csam hold → csam", async () => {
    const u = await mkUser();
    const holdId = await imposeOne(u, "csam", "mod1@example.com");
    const out = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: u, releasedBy: "mod2@example.com", reason: "r", subjectLabel: "h" }),
    );
    expect(out.kind).toBe("csam");
  });

  it("an unknown id → not_found", async () => {
    const u = await mkUser();
    const out = await ctxRun((c) =>
      releaseAccountHold(c, { holdId: crypto.randomUUID(), userId: u, releasedBy: "mod2@example.com", reason: "r", subjectLabel: "h" }),
    );
    expect(out.kind).toBe("not_found");
  });

  it("a real hold id passed with a different userId → not_found, and the hold is unchanged (audit #7)", async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const holdId = await imposeOne(owner, "dmca", "mod1@example.com");
    const out = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: stranger, releasedBy: "mod2@example.com", reason: "r", subjectLabel: "h" }),
    );
    expect(out.kind).toBe("not_found");
    const rows = await holdsFor(owner);
    expect(rows[0]!.released_at).toBeNull();
  });

  it("a second release → already_released", async () => {
    const u = await mkUser();
    const holdId = await imposeOne(u, "dmca", "mod1@example.com");
    const first = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: u, releasedBy: "mod2@example.com", reason: "r", subjectLabel: "h" }),
    );
    expect(first.kind).toBe("released");
    const second = await ctxRun((c) =>
      releaseAccountHold(c, { holdId, userId: u, releasedBy: "mod3@example.com", reason: "r2", subjectLabel: "h" }),
    );
    expect(second.kind).toBe("already_released");
  });
});

describe("listAccountHolds", () => {
  it("newest first, with released rows included", async () => {
    const u = await mkUser();
    const holdId1 = await ctxRun(async (c) => {
      const out = await imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "dmca", imposedBy: "mod1@example.com", reason: "first" });
      if (out.kind !== "created") throw new Error("setup failed");
      return out.holdId;
    });
    await ctxRun((c) => releaseAccountHold(c, { holdId: holdId1, userId: u, releasedBy: "mod2@example.com", reason: "done", subjectLabel: "h" }));

    const holdId2 = await ctxRun(async (c) => {
      const out = await imposeManualAccountHold(c, { userId: u, subjectLabel: "h", category: "other", imposedBy: "mod1@example.com", reason: "second" });
      if (out.kind !== "created") throw new Error("setup failed");
      return out.holdId;
    });

    const list = await ctxRun((c) => listAccountHolds(c, u));
    expect(list.map((h) => h.id)).toEqual([holdId2, holdId1]);
    expect(list[1]!.releasedAt).not.toBeNull();
    expect(list[1]!.releasedBy).toBe("mod2@example.com");
    expect(list[0]!.releasedAt).toBeNull();
  });
});

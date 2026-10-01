import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { applyAccountAction, loadAccountHistory } from "../src/moderation/account-actions";

/**
 * #113 plan A, Task 1 — the account-action primitive (spec §5). Pool project:
 * real workerd + the test DB through HYPERDRIVE_FRESH, same as the route tests.
 */
const madeUsers: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  // moderation_actions has no FKs and is append-only: its rows stay, by design.
  if (madeUsers.length > 0) await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]));
  madeUsers.length = 0;
});

async function mkUser(): Promise<string> {
  const id = crypto.randomUUID();
  await ctxRun((c) =>
    c.query(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, 'h', now())`, [id, `${id}@accounts.test`]),
  );
  madeUsers.push(id);
  return id;
}

async function status(id: string) {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ suspended_until: Date | null; disabled_at: Date | null; disabled_reason: string | null }>(
      `SELECT suspended_until, disabled_at, disabled_reason FROM users WHERE id = $1`, [id],
    );
    return rows[0]!;
  });
}

async function actionsFor(id: string) {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ action: string; reason: string; action_expires_at: Date | null }>(
      `SELECT action, reason, action_expires_at FROM moderation_actions WHERE subject_user_id = $1 ORDER BY created_at`, [id],
    );
    return rows;
  });
}

/** Run the primitive on its own connection, as a route would. */
function apply(input: Parameters<typeof applyAccountAction>[1]) {
  return ctxRun((c) => applyAccountAction(c, input));
}

const base = { actorAdmin: "mod@example.test", subjectLabel: "someone" } as const;

describe("applyAccountAction", () => {
  it("warn: appends a user_warn row and changes no account state", async () => {
    const u = await mkUser();
    const out = await apply({ ...base, userId: u, kind: "warn", reason: "be kind" });
    expect(out.kind).toBe("applied");
    expect(await status(u)).toEqual({ suspended_until: null, disabled_at: null, disabled_reason: null });
    expect((await actionsFor(u)).map((a) => a.action)).toEqual(["user_warn"]);
  });

  it("suspend: sets suspended_until ≈ now + hours, and records the same end on the action", async () => {
    const u = await mkUser();
    const before = Date.now();
    const out = await apply({ ...base, userId: u, kind: "suspend", reason: "cool off", suspensionHours: 24 });
    expect(out.kind).toBe("applied");
    const s = await status(u);
    expect(s.suspended_until).not.toBeNull();
    const end = s.suspended_until!.getTime();
    expect(end).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 5_000);
    expect(end).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 5_000);
    const [a] = await actionsFor(u);
    expect(a!.action).toBe("user_suspend");
    expect(a!.action_expires_at!.getTime()).toBe(end);
  });

  it("⚠️ Review Focus 1: a shorter suspension never SHORTENS an existing longer one", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "suspend", reason: "long", suspensionHours: 720 });
    const long = (await status(u)).suspended_until!.getTime();
    await apply({ ...base, userId: u, kind: "suspend", reason: "short", suspensionHours: 24 });
    expect((await status(u)).suspended_until!.getTime()).toBe(long);
    // The log still records what the moderator asked for, and the effective end it produced.
    const rows = await actionsFor(u);
    expect(rows.map((r) => r.action)).toEqual(["user_suspend", "user_suspend"]);
    expect(rows[1]!.action_expires_at!.getTime()).toBe(long);
  });

  it("ban: sets disabled_at and disabled_reason = 'ban'", async () => {
    const u = await mkUser();
    expect((await apply({ ...base, userId: u, kind: "ban", reason: "done" })).kind).toBe("applied");
    const s = await status(u);
    expect(s.disabled_at).not.toBeNull();
    expect(s.disabled_reason).toBe("ban");
  });

  it("⚠️ Review Focus 2: warn/suspend/ban on a BANNED account is refused and writes NO log row", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "ban", reason: "first" });
    for (const kind of ["warn", "suspend", "ban"] as const) {
      const out = await apply({ ...base, userId: u, kind, reason: "again", suspensionHours: 24 });
      expect(out).toEqual({ kind: "already_disabled" });
    }
    expect((await actionsFor(u)).map((a) => a.action)).toEqual(["user_ban"]);
  });

  it("warn/suspend/ban on a TERMINATED account is refused the same way (already_disabled), with no log row", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "terminate", reason: "csam" });
    for (const kind of ["warn", "suspend", "ban"] as const) {
      expect(await apply({ ...base, userId: u, kind, reason: "again", suspensionHours: 24 })).toEqual({ kind: "already_disabled" });
    }
    expect((await actionsFor(u)).map((a) => a.action)).toEqual(["user_terminate"]);
  });

  it("terminate: allowed on a banned account; keeps the ORIGINAL disabled_at, upgrades the reason", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "ban", reason: "first" });
    const bannedAt = (await status(u)).disabled_at!.getTime();
    expect((await apply({ ...base, userId: u, kind: "terminate", reason: "csam" })).kind).toBe("applied");
    const s = await status(u);
    expect(s.disabled_at!.getTime()).toBe(bannedAt);
    expect(s.disabled_reason).toBe("terminate");
  });

  it("a nonexistent user is not_found and writes no log row", async () => {
    const ghost = crypto.randomUUID();
    expect(await apply({ ...base, userId: ghost, kind: "warn", reason: "x" })).toEqual({ kind: "not_found" });
    expect(await actionsFor(ghost)).toEqual([]);
  });

  it("the state change and the log row commit together: a log failure leaves the account untouched", async () => {
    const u = await mkUser();
    // An over-long violation_category violates moderation_actions' CHECK, so the INSERT fails AFTER the UPDATE.
    await expect(
      apply({ ...base, userId: u, kind: "ban", reason: "x", violationCategory: "not-a-category" as never }),
    ).rejects.toThrow(/violation_category/);
    expect(await status(u)).toEqual({ suspended_until: null, disabled_at: null, disabled_reason: null });
  });
});

describe("loadAccountHistory", () => {
  it("lists only user_* actions for that user, newest first, flagging those inside the 12-month window", async () => {
    const u = await mkUser();
    await ctxRun((c) => c.query(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason, created_at)
       VALUES ('m', 'user_warn', $1, 'old', now() - interval '13 months'),
              ('m', 'user_warn', $1, 'recent', now() - interval '1 day'),
              ('m', 'content_remove', $1, 'not an account action', now())`,
      [u],
    ));
    const h = await ctxRun((c) => loadAccountHistory(c, u));
    expect(h.map((x) => [x.reason, x.countsTowardEscalation])).toEqual([
      ["recent", true],
      ["old", false],
    ]);
  });
});

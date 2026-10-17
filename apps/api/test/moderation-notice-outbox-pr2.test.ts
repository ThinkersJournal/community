import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { applyAccountAction } from "../src/moderation/account-actions";
import { enqueueAppealOutcomeNotice, enqueueReporterOutcomeNotices } from "../src/moderation/notice-enqueue";

import type { Client } from "pg";

/**
 * Notice outbox PR 2 — the enqueue functions for kinds 3-5, against the real
 * database. The route-level behaviour (queued in the transaction, drained by
 * the cron) is covered in admin-accounts-route, appeal-resolve and
 * admin-decision-route.
 */
const ORIGIN = "https://community.test";
const userIds: string[] = [];
const actionIds: string[] = [];

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function mkUser(anonymised = false): Promise<string> {
  const id = crypto.randomUUID();
  await run((c) =>
    c.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at, anonymised_at)
       VALUES ($1, $2, 'h', now(), ${anonymised ? "now()" : "NULL"})`,
      [id, `${id}@outbox-pr2.test`],
    ),
  );
  userIds.push(id);
  return id;
}

interface Row {
  kind: string;
  recipient_user_id: string | null;
  recipient_email: string | null;
  dsa_notice_id: string | null;
}

async function rowsFor(actionId: string): Promise<Row[]> {
  return run(async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT kind, recipient_user_id, recipient_email, dsa_notice_id
         FROM moderation_notice_outbox WHERE action_id = $1 ORDER BY dsa_notice_id`,
      [actionId],
    );
    return rows;
  });
}

afterEach(async () => {
  await run(async (c) => {
    await c.query(`DELETE FROM moderation_notice_outbox WHERE action_id = ANY($1::uuid[])`, [actionIds]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  });
  actionIds.length = 0;
  userIds.length = 0;
});

describe("enqueueReporterOutcomeNotices", () => {
  const base = { decision: "remove", reason: "Confirmed violation.", subject: "post", postTitle: "A title" } as const;

  it("queues one row per resolved DSA notice (two reporters on one ruling), storing each address, and a retry adds nothing", async () => {
    const actionId = crypto.randomUUID();
    actionIds.push(actionId);
    const n1 = crypto.randomUUID();
    const n2 = crypto.randomUUID();
    const reporters = [
      { email: "one@reporters.test", noticeId: n1 },
      { email: "two@reporters.test", noticeId: n2 },
    ];

    await run((c) => enqueueReporterOutcomeNotices(c, { actionId, reporters, ...base }));
    const rows = await rowsFor(actionId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recipient_email).sort()).toEqual(["one@reporters.test", "two@reporters.test"]);
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "reporter_outcome", recipient_user_id: null });
    }
    expect(rows.map((r) => r.dsa_notice_id).sort()).toEqual([n1, n2].sort());

    // The retry is a no-op because of the index, not because the call did nothing: same call, same two rows.
    await run((c) => enqueueReporterOutcomeNotices(c, { actionId, reporters, ...base }));
    expect(await rowsFor(actionId)).toHaveLength(2);
  });

  it("no resolved notice, no row", async () => {
    const actionId = crypto.randomUUID();
    actionIds.push(actionId);
    await run((c) => enqueueReporterOutcomeNotices(c, { actionId, reporters: [], ...base }));
    expect(await rowsFor(actionId)).toHaveLength(0);
  });
});

describe("enqueueAppealOutcomeNotice", () => {
  it("queues a row for a live appellant, keyed by the RESOLUTION action, with no address stored", async () => {
    const appellantId = await mkUser();
    const resolutionActionId = crypto.randomUUID();
    actionIds.push(resolutionActionId);
    expect(await run((c) => enqueueAppealOutcomeNotice(c, { resolutionActionId, appellantId, outcome: "granted", reason: "fine" }))).toBe(true);
    const rows = await rowsFor(resolutionActionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "appeal_outcome", recipient_user_id: appellantId, recipient_email: null, dsa_notice_id: null });
  });

  it("an anonymised appellant (B3) and a vanished one queue nothing", async () => {
    const gone = await mkUser(true);
    const a1 = crypto.randomUUID();
    const a2 = crypto.randomUUID();
    actionIds.push(a1, a2);
    expect(await run((c) => enqueueAppealOutcomeNotice(c, { resolutionActionId: a1, appellantId: gone, outcome: "denied", reason: "no" }))).toBe(false);
    expect(await run((c) => enqueueAppealOutcomeNotice(c, { resolutionActionId: a2, appellantId: crypto.randomUUID(), outcome: "denied", reason: "no" }))).toBe(false);
    expect(await rowsFor(a1)).toHaveLength(0);
    expect(await rowsFor(a2)).toHaveLength(0);
  });
});

describe("account actions through applyAccountAction", () => {
  const input = { actorAdmin: "mod@example.test", subjectLabel: "someone", reason: "r", enqueueNotice: { origin: ORIGIN } } as const;

  async function applied(userId: string, kind: "warn" | "ban" | "terminate"): Promise<string> {
    const out = await run((c) => applyAccountAction(c, { ...input, userId, kind }));
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") throw new Error("not applied");
    actionIds.push(out.actionId);
    return out.actionId;
  }

  it("queues the notice in the action's own transaction", async () => {
    const userId = await mkUser();
    const actionId = await applied(userId, "warn");
    const rows = await rowsFor(actionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "account_action", recipient_user_id: userId, recipient_email: null });
  });

  it("an anonymised account: the action applies, nothing is queued and no token is minted", async () => {
    const userId = await mkUser(true);
    const actionId = await applied(userId, "warn");
    expect(await rowsFor(actionId)).toHaveLength(0);
    const tokens = await run(async (c) => (await c.query(`SELECT 1 FROM moderation_action_tokens WHERE action_id = $1`, [actionId])).rowCount);
    expect(tokens).toBe(0);
  });

  it("terminate queues nothing (its notice is #114's own route)", async () => {
    const userId = await mkUser();
    const actionId = await applied(userId, "terminate");
    expect(await rowsFor(actionId)).toHaveLength(0);
  });

  it("without enqueueNotice nothing is queued (control: the same call WITH it queues)", async () => {
    const withIt = await applied(await mkUser(), "ban");
    expect(await rowsFor(withIt)).toHaveLength(1);
    const userId = await mkUser();
    const out = await run((c) => applyAccountAction(c, { actorAdmin: "mod@example.test", subjectLabel: "s", reason: "r", userId, kind: "ban" }));
    if (out.kind !== "applied") throw new Error("not applied");
    actionIds.push(out.actionId);
    expect(await rowsFor(out.actionId)).toHaveLength(0);
  });
});

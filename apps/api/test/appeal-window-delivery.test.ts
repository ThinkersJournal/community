import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withClient } from "../src/db/client";
import { applyAccountAction } from "../src/moderation/account-actions";
import { describeAppealTarget, fileAppeal } from "../src/moderation/appeals";
import { drainNoticeOutbox } from "../src/moderation/notice-outbox";

import { APPEAL_WINDOW_DAYS, MODERATION_NOTICE_RETENTION_DAYS, NOTICE_UNDELIVERABLE_HORIZON_DAYS } from "@thinkersjournal/shared";

import type { Client } from "pg";

/**
 * Notice outbox PR 4 — the appeal window starts at DELIVERY (design section 5).
 * `fileAppeal` / `describeAppealTarget` read the notice row; a decision with no
 * notice row keeps the old rule (decision + window).
 */
const userIds: string[] = [];
const actionIds: string[] = [];
let sent: Array<Record<string, unknown>> = [];

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "https://api.postmarkapp.com/email") throw new Error("unexpected fetch");
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "t" }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(async () => {
  await run(async (c) => {
    await c.query(`DELETE FROM moderation_notice_outbox WHERE action_id = ANY($1::uuid[])`, [actionIds]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  });
  actionIds.length = 0;
  userIds.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mkUser(): Promise<string> {
  const id = crypto.randomUUID();
  await run((c) => c.query(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, 'h', now())`, [id, `${id}@window.test`]));
  userIds.push(id);
  return id;
}

/** A `user_warn` created `ageDays` ago. */
async function mkAction(userId: string, ageDays: number): Promise<string> {
  const id = await run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason, created_at)
       VALUES ('mod', 'user_warn', $1, 'r', now() - make_interval(days => $2::int)) RETURNING id`,
      [userId, ageDays],
    );
    return rows[0]!.id;
  });
  actionIds.push(id);
  return id;
}

interface NoticeRow {
  readonly state: "pending" | "sending" | "delivered" | "undeliverable";
  readonly kind?: string;
  /** Days AGO the notice was delivered (state delivered only). */
  readonly deliveredDaysAgo?: number;
  /** Days FROM NOW the row is purged (negative = already past). */
  readonly retainInDays?: number;
}

async function mkNotice(userId: string, actionId: string, n: NoticeRow): Promise<void> {
  await run((c) =>
    c.query(
      `INSERT INTO moderation_notice_outbox
              (action_id, kind, recipient_user_id, subject, body_text, body_html, state, delivered_at, retain_until)
       VALUES ($1, $2, $3, 's', 't', '<p>t</p>', $4,
               CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
               now() + make_interval(days => $6::int))`,
      [actionId, n.kind ?? "account_action", userId, n.state, n.deliveredDaysAgo ?? null, n.retainInDays ?? 300],
    ),
  );
}

const file = (userId: string, actionId: string) => run((c) => fileAppeal(c, { actionId, appellantId: userId, body: "I disagree." }));
const target = (actionId: string) => run((c) => describeAppealTarget(c, actionId));
const DAY = 86_400_000;

describe("the appeal window starts at delivery", () => {
  it("a notice delivered 20 days ago keeps a 40-day-old decision appealable, and the page says delivered_at + window", async () => {
    const u = await mkUser();
    const a = await mkAction(u, 40); // the OLD rule (decision + 30 d) would have closed it 10 days ago
    await mkNotice(u, a, { state: "delivered", deliveredDaysAgo: 20 });

    const t = await target(a);
    const closes = new Date(t!.windowClosesAt).getTime();
    expect(Math.abs(closes - (Date.now() + (APPEAL_WINDOW_DAYS - 20) * DAY))).toBeLessThan(3_600_000 * 2);
    expect((await file(u, a)).kind).toBe("filed");
  });

  it("a notice delivered 31 days ago has closed the window, even though the decision is newer than the notice's own horizon", async () => {
    const u = await mkUser();
    const a = await mkAction(u, 35);
    await mkNotice(u, a, { state: "delivered", deliveredDaysAgo: APPEAL_WINDOW_DAYS + 1 });
    expect(await file(u, a)).toEqual({ kind: "window_closed" });
  });

  it("control: a RECENT decision with a notice delivered long ago is closed by the delivery, not kept open by the decision date", async () => {
    const u = await mkUser();
    const a = await mkAction(u, 2);
    await mkNotice(u, a, { state: "delivered", deliveredDaysAgo: APPEAL_WINDOW_DAYS + 5 });
    expect(await file(u, a)).toEqual({ kind: "window_closed" });
  });

  it.each(["pending", "sending", "undeliverable"] as const)(
    "a %s notice has not started the window: a 100-day-old decision is still appealable until the record is purged",
    async (state) => {
      const u = await mkUser();
      const a = await mkAction(u, 100);
      await mkNotice(u, a, { state, retainInDays: MODERATION_NOTICE_RETENTION_DAYS - 100 });
      const t = await target(a);
      expect(Math.abs(new Date(t!.windowClosesAt).getTime() - (Date.now() + (MODERATION_NOTICE_RETENTION_DAYS - 100) * DAY))).toBeLessThan(3_600_000 * 2);
      expect((await file(u, a)).kind).toBe("filed");
    },
  );

  it("an undeliverable notice whose record is past retention no longer holds the window open", async () => {
    const u = await mkUser();
    const a = await mkAction(u, 400);
    await mkNotice(u, a, { state: "undeliverable", retainInDays: -1 });
    expect(await file(u, a)).toEqual({ kind: "window_closed" });
  });

  it("no notice row: the old rule (decision + window) still applies, both ways", async () => {
    const u = await mkUser();
    const old = await mkAction(u, APPEAL_WINDOW_DAYS + 1);
    const fresh = await mkAction(u, 1);
    expect(await file(u, old)).toEqual({ kind: "window_closed" });
    expect((await file(u, fresh)).kind).toBe("filed");
  });

  it("only the notices that carry the appeal open a window: a delivered appeal-outcome row does not", async () => {
    const u = await mkUser();
    const a = await mkAction(u, 1);
    await mkNotice(u, a, { state: "delivered", kind: "appeal_outcome", deliveredDaysAgo: APPEAL_WINDOW_DAYS + 10 });
    expect((await file(u, a)).kind).toBe("filed");
  });
});

describe("the drain shortens a delivered notice's links to delivered_at + window", () => {
  it("a link is minted for horizon + window, and delivery cuts it to the window; a spent link is untouched", async () => {
    const userId = await mkUser();
    const out = await run((c) =>
      applyAccountAction(c, { userId, kind: "ban", reason: "r", actorAdmin: "mod@example.test", subjectLabel: "x", enqueueNotice: { origin: "https://community.test" } }),
    );
    if (out.kind !== "applied") throw new Error("not applied");
    actionIds.push(out.actionId);

    const days = async (purpose: string) =>
      run(async (c) => {
        const { rows } = await c.query<{ d: number }>(
          `SELECT EXTRACT(EPOCH FROM (expires_at - now())) / 86400 AS d FROM moderation_action_tokens WHERE action_id = $1 AND purpose = $2`,
          [out.actionId, purpose],
        );
        return Number(rows[0]!.d);
      });

    const provisional = NOTICE_UNDELIVERABLE_HORIZON_DAYS + APPEAL_WINDOW_DAYS;
    expect(await days("appeal")).toBeGreaterThan(provisional - 0.1);
    expect(await days("appeal")).toBeLessThanOrEqual(provisional);
    // Spend the delete-request link: delivery must not touch a used token.
    await run((c) => c.query(`UPDATE moderation_action_tokens SET used_at = now() WHERE action_id = $1 AND purpose = 'delete_request'`, [out.actionId]));

    const ctx = createExecutionContext();
    await drainNoticeOutbox(env, ctx, { onlyActionIds: [out.actionId] });
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(1);

    expect(await days("appeal")).toBeGreaterThan(APPEAL_WINDOW_DAYS - 0.1);
    expect(await days("appeal")).toBeLessThanOrEqual(APPEAL_WINDOW_DAYS);
    expect(await days("delete_request"), "a spent link keeps its expiry").toBeGreaterThan(provisional - 0.1);
  });
});

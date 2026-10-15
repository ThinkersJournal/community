import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { purgeExpiredNoticeRecords, recordNotice } from "../src/moderation/notice-records";
import { MODERATION_NOTICE_RETENTION_DAYS } from "@thinkersjournal/shared";

/**
 * #57 Q9 — the stored text of a sent moderation notice and its purge.
 * Runs in the POOL project against the real Hyperdrive/Postgres binding.
 * `moderation_actions` is append-only (0013), so the action rows seeded here
 * are left behind; the records are removed in afterEach.
 */
const rendered = { subject: "S", textBody: "text <b>", htmlBody: "<p>html</p>" };
const created: string[] = [];

async function run<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function seedAction(): Promise<{ id: string; createdAt: Date }> {
  const r = await run((c) =>
    c.query<{ id: string; created_at: Date }>(
      `INSERT INTO moderation_actions (actor_admin, action, reason)
       VALUES ('probe@example.com', 'content_remove', 'because') RETURNING id, created_at`,
    ),
  );
  created.push(r.rows[0]!.id);
  return { id: r.rows[0]!.id, createdAt: r.rows[0]!.created_at };
}

async function readRecord(actionId: string) {
  return (
    await run((c) =>
      c.query<{ kind: string; subject: string; body_text: string; body_html: string | null; retain_until: Date }>(
        "SELECT kind, subject, body_text, body_html, retain_until FROM moderation_notice_records WHERE action_id = $1",
        [actionId],
      ),
    )
  ).rows;
}

afterEach(async () => {
  if (created.length === 0) return;
  await run((c) => c.query("DELETE FROM moderation_notice_records WHERE action_id = ANY($1::uuid[])", [created]));
  created.length = 0;
});

describe("recordNotice", () => {
  it("stores the rendered strings and retain_until = the decision's created_at + the retention constant", async () => {
    const a = await seedAction();
    const ctx = createExecutionContext();
    await recordNotice(env, ctx, a.id, "author", rendered);
    await waitOnExecutionContext(ctx);
    const rows = await readRecord(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "author", subject: "S", body_text: "text <b>", body_html: "<p>html</p>" });
    const expected = a.createdAt.getTime() + MODERATION_NOTICE_RETENTION_DAYS * 86_400_000;
    // Day arithmetic in SQL is timezone-sensitive across DST; allow one hour.
    expect(Math.abs(rows[0]!.retain_until.getTime() - expected)).toBeLessThanOrEqual(3_600_000);
  });

  it("is idempotent per action: a second write does not duplicate or overwrite", async () => {
    const a = await seedAction();
    const ctx = createExecutionContext();
    await recordNotice(env, ctx, a.id, "account", rendered);
    await recordNotice(env, ctx, a.id, "account", { ...rendered, subject: "other" });
    await waitOnExecutionContext(ctx);
    const rows = await readRecord(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe("S");
  });

  it("NEVER THROWS on a database error (malformed action id)", async () => {
    const ctx = createExecutionContext();
    await expect(recordNotice(env, ctx, "not-a-uuid", "author", rendered)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});

describe("purgeExpiredNoticeRecords", () => {
  async function seedRecord(retainOffsetDays: number): Promise<string> {
    const a = await seedAction();
    await run((c) =>
      c.query(
        `INSERT INTO moderation_notice_records (action_id, kind, subject, body_text, retain_until)
         VALUES ($1, 'author', 's', 't', now() + make_interval(days => $2::int))`,
        [a.id, retainOffsetDays],
      ),
    );
    return a.id;
  }

  it("deletes only rows past retain_until", async () => {
    const past = await seedRecord(-1);
    const future = await seedRecord(1);
    const ctx = createExecutionContext();
    const n = await purgeExpiredNoticeRecords(env, ctx);
    await waitOnExecutionContext(ctx);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await readRecord(past)).toHaveLength(0);
    expect(await readRecord(future)).toHaveLength(1);
  });

  it('is run by the scheduled dispatcher on cron "30 3 * * *"', async () => {
    const past = await seedRecord(-1);
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "30 3 * * *", scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await readRecord(past)).toHaveLength(0);
  });
});

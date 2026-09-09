import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordModerationAction } from "../src/moderation/actions";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
beforeAll(async () => { client = new Client({ connectionString: TEST_DATABASE_URL }); await client.connect(); });
afterAll(async () => { await client.end(); });

describe("recordModerationAction", () => {
  it("writes a row and returns its id", async () => {
    const id = await recordModerationAction(client, {
      actorAdmin: "mod@example.com",
      action: "user_warn",
      reason: "first warning",
      violationCategory: "spam",
    });
    const { rows } = await client.query<{ actor_admin: string; action: string; violation_category: string }>(
      `SELECT actor_admin, action, violation_category FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_admin).toBe("mod@example.com");
    expect(rows[0]!.action).toBe("user_warn");
    expect(rows[0]!.violation_category).toBe("spam");
  });

  it("persists action_expires_at for a suspension", async () => {
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const id = await recordModerationAction(client, {
      actorAdmin: "mod@example.com", action: "user_suspend",
      reason: "7 day suspension", actionExpiresAt: expires,
    });
    const { rows } = await client.query<{ action_expires_at: Date }>(
      `SELECT action_expires_at FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows[0]!.action_expires_at.getTime()).toBeCloseTo(expires.getTime(), -3);
  });

  it("leaves optional columns NULL when not supplied", async () => {
    const id = await recordModerationAction(client, {
      actorAdmin: "system", action: "content_restore", reason: "restored on review",
    });
    const { rows } = await client.query<{ post_id: string | null; internal_note: string | null }>(
      `SELECT post_id, internal_note FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows[0]!.post_id).toBeNull();
    expect(rows[0]!.internal_note).toBeNull();
  });
});

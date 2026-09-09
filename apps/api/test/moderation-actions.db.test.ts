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

  // ⚠️ FULL COLUMN COVERAGE. Every one of the 10 writable columns gets its own
  // DISTINCT, DISTINGUISHABLE value here (distinct uuids for the three uuid
  // columns — reusing one across post_id/comment_id/subject_user_id would let
  // a transposition among THEM stay invisible) and every one is read back and
  // asserted. `moderation_actions` is append-only (migration 0013's trigger
  // refuses UPDATE and DELETE), so a wrong value written by a future
  // transposition in `recordModerationAction`'s INSERT can never be corrected
  // — this test exists so that transposition fails CI instead of shipping.
  it("round-trips ALL TEN columns with distinct values, catching a column transposition", async () => {
    const postId = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    const subjectUserId = crypto.randomUUID();
    // action & violationCategory: valid, DISTINCT values from migration
    // 0013's CHECK lists — chosen so neither string could be mistaken for
    // the other if the INSERT's column order slipped.
    const action = "user_ban" as const;
    const violationCategory = "harassment" as const;
    const actionExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const actorAdmin = "full-coverage-actor@example.com";
    const subjectLabel = "full-coverage-subject-label";
    const reason = "full-coverage-reason-text";
    const internalNote = "full-coverage-internal-note-text";

    const id = await recordModerationAction(client, {
      actorAdmin,
      action,
      postId,
      commentId,
      subjectUserId,
      subjectLabel,
      violationCategory,
      actionExpiresAt,
      reason,
      internalNote,
    });

    const { rows } = await client.query<{
      actor_admin: string;
      action: string;
      post_id: string;
      comment_id: string;
      subject_user_id: string;
      subject_label: string;
      violation_category: string;
      action_expires_at: Date;
      reason: string;
      internal_note: string;
    }>(
      `SELECT actor_admin, action, post_id, comment_id, subject_user_id, subject_label,
              violation_category, action_expires_at, reason, internal_note
         FROM moderation_actions WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_admin).toBe(actorAdmin);
    expect(row.action).toBe(action);
    expect(row.post_id).toBe(postId);
    expect(row.comment_id).toBe(commentId);
    expect(row.subject_user_id).toBe(subjectUserId);
    expect(row.subject_label).toBe(subjectLabel);
    expect(row.violation_category).toBe(violationCategory);
    expect(row.action_expires_at.getTime()).toBeCloseTo(actionExpiresAt.getTime(), -3);
    expect(row.reason).toBe(reason);
    expect(row.internal_note).toBe(internalNote);
  });
});

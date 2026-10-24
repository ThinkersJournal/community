// SPDX-License-Identifier: MIT OR Apache-2.0
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0033 (security alerting): `moderation_actions` accepts
 * `security_ref_resolved` with no subject, still accepts every earlier kind,
 * and still refuses an unknown kind.
 * Node project, direct `pg`, against TEST_DATABASE_URL (the dedicated DB).
 */
// ⚠️ NO DEFAULT (audit M-1): run only with TEST_DATABASE_URL set to the dedicated
// test database (the plan's "Testing realities"), never the shared one.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let client: Client;

/** 0030's list (the latest before 0033): every one must stay valid (additive). */
const EARLIER_KINDS = [
  "content_restore", "content_keep_hidden", "content_remove",
  "user_warn", "user_suspend", "user_ban", "user_terminate",
  "appeal_granted", "appeal_denied", "media_access",
  "author_hide", "author_unhide",
  "account_hold", "account_hold_release",
  "content_auto_hide",
] as const;

beforeAll(async () => {
  if (TEST_DATABASE_URL === undefined) throw new Error("TEST_DATABASE_URL is not set: refusing to pick a database");
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("moderation_actions accepts security_ref_resolved (spec §2.6 R4)", () => {
  it("inserts a row with the ref in internal_note and NO subject_user_id", async () => {
    const ref = "0123456789abcdef0123456789abcdef";
    const { rows } = await client.query<{ subject_user_id: string | null; internal_note: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, reason, internal_note)
       VALUES ('admin@example.test', 'security_ref_resolved', 'Security alert reference looked up by an administrator', $1)
       RETURNING subject_user_id, internal_note`,
      [ref],
    );
    expect(rows[0]).toEqual({ subject_user_id: null, internal_note: ref });
  });

  it("is a strict superset: every kind 0030 allowed is still in the live constraint", async () => {
    const { rows } = await client.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'moderation_actions_action_check'",
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]?.def ?? "";
    for (const kind of [...EARLIER_KINDS, "security_ref_resolved"]) expect(def, kind).toContain(`'${kind}'::text`);
  });

  it("still refuses an unknown kind (control: the constraint is live)", async () => {
    await expect(
      client.query(
        "INSERT INTO moderation_actions (actor_admin, action, reason) VALUES ('a@example.test', 'security_ref_resolvedX', 'r')",
      ),
    ).rejects.toThrow(/moderation_actions_action_check/);
  });
});

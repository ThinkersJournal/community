import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const madeUsers: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterEach(async () => {
  if (madeUsers.length > 0) await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
  madeUsers.length = 0;
});
afterAll(async () => {
  await client.end();
});

async function mkUser(): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')`, [id, `${id}@appeals.test`]);
  madeUsers.push(id);
  return id;
}

async function mkAction(userId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason) VALUES ('m', 'user_warn', $1, 'r') RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

describe("appeals", () => {
  it("one appeal per action", async () => {
    const u = await mkUser();
    const a = await mkAction(u);
    await client.query(`INSERT INTO appeals (appellant_id, action_id, body) VALUES ($1, $2, 'x')`, [u, a]);
    await expect(client.query(`INSERT INTO appeals (appellant_id, action_id, body) VALUES ($1, $2, 'y')`, [u, a])).rejects.toThrow(
      /appeals_one_per_action/,
    );
  });

  it("refuses a blank body", async () => {
    const u = await mkUser();
    await expect(
      client.query(`INSERT INTO appeals (appellant_id, action_id, body) VALUES ($1, $2, '   ')`, [u, await mkAction(u)]),
    ).rejects.toThrow(/appeals_body_check/);
  });

  it("outcome is only granted/denied, and set exactly when resolved", async () => {
    const u = await mkUser();
    const a = await mkAction(u);
    await expect(
      client.query(`INSERT INTO appeals (appellant_id, action_id, body, outcome) VALUES ($1, $2, 'x', 'granted')`, [u, a]),
    ).rejects.toThrow(/appeals_resolution_consistent/);
  });
});

describe("moderation_action_tokens", () => {
  it("purpose is appeal or delete_request only", async () => {
    const u = await mkUser();
    await expect(
      client.query(
        `INSERT INTO moderation_action_tokens (action_id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'both', 'h1', now())`,
        [await mkAction(u), u],
      ),
    ).rejects.toThrow(/moderation_action_tokens_purpose_check/);
  });

  it("token_hash is unique", async () => {
    const u = await mkUser();
    const a = await mkAction(u);
    const h = randomUUID();
    await client.query(
      `INSERT INTO moderation_action_tokens (action_id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'appeal', $3, now())`,
      [a, u, h],
    );
    await expect(
      client.query(
        `INSERT INTO moderation_action_tokens (action_id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'delete_request', $3, now())`,
        [a, u, h],
      ),
    ).rejects.toThrow(/moderation_action_tokens_token_hash_key/);
  });
});

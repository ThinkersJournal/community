import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { consumeActionToken, mintActionToken, peekActionToken } from "../src/moderation/action-tokens";

const madeUsers: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  if (madeUsers.length > 0) await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]));
  madeUsers.length = 0;
});

async function fixture(): Promise<{ userId: string; actionId: string }> {
  return ctxRun(async (c) => {
    const userId = crypto.randomUUID();
    await c.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')`, [userId, `${userId}@tokens.test`]);
    madeUsers.push(userId);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason) VALUES ('m', 'user_ban', $1, 'r') RETURNING id`,
      [userId],
    );
    return { userId, actionId: rows[0]!.id };
  });
}

/** Mint, asserting a token came back (the account is live in every caller). */
async function mint(f: { userId: string; actionId: string }, purpose: "appeal" | "delete_request", ttlMs: number): Promise<string> {
  const token = await ctxRun((c) => mintActionToken(c, { ...f, purpose, ttlMs }));
  expect(token).not.toBeNull();
  return token!;
}

/** Stand-in for the scrub's own `anonymised_at` write (auth/anonymise-accounts.ts). */
async function markAnonymised(userId: string): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [userId]));
}

/** Consume inside a transaction, as every route does (the users-row lock lives until COMMIT). */
async function consumeInTx(token: string, purpose: "appeal" | "delete_request") {
  return ctxRun(async (c) => {
    await c.query("BEGIN");
    const t = await consumeActionToken(c, token, purpose);
    await c.query("COMMIT");
    return t;
  });
}

const HOUR = 3600_000;

describe("moderation action tokens", () => {
  it("mint → peek (any number of times) → consume once → consumed", async () => {
    const f = await fixture();
    const token = await mint(f, "appeal", HOUR);
    for (let i = 0; i < 3; i++) {
      expect(await ctxRun((c) => peekActionToken(c, token, "appeal"))).toEqual(f);
    }
    expect(await consumeInTx(token, "appeal")).toEqual(f);
    expect(await consumeInTx(token, "appeal")).toBeNull();
    expect(await ctxRun((c) => peekActionToken(c, token, "appeal"))).toBeNull();
  });

  it("⚠️ Review Focus 1: the wrong purpose neither peeks nor consumes — and leaves the token live", async () => {
    const f = await fixture();
    const token = await mint(f, "appeal", HOUR);
    expect(await ctxRun((c) => peekActionToken(c, token, "delete_request"))).toBeNull();
    expect(await consumeInTx(token, "delete_request")).toBeNull();
    expect(await consumeInTx(token, "appeal")).toEqual(f);
  });

  it("an expired token neither peeks nor consumes", async () => {
    const f = await fixture();
    const token = await mint(f, "appeal", -1);
    expect(await ctxRun((c) => peekActionToken(c, token, "appeal"))).toBeNull();
    expect(await consumeInTx(token, "appeal")).toBeNull();
  });

  it("an unknown token is null, and only the hash is stored", async () => {
    const f = await fixture();
    const token = await mint(f, "appeal", HOUR);
    expect(await ctxRun((c) => peekActionToken(c, "not-a-token", "appeal"))).toBeNull();
    const stored = await ctxRun(async (c) => (await c.query(`SELECT token_hash FROM moderation_action_tokens WHERE user_id = $1`, [f.userId])).rows);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("⚠️ B3: an anonymised account's existing token neither peeks nor consumes, and stays unspent", async () => {
    const f = await fixture();
    const token = await mint(f, "appeal", HOUR);
    // Control: the same token peeks while the account is live.
    expect(await ctxRun((c) => peekActionToken(c, token, "appeal"))).toEqual(f);
    await markAnonymised(f.userId);
    expect(await ctxRun((c) => peekActionToken(c, token, "appeal"))).toBeNull();
    expect(await consumeInTx(token, "appeal")).toBeNull();
    const { rows } = await ctxRun((c) =>
      c.query<{ used_at: Date | null }>(`SELECT used_at FROM moderation_action_tokens WHERE user_id = $1`, [f.userId]),
    );
    expect(rows).toEqual([{ used_at: null }]);
  });

  it("⚠️ B3: mint returns null, and inserts nothing, for an anonymised account", async () => {
    const f = await fixture();
    await markAnonymised(f.userId);
    expect(await ctxRun((c) => mintActionToken(c, { ...f, purpose: "appeal", ttlMs: HOUR }))).toBeNull();
    const { rows } = await ctxRun((c) =>
      c.query(`SELECT 1 FROM moderation_action_tokens WHERE user_id = $1`, [f.userId]),
    );
    expect(rows).toHaveLength(0);
  });
});

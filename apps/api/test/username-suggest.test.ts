import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";

import { candidateHandles, suggestUsernames } from "../src/auth/username-suggest";
import { withClient } from "../src/db/client";

it("candidateHandles yields valid, non-reserved, length-capped variants", () => {
  const c = candidateHandles("ada");
  expect(c).toContain("ada2");
  expect(c.every((h) => /^[a-z0-9_]{3,30}$/.test(h))).toBe(true);
  expect(candidateHandles("me")).not.toContain("me"); // base too short is not returned as-is
  // a 30-char base still yields <=30-char suggestions
  expect(candidateHandles("a".repeat(30)).every((h) => h.length <= 30)).toBe(true);
});

it("suggestUsernames returns only AVAILABLE variants", async () => {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (client) => {
    // seed: create a user+profile holding "sugbase2" so it is excluded. The
    // test DB is a persistent, shared Postgres instance (not per-test-isolated
    // like the pool's KV) — `profiles.username` is hardcoded (it must be one of
    // `candidateHandles("sugbase")`'s outputs), so the row is deleted below
    // (cascades user -> profile) to keep reruns collision-free.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`sug-${crypto.randomUUID()}@e.com`],
    );
    const userId = rows[0]!.id;
    try {
      await client.query(`INSERT INTO profiles (user_id, username) VALUES ($1,'sugbase2')`, [userId]);
      const out = await suggestUsernames(client, "sugbase");
      expect(out).not.toContain("sugbase2");
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((h) => /^[a-z0-9_]{3,30}$/.test(h))).toBe(true);
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
  await waitOnExecutionContext(ctx);
});

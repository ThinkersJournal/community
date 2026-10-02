import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BACKFILL_TERMINATED_HOLDS_SQL } from "../src/moderation/account-holds";

/**
 * account_legal_holds (migration 0022, account-legal-hold spec §2/§3).
 *
 * Mirrors moderation-snapshots-schema.db.test.ts's style: every refusal below
 * has a control that the same statement succeeds when the guard should allow
 * it. The table is append-only by trigger (release-only UPDATE, no DELETE, no
 * TRUNCATE), so rows written here can never be cleaned up — every case uses
 * FRESH RANDOM ids and asserts only over those ids, never a table-wide count
 * (the local test DB is shared with parallel files).
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

async function insertHold(
  userId: string,
  category: "csam" | "dmca" | "other",
  opts?: { reason?: string; imposedBy?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, category, opts?.imposedBy ?? "admin@example.com", opts?.reason ?? "r"],
  );
  return rows[0]!.id;
}

async function makeUser(opts?: { disabledReason?: string }): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, disabled_reason)
     VALUES ($1, 'x', $2) RETURNING id`,
    [`ahs-${randomUUID()}@example.com`, opts?.disabledReason ?? null],
  );
  return rows[0]!.id;
}

describe("account_legal_holds — release-only trigger (spec §2)", () => {
  it("an UPDATE that sets released_at/released_by/release_reason on an active dmca hold succeeds", async () => {
    const userId = randomUUID();
    const id = await insertHold(userId, "dmca");
    await client.query(
      `UPDATE account_legal_holds
          SET released_at = now(), released_by = 'admin2@example.com', release_reason = 'resolved'
        WHERE id = $1`,
      [id],
    );
    const { rows } = await client.query<{ released_at: Date | null }>(
      `SELECT released_at FROM account_legal_holds WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.released_at).not.toBeNull();
  });

  it("refuses an UPDATE of a non-release column", async () => {
    const userId = randomUUID();
    const id = await insertHold(userId, "dmca");
    await expect(
      client.query(`UPDATE account_legal_holds SET reason = 'changed' WHERE id = $1`, [id]),
    ).rejects.toThrow(/only released_at\/released_by\/release_reason may change/);
  });

  it("refuses an UPDATE of an already-released row", async () => {
    const userId = randomUUID();
    const id = await insertHold(userId, "dmca");
    await client.query(
      `UPDATE account_legal_holds
          SET released_at = now(), released_by = 'admin2@example.com', release_reason = 'resolved'
        WHERE id = $1`,
      [id],
    );
    await expect(
      client.query(
        `UPDATE account_legal_holds
            SET released_at = now(), released_by = 'admin3@example.com', release_reason = 'again'
          WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/a released hold is final/);
  });

  it("refuses a DELETE", async () => {
    const userId = randomUUID();
    const id = await insertHold(userId, "dmca");
    await expect(
      client.query(`DELETE FROM account_legal_holds WHERE id = $1`, [id]),
    ).rejects.toThrow(/account_legal_holds is append-only/);
  });

  it("refuses a TRUNCATE (statement-level)", async () => {
    const userId = randomUUID();
    await insertHold(userId, "dmca");
    await expect(client.query(`TRUNCATE account_legal_holds`)).rejects.toThrow(
      /account_legal_holds is append-only/,
    );
  });

  it("refuses releasing a csam hold (account_legal_holds_csam_never_released)", async () => {
    const userId = randomUUID();
    const id = await insertHold(userId, "csam");
    await expect(
      client.query(
        `UPDATE account_legal_holds
            SET released_at = now(), released_by = 'admin2@example.com', release_reason = 'nope'
          WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "account_legal_holds_csam_never_released" });
  });

  it("refuses setting only released_at without released_by/release_reason (account_legal_holds_release_consistent)", async () => {
    const userId = randomUUID();
    const id = await insertHold(userId, "dmca");
    await expect(
      client.query(`UPDATE account_legal_holds SET released_at = now() WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "account_legal_holds_release_consistent" });
  });

  it("refuses two active holds of the same category for one user (account_legal_holds_active_idx); CONTROL: succeeds again after release", async () => {
    const userId = randomUUID();
    const id1 = await insertHold(userId, "other");
    await expect(insertHold(userId, "other")).rejects.toMatchObject({
      code: "23505",
      constraint: "account_legal_holds_active_idx",
    });

    await client.query(
      `UPDATE account_legal_holds
          SET released_at = now(), released_by = 'admin2@example.com', release_reason = 'done'
        WHERE id = $1`,
      [id1],
    );
    // CONTROL: the same category succeeds again after the first is released.
    const id2 = await insertHold(userId, "other");
    expect(id2).not.toBe(id1);
  });

  it("ON CONFLICT ... DO NOTHING on an active duplicate inserts 0 rows without error", async () => {
    const userId = randomUUID();
    await insertHold(userId, "dmca");
    const result = await client.query(
      `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
       VALUES ($1, 'dmca', 'admin@example.com', 'dup')
       ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING`,
      [userId],
    );
    expect(result.rowCount).toBe(0);
  });
});

describe("moderation_actions — account hold kinds (migration 0022)", () => {
  it("accepts account_hold and account_hold_release", async () => {
    const subject = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason)
       VALUES ('admin@example.com', 'account_hold', $1, 'r') RETURNING id`,
      [subject],
    );
    expect(rows).toHaveLength(1);
    const { rows: rows2 } = await client.query<{ id: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason)
       VALUES ('admin@example.com', 'account_hold_release', $1, 'r') RETURNING id`,
      [subject],
    );
    expect(rows2).toHaveLength(1);
  });
});

describe("users.reserved_email_sha256 (spec §4a)", () => {
  it("refuses a non-hex value (users_reserved_email_sha256_hex)", async () => {
    // Anonymised first, so `users_reserved_email_only_anonymised` doesn't also
    // fire and mask which CHECK is under test.
    const userId = await makeUser();
    await client.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [userId]);
    await expect(
      client.query(`UPDATE users SET reserved_email_sha256 = 'not-hex' WHERE id = $1`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "users_reserved_email_sha256_hex" });
  });

  it("refuses a 64-hex value on a row with anonymised_at IS NULL; CONTROL: accepted on an anonymised row", async () => {
    const hash = "a".repeat(64);
    const liveUser = await makeUser();
    await expect(
      client.query(`UPDATE users SET reserved_email_sha256 = $2 WHERE id = $1`, [liveUser, hash]),
    ).rejects.toMatchObject({ code: "23514", constraint: "users_reserved_email_only_anonymised" });

    // CONTROL: the same value on an anonymised row is accepted.
    const anonymisedUser = await makeUser();
    await client.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [anonymisedUser]);
    await client.query(`UPDATE users SET reserved_email_sha256 = $2 WHERE id = $1`, [anonymisedUser, hash]);
    const { rows } = await client.query<{ reserved_email_sha256: string | null }>(
      `SELECT reserved_email_sha256 FROM users WHERE id = $1`,
      [anonymisedUser],
    );
    expect(rows[0]!.reserved_email_sha256).toBe(hash);
  });

  it("two anonymised rows may hold the same hash (the index is deliberately not unique)", async () => {
    const hash = "b".repeat(64);
    const userA = await makeUser();
    const userB = await makeUser();
    await client.query(`UPDATE users SET anonymised_at = now() WHERE id = ANY($1)`, [[userA, userB]]);
    await client.query(`UPDATE users SET reserved_email_sha256 = $2 WHERE id = $1`, [userA, hash]);
    await client.query(`UPDATE users SET reserved_email_sha256 = $2 WHERE id = $1`, [userB, hash]);
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM users WHERE reserved_email_sha256 = $1 AND id = ANY($2)`,
      [hash, [userA, userB]],
    );
    expect(rows[0]!.n).toBe("2");
  });
});

describe("backfill (AH-5): BACKFILL_TERMINATED_HOLDS_SQL holds every terminated account and no plain-banned one", () => {
  it("imposes exactly one csam hold, system-imposed, for the terminated user; none for the banned user; idempotent on a second run", async () => {
    const terminatedUser = await makeUser({ disabledReason: "terminate" });
    const bannedUser = await makeUser({ disabledReason: "ban" });

    await client.query("BEGIN");
    try {
      await client.query(BACKFILL_TERMINATED_HOLDS_SQL);
      await client.query(BACKFILL_TERMINATED_HOLDS_SQL);

      const { rows } = await client.query<{
        user_id: string;
        category: string;
        imposed_by: string;
      }>(
        `SELECT user_id, category, imposed_by FROM account_legal_holds
          WHERE user_id = ANY($1)`,
        [[terminatedUser, bannedUser]],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.user_id).toBe(terminatedUser);
      expect(rows[0]!.category).toBe("csam");
      expect(rows[0]!.imposed_by).toBe("system");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

describe("BACKFILL_TERMINATED_HOLDS_SQL stays byte-identical to the migration (Step 3)", () => {
  it("the migration file contains the exact constant", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const migrationPath = fileURLToPath(
      new URL("../migrations/0022_account_legal_holds.sql", import.meta.url),
    );
    const migrationText = readFileSync(migrationPath, "utf8").replace(/\r/g, "");
    const constantText = BACKFILL_TERMINATED_HOLDS_SQL.replace(/\r/g, "");
    expect(migrationText).toContain(constantText);
  });
});

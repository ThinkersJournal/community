import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function insertOne(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO moderation_actions (actor_admin, action, reason)
     VALUES ('probe@example.com', 'content_restore', 'because') RETURNING id`,
  );
  return rows[0]!.id;
}

describe("moderation_actions (0013)", () => {
  it("has the expected columns with the expected nullability", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'moderation_actions'`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(byName.get("id")).toBe("NO");
    expect(byName.get("actor_admin")).toBe("NO");
    expect(byName.get("action")).toBe("NO");
    expect(byName.get("reason")).toBe("NO");
    expect(byName.get("created_at")).toBe("NO");
    for (const nullable of [
      "post_id", "comment_id", "subject_user_id", "subject_label",
      "violation_category", "action_expires_at", "internal_note",
    ]) {
      expect(byName.get(nullable), `${nullable} must be nullable`).toBe("YES");
    }
  });

  it("⚠️ has NO foreign keys — the log must outlive its subjects", async () => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = 'moderation_actions'
          AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(
      Number(rows[0]!.n),
      "An FK with ON DELETE SET NULL performs an UPDATE on this table, which the immutability trigger refuses — that makes posts and users UNDELETABLE and breaks GDPR erasure.",
    ).toBe(0);
  });

  it("rejects an unknown action value", async () => {
    await expect(
      client.query(
        `INSERT INTO moderation_actions (actor_admin, action, reason)
         VALUES ('probe@example.com', 'not_a_real_action', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown violation_category", async () => {
    await expect(
      client.query(
        `INSERT INTO moderation_actions (actor_admin, action, reason, violation_category)
         VALUES ('probe@example.com', 'user_warn', 'x', 'not_a_category')`,
      ),
    ).rejects.toThrow();
  });

  // ⚠️ AC-2 (spec §12), BINDING. A guard never shown to fire is not a guard.
  describe("AC-2 — the append-only trigger actually fires", () => {
    it("REJECTS an UPDATE", async () => {
      const id = await insertOne();
      await expect(
        client.query(`UPDATE moderation_actions SET reason = 'tampered' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it("REJECTS a DELETE", async () => {
      const id = await insertOne();
      await expect(
        client.query(`DELETE FROM moderation_actions WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it("still ALLOWS an INSERT (control — the table is not simply broken)", async () => {
      const id = await insertOne();
      const { rows } = await client.query(`SELECT id FROM moderation_actions WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });
  });
});

describe("moderation_actions Art. 17 columns (0029)", () => {
  it("defaults territorial_scope to 'global' and leaves source / dsa_notice_id NULL", async () => {
    const id = await insertOne();
    const { rows } = await client.query<{ source: string | null; dsa_notice_id: string | null; territorial_scope: string }>(
      `SELECT source, dsa_notice_id, territorial_scope FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows[0]).toEqual({ source: null, dsa_notice_id: null, territorial_scope: "global" });
  });

  it("rejects an unknown source, an unknown scope, and a notice id without source 'dsa_notice'", async () => {
    const ins = (cols: string, vals: string): Promise<unknown> =>
      client.query(`INSERT INTO moderation_actions (actor_admin, action, reason, ${cols})
                    VALUES ('p@example.com', 'content_restore', 'r', ${vals})`);
    await expect(ins("source", "'gossip'")).rejects.toThrow(/moderation_actions_source_valid/);
    await expect(ins("territorial_scope", "'mars'")).rejects.toThrow(/moderation_actions_territorial_scope_valid/);
    await expect(ins("dsa_notice_id", `'${crypto.randomUUID()}'`)).rejects.toThrow(/moderation_actions_notice_needs_source/);
    await expect(ins("source, dsa_notice_id", `'member_report', '${crypto.randomUUID()}'`)).rejects.toThrow(/moderation_actions_notice_needs_source/);
    await expect(ins("source, dsa_notice_id", `'dsa_notice', '${crypto.randomUUID()}'`)).resolves.toBeDefined();
  });
});

describe("moderation_actions grounds columns (0031)", () => {
  it("leaves legal_ground and contractual_ground NULL when omitted", async () => {
    const id = await insertOne();
    const { rows } = await client.query<{ legal_ground: string | null; contractual_ground: string | null }>(
      `SELECT legal_ground, contractual_ground FROM moderation_actions WHERE id = $1`, [id],
    );
    expect(rows[0]).toEqual({ legal_ground: null, contractual_ground: null });
  });

  it("rejects an unknown value in either column, and accepts a listed one", async () => {
    const ins = (cols: string, vals: string): Promise<unknown> =>
      client.query(`INSERT INTO moderation_actions (actor_admin, action, reason, ${cols})
                    VALUES ('p@example.com', 'content_remove', 'r', ${vals})`);
    await expect(ins("legal_ground", "'treason'")).rejects.toThrow(/moderation_actions_legal_ground_valid/);
    await expect(ins("contractual_ground", "'vibes'")).rejects.toThrow(/moderation_actions_contractual_ground_valid/);
    await expect(ins("legal_ground, contractual_ground", "'csam', 'guidelines_spam'")).resolves.toBeDefined();
  });
});

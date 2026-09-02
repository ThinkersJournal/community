import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let userA: string;
let userB: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`blocks-${crypto.randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  userA = await makeUser();
  userB = await makeUser();
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1)", [[userA, userB]]);
  await client.end();
});

describe("blocks schema", () => {
  it("has expected columns and types", async () => {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'blocks'`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    expect(byName.get("id")?.data_type).toBe("uuid");
    expect(byName.get("blocker_id")?.data_type).toBe("uuid");
    expect(byName.get("blocker_id")?.is_nullable).toBe("NO");
    expect(byName.get("blocked_id")?.data_type).toBe("uuid");
    expect(byName.get("blocked_id")?.is_nullable).toBe("NO");
    expect(byName.get("created_at")?.data_type).toBe("timestamp with time zone");
    expect(byName.get("created_at")?.is_nullable).toBe("NO");
  });

  it("blocker_id and blocked_id are FKs to users.id", async () => {
    const { rows: fks } = await client.query(
      `SELECT kcu.column_name AS fk_column,
              ccu.table_name  AS ref_table,
              ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema    = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema    = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema    = 'public'
          AND tc.table_name      = 'blocks'
        ORDER BY kcu.column_name`,
    );

    expect(fks).toEqual([
      { fk_column: "blocked_id", ref_table: "users", ref_column: "id" },
      { fk_column: "blocker_id", ref_table: "users", ref_column: "id" },
    ]);
  });

  it("assigns a uuidv7 id (version nibble 7)", async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) RETURNING id",
      [userA, userB],
    );
    expect(rows[0]!.id[14]).toBe("7");
    await client.query("DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2", [userA, userB]);
  });

  it("rejects a self-block (CHECK violation 23514, blocks_no_self)", async () => {
    await expect(
      client.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$1)", [userA]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a duplicate (blocker,blocked) pair (unique violation 23505, blocks_pair_unique)", async () => {
    await client.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)", [userA, userB]);
    await expect(
      client.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)", [userA, userB]),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2", [userA, userB]);
  });

  it("cascade-deletes a block when either user is deleted", async () => {
    const temp = await makeUser();
    await client.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)", [userA, temp]);
    await client.query("DELETE FROM users WHERE id = $1", [temp]);
    const { rows } = await client.query(
      "SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2",
      [userA, temp],
    );
    expect(rows).toHaveLength(0);
  });
});

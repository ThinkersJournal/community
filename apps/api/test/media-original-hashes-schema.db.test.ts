import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * media.original_md5 / original_sha1 / original_sha256 (migration 0027,
 * #114 Task 12). Nullable lowercase-hex CHECKs; existing rows stay NULL (the
 * originals are gone, so there is nothing to backfill).
 *
 * Every refusal has a control that the same statement succeeds with a valid
 * value. Rows are owned by fresh random users and removed afterwards.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const userIds: string[] = [];

async function newUser(): Promise<string> {
  const id = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [
    id,
    `${id}@orig-hashes.test`,
  ]);
  userIds.push(id);
  return id;
}

async function insertMedia(owner: string, extra: Record<string, string | null> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const names = ["owner_id", "r2_key", "sha256", "bytes", "width", "height", ...cols];
  const params = [owner, `k-${randomUUID()}`, "s", 1, 1, 1, ...cols.map((c) => extra[c])];
  await client.query(
    `INSERT INTO media (${names.join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})`,
    params,
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe("media.original_* hashes", () => {
  it("are nullable text columns", async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'media' AND column_name LIKE 'original\\_%' ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: "original_md5", data_type: "text", is_nullable: "YES" },
      { column_name: "original_sha1", data_type: "text", is_nullable: "YES" },
      { column_name: "original_sha256", data_type: "text", is_nullable: "YES" },
    ]);
  });

  it("a plain insert (as every pre-existing row) leaves all three NULL — no backfill", async () => {
    const owner = await newUser();
    await insertMedia(owner);
    const { rows } = await client.query(
      "SELECT original_md5, original_sha1, original_sha256 FROM media WHERE owner_id = $1",
      [owner],
    );
    expect(rows).toEqual([{ original_md5: null, original_sha1: null, original_sha256: null }]);
  });

  it("CONTROL: accepts lowercase hex of exactly the right length, in all three at once", async () => {
    const owner = await newUser();
    await expect(
      insertMedia(owner, {
        original_md5: "a".repeat(32),
        original_sha1: "b".repeat(40),
        original_sha256: "c".repeat(64),
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["original_md5", 32],
    ["original_sha1", 40],
    ["original_sha256", 64],
  ] as const)("%s rejects wrong length, uppercase, non-hex and empty", async (col, len) => {
    const owner = await newUser();
    for (const bad of ["a".repeat(len - 1), "a".repeat(len + 1), "A".repeat(len), "g".repeat(len), ""]) {
      await expect(insertMedia(owner, { [col]: bad }), `${col}=${JSON.stringify(bad)}`).rejects.toThrow(
        /check constraint/,
      );
    }
    // Control: the right length of lowercase hex passes for the same column.
    await expect(insertMedia(owner, { [col]: "a".repeat(len) })).resolves.toBeUndefined();
  });
});

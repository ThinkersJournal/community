import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The upload-scan schema (migration 0027; upload-scan design §4.2, §4.4, §6.6,
 * task US4). Schema only: nothing writes these columns yet, so they stay NULL.
 *
 * Every refusal has a control that the same statement succeeds when valid.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const userIds: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.query("DELETE FROM media_scan_backfill WHERE r2_key LIKE 'scan-schema-test-%'");
  await client.query("DELETE FROM upload_scan_outcomes WHERE reason LIKE 'scan-schema-test-%'");
  await client.end();
});

async function newMedia(extra: Record<string, string | number | null> = {}): Promise<void> {
  const owner = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [
    owner,
    `${owner}@scan-schema.test`,
  ]);
  userIds.push(owner);
  const cols = Object.keys(extra);
  const names = ["owner_id", "r2_key", "sha256", "bytes", "width", "height", ...cols];
  const params = [owner, `k-${randomUUID()}`, "s", 1, 1, 1, ...cols.map((c) => extra[c])];
  await client.query(
    `INSERT INTO media (${names.join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})`,
    params,
  );
}

async function columns(table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

describe("media scan columns (§4.2)", () => {
  it("exist, all nullable, with the specified types", async () => {
    const { rows } = await client.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'media' AND column_name IN
          ('pdq','pdq_quality','pdq_source','scan_path','scan_list_version','scanned_at')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: "pdq", data_type: "text", is_nullable: "YES" },
      { column_name: "pdq_quality", data_type: "smallint", is_nullable: "YES" },
      { column_name: "pdq_source", data_type: "text", is_nullable: "YES" },
      { column_name: "scan_list_version", data_type: "text", is_nullable: "YES" },
      { column_name: "scan_path", data_type: "text", is_nullable: "YES" },
      { column_name: "scanned_at", data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
  });

  it("a plain insert leaves every scan column NULL", async () => {
    await newMedia();
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM media
        WHERE owner_id = ANY($1::uuid[])
          AND pdq IS NULL AND pdq_quality IS NULL AND pdq_source IS NULL
          AND scan_path IS NULL AND scan_list_version IS NULL AND scanned_at IS NULL`,
      [userIds],
    );
    // Control: the same predicate is not vacuous — at least the row just inserted matches.
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
    const { rows: nonNull } = await client.query(
      `SELECT count(*)::int AS n FROM media
        WHERE owner_id = ANY($1::uuid[])
          AND (pdq IS NOT NULL OR pdq_quality IS NOT NULL OR pdq_source IS NOT NULL
               OR scan_path IS NOT NULL OR scan_list_version IS NOT NULL OR scanned_at IS NOT NULL)`,
      [userIds],
    );
    expect(nonNull[0]!.n).toBe(0);
  });

  it("CONTROL: fully valid scan results are accepted", async () => {
    await expect(
      newMedia({
        pdq: "f".repeat(64),
        pdq_quality: 100,
        pdq_source: "stored_webp",
        scan_path: "media",
        scan_list_version: "v1",
        scanned_at: "2026-10-08T00:00:00Z",
      }),
    ).resolves.toBeUndefined();
    await expect(
      newMedia({ pdq: "0".repeat(64), pdq_quality: 0, pdq_source: "original", scan_path: "hash" }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["pdq", "a".repeat(63)],
    ["pdq", "a".repeat(65)],
    ["pdq", "A".repeat(64)],
    ["pdq", "z".repeat(64)],
    ["pdq_quality", -1],
    ["pdq_quality", 101],
    ["pdq_source", "webp"],
    ["pdq_source", ""],
    ["scan_path", "both"],
    ["scan_path", ""],
  ] as const)("rejects %s = %j", async (col, bad) => {
    await expect(newMedia({ [col]: bad })).rejects.toThrow(/check constraint/);
  });

  it("media_original_sha256_idx is a NON-unique partial index on original_sha256", async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'media_original_sha256_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).not.toMatch(/UNIQUE/i);
    expect(rows[0]!.indexdef).toMatch(/\(original_sha256\)/);
    expect(rows[0]!.indexdef).toMatch(/WHERE \(original_sha256 IS NOT NULL\)/);
    // Several uploads of identical bytes share one original hash.
    const h = "d".repeat(64);
    await expect(newMedia({ original_sha256: h })).resolves.toBeUndefined();
    await expect(newMedia({ original_sha256: h })).resolves.toBeUndefined();
  });
});

describe("upload_scan_outcomes (§6.6, I12)", () => {
  it("has EXACTLY the pinned column list: no user id, hash or classification", async () => {
    expect(await columns("upload_scan_outcomes")).toEqual(
      ["at", "case_id", "id", "latency_ms", "outcome", "reason", "scan_path"].sort(),
    );
  });

  it("has the (at) index", async () => {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'upload_scan_outcomes' AND indexname = 'upload_scan_outcomes_at'",
    );
    expect(rows).toHaveLength(1);
  });

  it("accepts scanned/unavailable and rejects any other outcome or scan_path", async () => {
    const ins = (outcome: string, path: string | null) =>
      client.query(
        "INSERT INTO upload_scan_outcomes (outcome, reason, scan_path) VALUES ($1, 'scan-schema-test-x', $2)",
        [outcome, path],
      );
    await expect(ins("scanned", "hash")).resolves.toBeDefined();
    await expect(ins("unavailable", null)).resolves.toBeDefined();
    await expect(ins("matched", null)).rejects.toThrow(/check constraint/);
    await expect(ins("scanned", "both")).rejects.toThrow(/check constraint/);
  });
});

describe("media_scan_backfill (§4.4)", () => {
  const insert = (key: string, status: string) =>
    client.query("INSERT INTO media_scan_backfill (r2_key, status) VALUES ($1, $2)", [
      `scan-schema-test-${key}`,
      status,
    ]);

  it("status accepts only its five values", async () => {
    for (const s of ["clean", "matched", "unscannable", "failed", "needs_review"]) {
      await expect(insert(`${s}-${randomUUID()}`, s), s).resolves.toBeDefined();
    }
    for (const s of ["pending", "CLEAN", "", "done"]) {
      await expect(insert(`bad-${randomUUID()}`, s), s).rejects.toThrow(/check constraint/);
    }
  });

  it("has its defaults (uuidv7 id, attempts 0) and r2_key is the primary key", async () => {
    const key = `scan-schema-test-defaults-${randomUUID()}`;
    const { rows } = await client.query<{ id: string; attempts: number }>(
      "INSERT INTO media_scan_backfill (r2_key, status) VALUES ($1, 'clean') RETURNING id, attempts",
      [key],
    );
    expect(rows[0]!.id[14]).toBe("7");
    expect(rows[0]!.attempts).toBe(0);
    await expect(
      client.query("INSERT INTO media_scan_backfill (r2_key, status) VALUES ($1, 'clean')", [key]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("has exactly the specified columns", async () => {
    expect(await columns("media_scan_backfill")).toEqual(
      [
        "attempts",
        "case_id",
        "id",
        "next_try_at",
        "r2_key",
        "reviewed_at",
        "reviewed_by",
        "status",
        "updated_at",
      ].sort(),
    );
  });
});

describe("media_scan_backfill_progress (§4.4)", () => {
  it("has exactly the specified columns", async () => {
    expect(await columns("media_scan_backfill_progress")).toEqual(
      ["completed_at", "id", "last_id", "target_id"].sort(),
    );
  });

  it("is a singleton (id must be true) and target_id is required — in a rolled-back transaction", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SAVEPOINT a");
      await expect(
        client.query("INSERT INTO media_scan_backfill_progress (id, target_id) VALUES (false, $1)", [randomUUID()]),
      ).rejects.toThrow(/check constraint/);
      await client.query("ROLLBACK TO SAVEPOINT a");
      await client.query("SAVEPOINT b");
      await expect(
        client.query("INSERT INTO media_scan_backfill_progress (target_id) VALUES (NULL)"),
      ).rejects.toThrow(/not-null/);
      await client.query("ROLLBACK TO SAVEPOINT b");
      // Control: the valid singleton row goes in (rolled back below), a second does not.
      await client.query("INSERT INTO media_scan_backfill_progress (target_id) VALUES ($1)", [randomUUID()]);
      await client.query("SAVEPOINT c");
      await expect(
        client.query("INSERT INTO media_scan_backfill_progress (target_id) VALUES ($1)", [randomUUID()]),
      ).rejects.toThrow(/duplicate key/);
      await client.query("ROLLBACK TO SAVEPOINT c");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

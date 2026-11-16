// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GC_BATCH, GC_RETENTION_MS, gcOrphanReferences } from "../src/references/gc";

/**
 * gcOrphanReferences (M3.2d): deletes `"references"` rows that no `post_references` row uses, once they are older than
 * the retention year. Every row sits in the year 2000 and `now` is in 2000 too, so rows other test files leave are never
 * old enough to be touched here.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const NOW = new Date("2000-06-01T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

let client: Client;
const referenceIds: string[] = [];
const postIds: string[] = [];
const userIds: string[] = [];

async function seed(opts: { created?: Date; updated?: Date; snapshot?: object | null } = {}): Promise<string> {
  const created = opts.created ?? ago(GC_RETENTION_MS + 60_000);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, created_at, updated_at, snapshot)
     VALUES ('web', $1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [
      `web:https://example.com/${randomUUID()}`,
      randomUUID(),
      created,
      opts.updated ?? created,
      opts.snapshot === null ? null : JSON.stringify(opts.snapshot ?? { title: "t" }),
    ],
  );
  referenceIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function use(referenceId: string): Promise<void> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-gc.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `g${uid.replace(/-/g, "").slice(0, 20)}`]);
  const post = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source) VALUES ($1, $2, 'A title', 'body') RETURNING id`,
    [uid, `s-${randomUUID()}`],
  );
  postIds.push(post.rows[0]!.id);
  await client.query(`INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, 'AAAAAAAAAAAA')`, [
    post.rows[0]!.id,
    referenceId,
  ]);
}

async function exists(id: string): Promise<boolean> {
  const { rowCount } = await client.query(`SELECT 1 FROM "references" WHERE id = $1`, [id]);
  return rowCount === 1;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query(`DELETE FROM posts WHERE id = ANY($1::uuid[])`, [postIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  await client.end();
});

describe("gcOrphanReferences", () => {
  it("deletes an unused reference past the retention year and returns the count", async () => {
    const orphan = await seed();
    const n = await gcOrphanReferences(client, NOW);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await exists(orphan)).toBe(false);
  });

  it("keeps a reference some post uses, however old (mutation: drop the NOT EXISTS)", async () => {
    const used = await seed();
    await use(used);
    await gcOrphanReferences(client, NOW);
    expect(await exists(used)).toBe(true);
  });

  it("keeps an unused reference inside the retention year, by created_at or by a recent re-resolve (updated_at)", async () => {
    const fresh = await seed({ created: ago(GC_RETENTION_MS - 60_000) });
    const reResolved = await seed({ updated: ago(GC_RETENTION_MS - 60_000) });
    // created long ago, touched recently by an attach upsert
    await client.query(`UPDATE "references" SET created_at = $2 WHERE id = $1`, [reResolved, ago(GC_RETENTION_MS * 10)]);
    await gcOrphanReferences(client, NOW);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(reResolved)).toBe(true);
  });

  it("deletes a row whose only use was removed with its post (the cascade leaves an orphan)", async () => {
    const ref = await seed();
    await use(ref);
    await client.query(`DELETE FROM posts WHERE id = ANY($1::uuid[])`, [postIds]);
    await gcOrphanReferences(client, NOW);
    expect(await exists(ref)).toBe(false);
  });

  it("deletes an old orphan whatever its snapshot: a NULL or JSON-null snapshot is no reason to keep it (retention is the 1-year floor, evidence lives in moderation_snapshots)", async () => {
    const sqlNull = await seed({ snapshot: null });
    const jsonNull = await seed();
    await client.query(`UPDATE "references" SET snapshot = 'null'::jsonb WHERE id = $1`, [jsonNull]);
    await gcOrphanReferences(client, NOW);
    expect(await exists(sqlNull)).toBe(false);
    expect(await exists(jsonNull)).toBe(false);
  });

  it("keeps an orphan until a full year untouched: 364 days survives, a year and a minute goes (mutation: shorter window)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const young = await seed({ created: ago(364 * day) });
    const old = await seed({ created: ago(365 * day + 60_000) });
    await gcOrphanReferences(client, NOW);
    expect(GC_RETENTION_MS).toBe(365 * day);
    expect(await exists(young)).toBe(true);
    expect(await exists(old)).toBe(false);
  });

  it("deletes at most GC_BATCH rows per call", async () => {
    expect(GC_BATCH).toBeGreaterThan(0);
    const ids: string[] = [];
    for (let i = 0; i < GC_BATCH + 3; i += 1) ids.push(await seed());
    const n = await gcOrphanReferences(client, NOW);
    expect(n).toBe(GC_BATCH);
    const { rows } = await client.query(`SELECT 1 FROM "references" WHERE id = ANY($1::uuid[])`, [ids]);
    expect(rows.length).toBe(3);
    await gcOrphanReferences(client, NOW);
  });
});

import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearMediaOwnerForAnonymisedUser, clearMediaOwnersOfAnonymisedUsers } from "../src/media/owner-clearing";

/**
 * The ownership-clearing rule (migration 0035; src/media/owner-clearing.ts;
 * design 2026-10-16-media-ownership-records-design.md section 5).
 *
 * Node project, direct pg connection to the shared fixture DB. Every case uses
 * FRESH RANDOM users and keys and asserts only over its own rows: the DB is
 * shared with parallel files, so a table-wide count proves nothing. Cleared
 * rows have no owner, so the users' cascade can no longer remove them: they
 * are deleted explicitly by id.
 */
/** Larger than any backlog the shared DB can hold, so a sweep always reaches this file's rows. */
const ALL = 100_000;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const userIds: string[] = [];
const mediaIds: string[] = [];
const heldKeys: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM media WHERE id = ANY($1::uuid[])", [mediaIds]);
  await client.query("DELETE FROM media_legal_holds WHERE r2_key = ANY($1::text[])", [heldKeys]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

async function newUser(anonymised: boolean): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, email, password_hash, anonymised_at)
     VALUES ($1, $2, 'h', CASE WHEN $3::boolean THEN now() ELSE NULL END)`,
    [id, `${id}@owner-clearing.test`, anonymised],
  );
  userIds.push(id);
  return id;
}

function newKey(): string {
  return `media/post/${randomUUID().replace(/-/g, "")}.webp`;
}

async function hold(key: string): Promise<void> {
  heldKeys.push(key);
  await client.query(
    `INSERT INTO media_legal_holds (r2_key, imposed_by, category) VALUES ($1, 'mod@example.test', 'other')`,
    [key],
  );
}

async function release(key: string): Promise<void> {
  await client.query("DELETE FROM media_legal_holds WHERE r2_key = $1", [key]);
}

async function insertMedia(owner: string, key = newKey()): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height,
                        original_md5, original_sha1, original_sha256,
                        pdq, pdq_quality, pdq_source, scan_path, scan_list_version, scanned_at)
     VALUES ($1, $2, $3, 123, 4, 5, $4, $5, $6, $7, 90, 'original', 'hash', 'v1', now())
     RETURNING id`,
    [owner, key, "d".repeat(64), "a".repeat(32), "b".repeat(40), "c".repeat(64), "e".repeat(64)],
  );
  mediaIds.push(rows[0]!.id);
  return rows[0]!.id;
}

/** Every column the clearing must NOT touch, as one comparable object. */
async function keptColumns(id: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT r2_key, sha256, bytes::text AS bytes, width, height, created_at,
            original_md5, original_sha1, original_sha256,
            pdq, pdq_quality, pdq_source, scan_path, scan_list_version, scanned_at
       FROM media WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function ownerState(id: string): Promise<{ owner: string | null; clearedAt: Date | null }> {
  const { rows } = await client.query<{ owner_id: string | null; owner_cleared_at: Date | null }>(
    "SELECT owner_id, owner_cleared_at FROM media WHERE id = $1",
    [id],
  );
  return { owner: rows[0]!.owner_id, clearedAt: rows[0]!.owner_cleared_at };
}

describe("clearMediaOwnerForAnonymisedUser", () => {
  it("clears an ordinary row's owner, stamps owner_cleared_at, and keeps every other column byte-for-byte", async () => {
    const user = await newUser(false);
    const id = await insertMedia(user);
    const before = await keptColumns(id);
    // CONTROL: the fixture really carries values in the columns that must survive.
    expect(before.original_md5).toBe("a".repeat(32));
    expect(before.pdq).toBe("e".repeat(64));

    expect(await clearMediaOwnerForAnonymisedUser(client, user)).toBe(1);

    const after = await ownerState(id);
    expect(after.owner).toBeNull();
    expect(after.clearedAt).not.toBeNull();
    expect(await keptColumns(id)).toEqual(before);
  });

  it("keeps the owner of a row on a held r2_key, clears an unheld sibling in the same call, and the sweep catches the held one up after release", async () => {
    const user = await newUser(false);
    const heldKey = newKey();
    const heldId = await insertMedia(user, heldKey);
    const plainId = await insertMedia(user);
    await hold(heldKey);

    expect(await clearMediaOwnerForAnonymisedUser(client, user)).toBe(1);

    // CONTROL: the unheld sibling went in the same statement.
    expect((await ownerState(plainId)).owner).toBeNull();
    expect((await ownerState(heldId)).owner).toBe(user);
    expect((await ownerState(heldId)).clearedAt).toBeNull();

    // While the hold stands, the sweep leaves it too (the user is not yet anonymised in
    // the DB, so mark it: the sweep keys on users.anonymised_at).
    await client.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [user]);
    await clearMediaOwnersOfAnonymisedUsers(client, ALL);
    expect((await ownerState(heldId)).owner, "the sweep cleared a held row").toBe(user);

    await release(heldKey);
    await clearMediaOwnersOfAnonymisedUsers(client, ALL);
    expect((await ownerState(heldId)).owner).toBeNull();
    expect((await ownerState(heldId)).clearedAt).not.toBeNull();
  });

  it("decides two users' rows on the SAME unheld r2_key per row: only the anonymised user's is cleared", async () => {
    const a = await newUser(false);
    const b = await newUser(false);
    const key = newKey();
    const rowA = await insertMedia(a, key);
    const rowB = await insertMedia(b, key);

    expect(await clearMediaOwnerForAnonymisedUser(client, a)).toBe(1);

    expect((await ownerState(rowA)).owner).toBeNull();
    // The other user's row on the identical key is untouched.
    expect((await ownerState(rowB)).owner).toBe(b);
    expect((await ownerState(rowB)).clearedAt).toBeNull();
  });

  it("on a HELD shared key, neither user's row is cleared", async () => {
    const a = await newUser(false);
    const b = await newUser(false);
    const key = newKey();
    const rowA = await insertMedia(a, key);
    const rowB = await insertMedia(b, key);
    await hold(key);

    expect(await clearMediaOwnerForAnonymisedUser(client, a)).toBe(0);

    expect((await ownerState(rowA)).owner).toBe(a);
    expect((await ownerState(rowB)).owner).toBe(b);
  });
});

describe("clearMediaOwnersOfAnonymisedUsers (the daily sweep)", () => {
  it("clears the rows of an already-anonymised user (backfill) but not those of a live user, and a second run changes nothing", async () => {
    const gone = await newUser(true);
    const live = await newUser(false);
    const goneRow = await insertMedia(gone);
    const liveRow = await insertMedia(live); // CONTROL: same query, owner not anonymised

    expect(await clearMediaOwnersOfAnonymisedUsers(client, ALL)).toBeGreaterThanOrEqual(1);

    const first = await ownerState(goneRow);
    expect(first.owner).toBeNull();
    expect(first.clearedAt).not.toBeNull();
    expect((await ownerState(liveRow)).owner).toBe(live);

    // Second run: the cleared row no longer matches, so its stamp is not rewritten.
    await clearMediaOwnersOfAnonymisedUsers(client, ALL);
    expect((await ownerState(goneRow)).clearedAt).toEqual(first.clearedAt);
    expect((await ownerState(liveRow)).owner).toBe(live);
  });

  it("is bounded: a limit of 1 clears one row in total, and later runs finish the rest", async () => {
    const gone = await newUser(true);
    const ids = [await insertMedia(gone), await insertMedia(gone), await insertMedia(gone)];

    // One row in total, not one of OURS: the oldest eligible row anywhere goes first.
    expect(await clearMediaOwnersOfAnonymisedUsers(client, 1)).toBe(1);

    const owners = await Promise.all(ids.map(async (id) => (await ownerState(id)).owner));
    expect(owners.filter((o) => o === null).length).toBeLessThanOrEqual(1);

    // CONTROL: the remainder is not stuck; a larger run finishes the job.
    await clearMediaOwnersOfAnonymisedUsers(client, ALL);
    const after = await Promise.all(ids.map(async (id) => (await ownerState(id)).owner));
    expect(after.every((o) => o === null)).toBe(true);
  });
});

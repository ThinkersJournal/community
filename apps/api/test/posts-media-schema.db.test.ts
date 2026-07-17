import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Schema-level guarantees for migrations/0002 that no route test can express:
 * the PK VERSION per table, per-author slug uniqueness, the status CHECKs, and
 * the FK cascades. Runs in the NODE project — it needs a direct connection and
 * information_schema, not a Hyperdrive binding.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let userA: string;
let userB: string;

/** Canonical UUID: char 15 (1-indexed) is the version nibble. */
const versionOf = (uuid: string): string => uuid[14]!;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`schema-${crypto.randomUUID()}@example.com`],
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

describe("primary key versions (the invariant is PER TABLE)", () => {
  it("posts.id defaults to a UUIDv7", async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1, 't', $2, 'b') RETURNING id::text AS id",
      [userA, `v7-${crypto.randomUUID()}`],
    );
    expect(versionOf(rows[0]!.id)).toBe("7");
  });

  it("media.id defaults to a UUIDv7", async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,'k','h',1,1,1) RETURNING id::text AS id",
      [userA],
    );
    expect(versionOf(rows[0]!.id)).toBe("7");
  });

  it("users.id is STILL a UUIDv4 — do not migrate it", async () => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE id = $1",
      [userA],
    );
    expect(
      versionOf(rows[0]!.id),
      "users.id changed version. The v7 invariant is PER TABLE: users/profiles stay v4 (PK-lookup, low-volume, and rewriting their PKs means rewriting every FK). See the Global Constraints.",
    ).toBe("4");
  });
});

describe("posts.id is time-ordered (this is what keyset pagination rests on)", () => {
  it("ORDER BY id DESC is newest-first, even within one millisecond", async () => {
    const inserted: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b') RETURNING id::text AS id",
        [userB, `ord-${i}-${crypto.randomUUID()}`],
      );
      inserted.push(rows[0]!.id);
    }
    const { rows } = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM posts WHERE author_id = $1 ORDER BY id DESC",
      [userB],
    );
    expect(rows.map((r) => r.id)).toEqual([...inserted].reverse());
  });
});

describe("posts constraints", () => {
  it("rejects a duplicate slug for the SAME author", async () => {
    const slug = `dup-${crypto.randomUUID()}`;
    await client.query(
      "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
      [userA, slug],
    );
    await expect(
      client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [userA, slug],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("ALLOWS the same slug for a DIFFERENT author", async () => {
    const slug = `shared-${crypto.randomUUID()}`;
    await client.query(
      "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
      [userA, slug],
    );
    await expect(
      client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [userB, slug],
      ),
    ).resolves.toBeDefined();
  });

  it("matches slugs case-insensitively (citext)", async () => {
    const slug = `Case-${crypto.randomUUID()}`;
    await client.query(
      "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
      [userA, slug],
    );
    await expect(
      client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
        [userA, slug.toUpperCase()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects an unknown status", async () => {
    await expect(
      client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source, status) VALUES ($1,'t',$2,'b','deleted')",
        [userA, `st-${crypto.randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects status='published' with a NULL published_at", async () => {
    await expect(
      client.query(
        "INSERT INTO posts (author_id, title, slug, markdown_source, status) VALUES ($1,'t',$2,'b','published')",
        [userA, `pub-${crypto.randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("cascades on author deletion", async () => {
    const doomed = await makeUser();
    await client.query(
      "INSERT INTO posts (author_id, title, slug, markdown_source) VALUES ($1,'t',$2,'b')",
      [doomed, `cascade-${crypto.randomUUID()}`],
    );
    await client.query("DELETE FROM users WHERE id = $1", [doomed]);
    const { rows } = await client.query("SELECT 1 FROM posts WHERE author_id = $1", [doomed]);
    expect(rows).toHaveLength(0);
  });
});

describe("media", () => {
  it("allows TWO rows to share one r2_key (content addressing dedupes across users)", async () => {
    const hash = "a".repeat(64);
    const key = `media/post/${hash}.webp`;
    for (const owner of [userA, userB]) {
      await client.query(
        "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,$2,$3,10,1,1)",
        [owner, key, hash],
      );
    }
    const { rows } = await client.query("SELECT 1 FROM media WHERE r2_key = $1", [key]);
    expect(
      rows,
      "r2_key must NOT be unique: two users uploading the same image share ONE R2 object with TWO rows. Ownership lives here, not in the key.",
    ).toHaveLength(2);
  });
});

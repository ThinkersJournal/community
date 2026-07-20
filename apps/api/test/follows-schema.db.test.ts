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
    [`follows-${crypto.randomUUID()}@example.com`],
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

describe("follows schema", () => {
  it("assigns a uuidv7 id (version nibble 7)", async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) RETURNING id",
      [userA, userB],
    );
    expect(rows[0]!.id[14]).toBe("7");
    await client.query("DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2", [userA, userB]);
  });

  it("rejects a self-follow (CHECK violation 23514)", async () => {
    await expect(
      client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$1)", [userA]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a duplicate (follower,followee) pair (unique violation 23505)", async () => {
    await client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [userA, userB]);
    await expect(
      client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [userA, userB]),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2", [userA, userB]);
  });

  it("cascade-deletes a follow when either user is deleted", async () => {
    const temp = await makeUser();
    await client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [userA, temp]);
    await client.query("DELETE FROM users WHERE id = $1", [temp]);
    const { rows } = await client.query(
      "SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2",
      [userA, temp],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("profiles.username_chosen", () => {
  it("defaults to false for a freshly inserted profile", async () => {
    const uid = await makeUser();
    await client.query("INSERT INTO profiles (user_id, username) VALUES ($1,$2)", [
      uid,
      `u${uid.replace(/-/g, "").slice(0, 20)}`,
    ]);
    const { rows } = await client.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id=$1",
      [uid],
    );
    expect(rows[0]!.username_chosen).toBe(false);
    await client.query("DELETE FROM users WHERE id=$1", [uid]);
  });
});

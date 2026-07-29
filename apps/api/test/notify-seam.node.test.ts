import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notify } from "../src/notifications/create";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

// M2.3b: notify() gained an `env` param (the realtime push seam). This file
// drives notify() directly against a real pg Client (not the Worker/DO
// runtime), so `env` is a minimal stub — the push itself is proven at the
// Worker level in test/{comments,reactions,follows}.test.ts's "notify push"
// suites; here it only needs to satisfy the call shape without throwing.
const fakeEnv = { NOTIFY: { getByName: () => ({ push: () => {} }) } };

let client: Client;
let alice: string;
let bob: string;
async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`seam-${crypto.randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}
async function count(recipient: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    "SELECT count(*) n FROM notifications WHERE recipient_id=$1", [recipient],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  alice = await makeUser();
  bob = await makeUser();
});
afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
  await client.end();
});

describe("notify()", () => {
  it("inserts a row for a real event", async () => {
    await notify(client, fakeEnv, { recipientId: alice, actorId: bob, kind: "follow" });
    expect(await count(alice)).toBe(1);
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("self-suppresses (recipient === actor) with no insert", async () => {
    await notify(client, fakeEnv, { recipientId: alice, actorId: alice, kind: "follow" });
    expect(await count(alice)).toBe(0);
  });

  it("is idempotent — a duplicate event does not add a second row", async () => {
    const ev = { recipientId: alice, actorId: bob, kind: "follow" as const };
    await notify(client, fakeEnv, ev);
    await notify(client, fakeEnv, ev);
    expect(await count(alice)).toBe(1);
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("NEVER throws — a failing client is swallowed", async () => {
    const boom = { query: async () => { throw new Error("db down"); } };
    await expect(
      notify(boom as never, fakeEnv, { recipientId: alice, actorId: bob, kind: "follow" }),
    ).resolves.toBeUndefined();
  });
});

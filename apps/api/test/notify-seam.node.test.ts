import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notify } from "../src/notifications/create";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

// M2.3b: notify() gained `env` and `ctx` params (the realtime push seam).
// This file drives notify() directly against a real pg Client (not the
// Worker/DO runtime), so `env`/`ctx` are minimal stubs — the push's actual
// delivery/cancellation semantics are proven at the Worker level in
// test/{comments,reactions,follows}.test.ts (which run createExecutionContext
// + waitOnExecutionContext against real workerd). Here the stubs only need to
// satisfy the call shape without throwing. `fakeCtx.waitUntil` can safely
// discard the promise: notify() invokes the push IIFE synchronously, and the
// spy below records inside `push()` — which runs BEFORE the IIFE's first
// `await` — so the side-effect is already observable by the time `notify()`
// returns, no matter what waitUntil does with the (already-running) promise.
const fakeEnv = { NOTIFY: { getByName: () => ({ push: () => {} }) } };
const fakeCtx = { waitUntil: (p: Promise<unknown>) => { void p; } };

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
    await notify(client, fakeEnv, fakeCtx, { recipientId: alice, actorId: bob, kind: "follow" });
    expect(await count(alice)).toBe(1);
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("self-suppresses (recipient === actor) with no insert", async () => {
    await notify(client, fakeEnv, fakeCtx, { recipientId: alice, actorId: alice, kind: "follow" });
    expect(await count(alice)).toBe(0);
  });

  it("is idempotent — a duplicate event does not add a second row", async () => {
    const ev = { recipientId: alice, actorId: bob, kind: "follow" as const };
    await notify(client, fakeEnv, fakeCtx, ev);
    await notify(client, fakeEnv, fakeCtx, ev);
    expect(await count(alice)).toBe(1);
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("NEVER throws — a failing client is swallowed", async () => {
    const boom = { query: async () => { throw new Error("db down"); } };
    await expect(
      notify(boom as never, fakeEnv, fakeCtx, { recipientId: alice, actorId: bob, kind: "follow" }),
    ).resolves.toBeUndefined();
  });

  // Finding 2 (M2.3b fix wave): the anti-harassment guarantee M2.3a documents
  // for the DB row (a duplicate event is a no-op, not a second row) must also
  // hold for the LIVE push — otherwise follow/unfollow/re-follow cycling (or a
  // repeat same-tone reaction) can spam the recipient's bell with live nudges
  // even though no new notification exists. `notify()` gates the push on
  // `rowCount`: 0 (ON CONFLICT no-op) means no push.
  it("a no-op insert (duplicate event) does NOT push, even though the first did", async () => {
    const pushed: string[] = [];
    const spyEnv = {
      NOTIFY: { getByName: (id: string) => ({ push: () => { pushed.push(id); } }) },
    };
    const ev = { recipientId: alice, actorId: bob, kind: "follow" as const };
    await notify(client, spyEnv, fakeCtx, ev); // first: real insert, rowCount 1 → pushes
    expect(pushed).toEqual([alice]);
    pushed.length = 0;
    await notify(client, spyEnv, fakeCtx, ev); // duplicate: ON CONFLICT no-op, rowCount 0
    expect(pushed).toEqual([]); // → no push
    expect(await count(alice)).toBe(1); // still just the one row
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });
});

// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimDueRefreshes, LEASE_MS, SWEEP_BATCH } from "../src/references/refresh-queue";

/**
 * claimDueRefreshes (M3.2c-3a): the sweep's one query. It picks the references whose `next_check_at` has come, never a
 * dormant (NULL) or gone one, and leases each by pushing `next_check_at` forward so the next tick does not enqueue it again.
 * Every test row sits in the year 2000 and `now` is in 2000 too, so rows other test files leave (2026) are never due here.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const NOW = new Date("2000-06-01T12:00:00.000Z");
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

let client: Client;
let second: Client;
const referenceIds: string[] = [];

async function seed(opts: { next: Date | null; gone?: boolean }): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, next_check_at, gone_at)
     VALUES ('web', $1, $2, $3, $4) RETURNING id`,
    [`web:https://example.com/${randomUUID()}`, randomUUID(), opts.next, opts.gone === true ? NOW : null],
  );
  referenceIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function nextOf(id: string): Promise<Date | null> {
  const { rows } = await client.query<{ next_check_at: Date | null }>(`SELECT next_check_at FROM "references" WHERE id = $1`, [id]);
  return rows[0]!.next_check_at;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  second = new Client({ connectionString: TEST_DATABASE_URL });
  await Promise.all([client.connect(), second.connect()]);
});

afterAll(async () => {
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await Promise.all([client.end(), second.end()]);
});

describe("claimDueRefreshes", () => {
  it("claims a due reference (next_check_at <= now, including exactly now) and leases it (mutation: < instead of <=, or no lease)", async () => {
    const past = await seed({ next: minutes(-5) });
    const exact = await seed({ next: NOW });
    const claimed = await claimDueRefreshes(client, NOW);
    expect(claimed.sort()).toEqual([past, exact].sort());
    expect((await nextOf(past))?.toISOString()).toBe(new Date(NOW.getTime() + LEASE_MS).toISOString());
    expect((await nextOf(exact))?.toISOString()).toBe(new Date(NOW.getTime() + LEASE_MS).toISOString());
  });

  it("does not claim one that is not due yet, one that is dormant (NULL), or one that is gone", async () => {
    const future = await seed({ next: minutes(1) });
    const dormant = await seed({ next: null });
    const gone = await seed({ next: minutes(-5), gone: true });
    const claimed = await claimDueRefreshes(client, NOW);
    expect(claimed).not.toContain(future);
    expect(claimed).not.toContain(dormant);
    expect(claimed).not.toContain(gone);
    expect(await nextOf(dormant)).toBeNull();
    expect((await nextOf(future))?.toISOString()).toBe(minutes(1).toISOString());
  });

  it("a leased reference is not claimed again until its lease ends (mutation: do not move next_check_at)", async () => {
    const id = await seed({ next: minutes(-1) });
    expect(await claimDueRefreshes(client, NOW)).toContain(id);
    expect(await claimDueRefreshes(client, minutes(LEASE_MS / 60_000 - 1))).not.toContain(id);
    expect(await claimDueRefreshes(client, minutes(LEASE_MS / 60_000))).toContain(id);
  });

  it("takes the oldest due first and no more than the limit (mutation: no ORDER BY, or ignore the limit)", async () => {
    const ids: string[] = [];
    for (const m of [-30, -10, -20, -40]) ids.push(await seed({ next: minutes(m) }));
    const claimed = await claimDueRefreshes(client, NOW, 2);
    expect(new Set(claimed)).toEqual(new Set([ids[3]!, ids[0]!])); // -40 and -30 are the two oldest
    const rest = await claimDueRefreshes(client, NOW, 10);
    expect(new Set(rest)).toEqual(new Set([ids[2]!, ids[1]!]));
  });

  it("two concurrent sweeps never claim the same reference (mutation: drop FOR UPDATE SKIP LOCKED)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await seed({ next: minutes(-100 + i) }));
    const [a, b] = await Promise.all([claimDueRefreshes(client, NOW, 8), claimDueRefreshes(second, NOW, 8)]);
    expect(a.filter((x) => b.includes(x))).toEqual([]);
    expect(new Set([...a, ...b])).toEqual(new Set(ids));
  });

  it("skips rows another transaction holds locked, without waiting for it (mutation: drop FOR UPDATE SKIP LOCKED)", async () => {
    // Deterministic overlap, not a race: a third connection locks 3 due rows and keeps its transaction open while a sweep runs.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seed({ next: minutes(-200 + i) }));
    const holder = new Client({ connectionString: TEST_DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "references" WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids.slice(0, 3)]);
      // Without SKIP LOCKED this statement waits for the holder; the race makes it fail in 5 s instead of hanging the file.
      const claimed = await Promise.race([
        claimDueRefreshes(second, NOW, 10),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the sweep waited on a locked row")), 5000)),
      ]);
      expect(new Set(claimed)).toEqual(new Set(ids.slice(3)));
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    // The locked rows were left alone, so the next sweep (after the holder let go) still finds them due.
    expect(new Set(await claimDueRefreshes(client, NOW, 10))).toEqual(new Set(ids.slice(0, 3)));
  });

  it("has a sane default batch size", () => {
    expect(SWEEP_BATCH).toBeGreaterThan(0);
    expect(SWEEP_BATCH).toBeLessThanOrEqual(500);
  });
});

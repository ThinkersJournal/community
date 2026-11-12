// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { ConnectorError, type LiveResult, type StoredReference } from "@thinkersjournal/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { spend } from "../src/references/author-budget";
import { nextCheckAt, retryAt } from "../src/references/refresh-schedule";
import { refreshReference, type RefreshBudget } from "../src/references/refresh";
import { createRegistry } from "../src/references/registry";

import type { Connector } from "../src/references/connector";
import type { FetchCtx } from "@thinkersjournal/shared";

/**
 * refreshReference (M3.2c-2): one stored reference, one refresh. Postgres only; the connector and the budget are fakes.
 * Each test names the mutation that must turn it red. ACCESS IS NOT DIFF: an unknown outcome leaves live_state alone.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const ctx: FetchCtx = { fetch: () => Promise.reject(new Error("the runner must not fetch itself")) };

let client: Client;
const userIds: string[] = [];
const referenceIds: string[] = [];

interface Author {
  userId: string;
}
async function newAuthor(): Promise<Author> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-refresh.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `r${uid.replace(/-/g, "").slice(0, 20)}`]);
  return { userId: uid };
}
async function newPost(author: Author): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source, status, published_at)
     VALUES ($1, $2, 'A title', 'body', 'published', now()) RETURNING id`,
    [author.userId, `s-${randomUUID()}`],
  );
  return rows[0]!.id;
}

interface Seed {
  kind?: string;
  goneAt?: Date | null;
  liveState?: unknown;
  lastViewedAt?: Date | null;
  failures?: number;
  etag?: string | null;
}
async function newReference(seed: Seed = {}): Promise<string> {
  const kind = seed.kind ?? "web";
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, snapshot, live_state, gone_at, last_viewed_at, refresh_failures, etag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      kind,
      `${kind}:https://example.com/${randomUUID()}`,
      randomUUID(),
      JSON.stringify({ kind, title: "T" }),
      seed.liveState === undefined ? null : JSON.stringify(seed.liveState),
      seed.goneAt ?? null,
      seed.lastViewedAt === undefined ? NOW : seed.lastViewedAt,
      seed.failures ?? 0,
      seed.etag ?? null,
    ],
  );
  referenceIds.push(rows[0]!.id);
  return rows[0]!.id;
}
let tokenSeq = 0;
async function useRef(postId: string, referenceId: string, createdAt: Date): Promise<void> {
  // 12 characters of [A-Z2-7]: the sequence number in base 6 over "ABCDEF", left-padded with "2".
  const token = (tokenSeq++).toString(6).replace(/\d/g, (d) => "ABCDEF"[Number(d)]!).padStart(12, "2");
  await client.query("INSERT INTO post_references (post_id, reference_id, token, created_at) VALUES ($1, $2, $3, $4)", [
    postId,
    referenceId,
    token,
    createdAt,
  ]);
}

interface Row {
  live_state: Record<string, unknown> | null;
  next_check_at: Date | null;
  refresh_failures: number;
  gone_at: Date | null;
  etag: string | null;
  last_modified: string | null;
}
async function read(id: string): Promise<Row> {
  const { rows } = await client.query<Row>(
    `SELECT live_state, next_check_at, refresh_failures, gone_at, etag, last_modified FROM "references" WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

/** A budget with a full bucket per author; records who was charged. */
function fakeBudget(opts: { refuse?: number } = {}): RefreshBudget & { charged: string[] } {
  const charged: string[] = [];
  return {
    charged,
    take(authorId, cost) {
      charged.push(authorId);
      const cfg = { capacity: 60, refillPerMs: 60 / 3_600_000 };
      if (opts.refuse !== undefined) {
        return Promise.resolve({ ok: false, state: { tokens: 0, at: NOW.getTime() }, retryAfterMs: opts.refuse });
      }
      return Promise.resolve(spend(null, NOW.getTime(), cost, cfg));
    },
  };
}

function fakeConnector(
  kind: "web" | "github",
  answer: LiveResult | Error | (() => never),
): Connector & { calls: StoredReference[] } {
  const calls: StoredReference[] = [];
  return {
    kind,
    calls,
    identify: () => null,
    resolve: () => Promise.reject(new Error("unused")),
    fetchLive(ref) {
      calls.push(ref);
      if (typeof answer === "function") return Promise.resolve().then(answer);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    deepLink: (ref) => ref.canonicalUrl,
  };
}

async function run(id: string, connector: Connector, budget: RefreshBudget) {
  return refreshReference(client, id, { registry: createRegistry([connector]), ctx, budget, now: NOW });
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM posts WHERE author_id = ANY($1::uuid[])", [userIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe("refreshReference: what it skips", () => {
  it("returns 'missing' for an id that is not a row, and never fetches", async () => {
    const c = fakeConnector("web", { access: "ok", diff: "unchanged" });
    expect(await run(randomUUID(), c, fakeBudget())).toBe("missing");
    expect(c.calls).toHaveLength(0);
  });

  it("skips a row that is already gone: no fetch, no charge, row untouched (mutation: drop the gone_at guard)", async () => {
    const a = await newAuthor();
    const id = await newReference({ goneAt: new Date("2026-11-01T00:00:00Z") });
    await useRef(await newPost(a), id, NOW);
    const c = fakeConnector("web", { access: "ok", diff: "unchanged" });
    const b = fakeBudget();
    expect(await run(id, c, b)).toBe("gone");
    expect(c.calls).toHaveLength(0);
    expect(b.charged).toHaveLength(0);
  });

  it("an orphan (no uses) goes dormant: next_check_at NULL, no fetch, no charge", async () => {
    const id = await newReference();
    await client.query(`UPDATE "references" SET next_check_at = $2 WHERE id = $1`, [id, NOW]);
    const c = fakeConnector("web", { access: "ok", diff: "unchanged" });
    const b = fakeBudget();
    expect(await run(id, c, b)).toBe("orphan");
    expect((await read(id)).next_check_at).toBeNull();
    expect(c.calls).toHaveLength(0);
    expect(b.charged).toHaveLength(0);
  });
});

describe("refreshReference: who pays (the author of the NEWEST use)", () => {
  it("charges the author of the newest use, not the oldest (mutation: ORDER BY created_at ASC)", async () => {
    const oldA = await newAuthor();
    const newA = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(oldA), id, new Date("2026-11-01T00:00:00Z"));
    await useRef(await newPost(newA), id, new Date("2026-11-10T00:00:00Z"));
    const b = fakeBudget();
    await run(id, fakeConnector("web", { access: "ok", diff: "unchanged" }), b);
    expect(b.charged).toEqual([newA.userId]);
  });

  it("breaks a timestamp tie by the LOWEST post id (mutation: DESC, or no tie-break)", async () => {
    const x = await newAuthor();
    const y = await newAuthor();
    const id = await newReference();
    const px = await newPost(x);
    const py = await newPost(y);
    const same = new Date("2026-11-05T00:00:00Z");
    await useRef(py, id, same);
    await useRef(px, id, same);
    const lowest = px < py ? x : y;
    for (let i = 0; i < 3; i++) {
      const b = fakeBudget();
      await run(id, fakeConnector("web", { access: "ok", diff: "unchanged" }), b);
      expect(b.charged).toEqual([lowest.userId]);
    }
  });

  it("when the newest use is removed, the NEXT newest pays; with none left it is an orphan", async () => {
    const older = await newAuthor();
    const newer = await newAuthor();
    const id = await newReference();
    const pOld = await newPost(older);
    const pNew = await newPost(newer);
    await useRef(pOld, id, new Date("2026-11-01T00:00:00Z"));
    await useRef(pNew, id, new Date("2026-11-10T00:00:00Z"));

    await client.query("DELETE FROM posts WHERE id = $1", [pNew]); // cascades the newest use
    const b1 = fakeBudget();
    expect(await run(id, fakeConnector("web", { access: "ok", diff: "unchanged" }), b1)).toBe("refreshed");
    expect(b1.charged).toEqual([older.userId]);

    await client.query("DELETE FROM posts WHERE id = $1", [pOld]);
    const c = fakeConnector("web", { access: "ok", diff: "unchanged" });
    expect(await run(id, c, fakeBudget())).toBe("orphan");
    expect((await read(id)).next_check_at).toBeNull();
    expect(c.calls).toHaveLength(0);
  });
});

describe("refreshReference: the budget", () => {
  it("a refused spend does not fetch and schedules now + retryAfterMs; failures unchanged (mutation: fetch anyway)", async () => {
    const a = await newAuthor();
    const id = await newReference({ failures: 2 });
    await useRef(await newPost(a), id, NOW);
    const c = fakeConnector("web", { access: "ok", diff: "unchanged" });
    expect(await run(id, c, fakeBudget({ refuse: 90_000 }))).toBe("throttled");
    const row = await read(id);
    expect(c.calls).toHaveLength(0);
    expect(row.next_check_at?.toISOString()).toBe(new Date(NOW.getTime() + 90_000).toISOString());
    expect(row.refresh_failures).toBe(2);
  });
});

describe("refreshReference: unknown outcomes (access is not diff)", () => {
  const liveState = { access: "ok", diff: "changed", observedAt: "2026-11-01T00:00:00.000Z" };

  it.each([
    ["rate_limited", { access: "rate_limited", diff: "unknown" } as LiveResult],
    ["error", { access: "error", diff: "unknown" } as LiveResult],
    ["forbidden", { access: "forbidden", diff: "unknown" } as LiveResult],
  ])("%s: live_state untouched, failures + 1, retryAt (mutation: store the unknown)", async (_name, answer) => {
    const a = await newAuthor();
    const id = await newReference({ liveState, failures: 3 });
    await useRef(await newPost(a), id, NOW);
    expect(await run(id, fakeConnector("web", answer), fakeBudget())).toBe("unknown");
    const row = await read(id);
    expect(row.live_state).toEqual(liveState);
    expect(row.gone_at).toBeNull();
    expect(row.refresh_failures).toBe(4);
    expect(row.next_check_at?.toISOString()).toBe(retryAt(NOW, 3).toISOString());
  });

  it("a ConnectorError and a plain Error both count as an unknown outcome, and the plain one is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const err of [new ConnectorError("upstream", "boom"), new Error("surprise")]) {
        const a = await newAuthor();
        const id = await newReference({ liveState });
        await useRef(await newPost(a), id, NOW);
        expect(await run(id, fakeConnector("web", err), fakeBudget())).toBe("unknown");
        const row = await read(id);
        expect(row.live_state).toEqual(liveState);
        expect(row.refresh_failures).toBe(1);
      }
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("a kind with no registered connector is an unknown outcome, not a crash", async () => {
    const a = await newAuthor();
    const id = await newReference({ kind: "github" });
    await useRef(await newPost(a), id, NOW);
    expect(await run(id, fakeConnector("web", { access: "ok", diff: "unchanged" }), fakeBudget())).toBe("unknown");
    expect((await read(id)).refresh_failures).toBe(1);
  });
});

describe("refreshReference: definitive outcomes", () => {
  it("unchanged: resets failures, stores the validators, refreshes observedAt, schedules the taper", async () => {
    const a = await newAuthor();
    const lastViewed = new Date(NOW.getTime() - 30 * 60_000);
    const id = await newReference({
      liveState: { access: "ok", diff: "changed", observedAt: "2026-11-01T00:00:00.000Z" },
      failures: 5,
      lastViewedAt: lastViewed,
    });
    await useRef(await newPost(a), id, NOW);
    const c = fakeConnector("web", { access: "ok", diff: "unchanged", etag: '"v2"', lastModified: "Wed, 11 Nov 2026 00:00:00 GMT" });
    expect(await run(id, c, fakeBudget())).toBe("refreshed");
    const row = await read(id);
    expect(row.refresh_failures).toBe(0);
    expect(row.etag).toBe('"v2"');
    expect(row.last_modified).toBe("Wed, 11 Nov 2026 00:00:00 GMT");
    expect(row.live_state).toMatchObject({ diff: "changed", observedAt: NOW.toISOString() });
    expect(row.next_check_at?.toISOString()).toBe(nextCheckAt(NOW, lastViewed)!.toISOString());
  });

  it("passes the stored etag to the connector (mutation: build the StoredReference without it)", async () => {
    const a = await newAuthor();
    const id = await newReference({ etag: '"v1"' });
    await useRef(await newPost(a), id, NOW);
    const c = fakeConnector("web", { access: "ok", diff: "unchanged" });
    await run(id, c, fakeBudget());
    expect(c.calls[0]).toMatchObject({ kind: "web", etag: '"v1"' });
    expect(c.calls[0]!.canonicalUrl).toMatch(/^https:\/\/example\.com\//);
  });

  it("a never-viewed reference goes dormant after a successful look (next_check_at NULL)", async () => {
    const a = await newAuthor();
    const id = await newReference({ lastViewedAt: null });
    await useRef(await newPost(a), id, NOW);
    await run(id, fakeConnector("web", { access: "ok", diff: "unchanged" }), fakeBudget());
    expect((await read(id)).next_check_at).toBeNull();
  });

  it("changed: stores the new live_state with its snapshot", async () => {
    const a = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(a), id, NOW);
    const snapshot = { kind: "web", title: "New title" } as never;
    await run(id, fakeConnector("web", { access: "ok", diff: "changed", snapshot }), fakeBudget());
    expect((await read(id)).live_state).toMatchObject({ access: "ok", diff: "changed", snapshot: { title: "New title" } });
  });

  it("gone: sets gone_at = now, goes dormant, resets failures; a later refresh is skipped", async () => {
    const a = await newAuthor();
    const id = await newReference({ failures: 4 });
    await useRef(await newPost(a), id, NOW);
    expect(await run(id, fakeConnector("web", { access: "gone", diff: "gone" }), fakeBudget())).toBe("refreshed");
    const row = await read(id);
    expect(row.gone_at?.toISOString()).toBe(NOW.toISOString());
    expect(row.next_check_at).toBeNull();
    expect(row.refresh_failures).toBe(0);
    expect(row.live_state).toMatchObject({ diff: "gone" });
    expect(row.live_state).not.toHaveProperty("snapshot");
    expect(await run(id, fakeConnector("web", { access: "ok", diff: "unchanged" }), fakeBudget())).toBe("gone");
  });
});

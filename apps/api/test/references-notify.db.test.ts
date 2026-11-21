// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spend } from "../src/references/author-budget";
import { refreshReference, type RefreshBudget } from "../src/references/refresh";
import { createRegistry } from "../src/references/registry";

import type { Connector } from "../src/references/connector";
import type { FetchCtx, LiveResult } from "@thinkersjournal/shared";

/**
 * M3.9: reference-change notifications (spec docs/superpowers/specs/2026-11-19-m3-9-reference-change-notifications.md, section 9).
 * refreshReference is the seam under test: after a definitive look whose stored live_state was NOT null, `gone` and `changed`
 * notify the authors of PUBLISHED, non-hidden posts that use the reference; nothing else does. Postgres only; the connector,
 * the budget, the Durable Object namespace and the ExecutionContext are fakes.
 *
 * THE FLAG. `REFERENCE_REFRESH` is read only by the scheduler and the queue consumer (refresh-wiring.ts), never by
 * refreshReference, so "flag off writes nothing" is true by construction: with the flag off nothing is enqueued and
 * refreshReference never runs. It cannot be pinned at this seam; the flag-off guards in refresh-wiring.ts keep their own tests.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const fetchCtx: FetchCtx = { fetch: () => Promise.reject(new Error("the runner must not fetch itself")) };
const PRIOR = { access: "ok", diff: "unchanged", observedAt: "2026-11-01T00:00:00.000Z" };
const SECRET_TITLE = "SNAPSHOT-TEXT-MUST-NEVER-LEAK";

let client: Client;
const userIds: string[] = [];
const referenceIds: string[] = [];
const pushes: string[] = [];
const waited: Promise<unknown>[] = [];
const notifyEnv = { NOTIFY: { getByName: (id: string) => ({ push: () => void pushes.push(id) }) } };
const notifyCtx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };

async function newAuthor(): Promise<string> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-notify.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `n${uid.replace(/-/g, "").slice(0, 20)}`]);
  return uid;
}
async function newPost(authorId: string, opts: { status?: "published" | "draft"; hidden?: boolean } = {}): Promise<string> {
  const status = opts.status ?? "published";
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source, status, published_at, hidden_at)
     VALUES ($1, $2, 'A title', 'body', $3, CASE WHEN $3 = 'published' THEN now() END, CASE WHEN $4 THEN now() END) RETURNING id`,
    [authorId, `s-${randomUUID()}`, status, opts.hidden === true],
  );
  return rows[0]!.id;
}
/** A reference whose stored live_state is `liveState` (null = never looked at). */
async function newReference(liveState: unknown = PRIOR): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, snapshot, live_state, last_viewed_at)
     VALUES ('web', $1, $2, $3, $4, $5) RETURNING id`,
    [
      `web:https://example.com/${randomUUID()}`,
      randomUUID(),
      JSON.stringify({ kind: "web", title: SECRET_TITLE }),
      liveState === null ? null : JSON.stringify(liveState),
      NOW,
    ],
  );
  referenceIds.push(rows[0]!.id);
  return rows[0]!.id;
}
let tokenSeq = 0;
async function useRef(postId: string, referenceId: string, createdAt: Date = NOW): Promise<void> {
  const token = (tokenSeq++).toString(6).replace(/\d/g, (d) => "ABCDEF"[Number(d)]!).padStart(12, "2");
  await client.query("INSERT INTO post_references (post_id, reference_id, token, created_at) VALUES ($1, $2, $3, $4)", [
    postId,
    referenceId,
    token,
    createdAt,
  ]);
}

interface NotifRow {
  recipient_id: string;
  actor_id: string | null;
  kind: string;
  post_id: string | null;
  reference_id: string;
  reference_event: string;
}
async function notifsFor(referenceId: string): Promise<NotifRow[]> {
  const { rows } = await client.query<NotifRow>(
    `SELECT recipient_id, actor_id, kind, post_id, reference_id, reference_event
       FROM notifications WHERE reference_id = $1 ORDER BY recipient_id, post_id`,
    [referenceId],
  );
  return rows;
}

const budget: RefreshBudget = {
  take: (_author, cost) => Promise.resolve(spend(null, NOW.getTime(), cost, { capacity: 60, refillPerMs: 60 / 3_600_000 })),
};
function connector(answer: LiveResult): Connector {
  return {
    kind: "web",
    identify: () => null,
    resolve: () => Promise.reject(new Error("unused")),
    fetchLive: () => Promise.resolve(answer),
    deepLink: (ref) => ref.canonicalUrl,
  };
}
async function run(referenceId: string, answer: LiveResult) {
  const outcome = await refreshReference(client, referenceId, {
    registry: createRegistry([connector(answer)]),
    ctx: fetchCtx,
    budget,
    now: NOW,
    notify: { env: notifyEnv, ctx: notifyCtx },
  });
  await Promise.all(waited.splice(0));
  return outcome;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM notifications WHERE recipient_id = ANY($1::uuid[])", [userIds]);
  await client.query("DELETE FROM posts WHERE author_id = ANY($1::uuid[])", [userIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe("reference-change notifications: when nothing is written", () => {
  it("unknown writes nothing (mutation: notify before the unknown early return)", async () => {
    const a = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(a), id);
    expect(await run(id, { access: "error", diff: "unknown" })).toBe("unknown");
    expect(await notifsFor(id)).toEqual([]);
  });

  it("the FIRST look (stored live_state NULL) writes nothing, even for gone and changed (mutation: drop the prior-state guard)", async () => {
    const a = await newAuthor();
    const idGone = await newReference(null);
    const idChanged = await newReference(null);
    const post = await newPost(a);
    await useRef(post, idGone);
    await useRef(post, idChanged);
    await run(idGone, { access: "gone", diff: "gone" });
    await run(idChanged, { access: "ok", diff: "changed", contentHash: "h1" });
    expect(await notifsFor(idGone)).toEqual([]);
    expect(await notifsFor(idChanged)).toEqual([]);
  });

  it("resolved and unchanged notify nobody (mutation: notify on every diff)", async () => {
    const a = await newAuthor();
    const idResolved = await newReference();
    const idSame = await newReference();
    const post = await newPost(a);
    await useRef(post, idResolved);
    await useRef(post, idSame);
    await run(idResolved, { access: "ok", diff: "resolved", contentHash: "h1" });
    await run(idSame, { access: "ok", diff: "unchanged" });
    expect(await notifsFor(idResolved)).toEqual([]);
    expect(await notifsFor(idSame)).toEqual([]);
  });
});

describe("reference-change notifications: gone", () => {
  it("notifies each live author once, with a NULL actor, kind reference_changed and event 'gone'", async () => {
    const a1 = await newAuthor();
    const a2 = await newAuthor();
    const id = await newReference();
    const p1 = await newPost(a1);
    const p2 = await newPost(a2);
    await useRef(p1, id);
    await useRef(p2, id);
    pushes.length = 0;
    await run(id, { access: "gone", diff: "gone" });
    const rows = await notifsFor(id);
    expect(rows.map((r) => [r.recipient_id, r.post_id]).sort()).toEqual(
      [
        [a1, p1],
        [a2, p2],
      ].sort(),
    );
    for (const r of rows) {
      expect(r).toMatchObject({ actor_id: null, kind: "reference_changed", reference_id: id, reference_event: "gone" });
    }
    expect(pushes.sort()).toEqual([a1, a2].sort());
  });

  it("an author with two posts using the reference gets one notification per post (mutation: one per author)", async () => {
    const a = await newAuthor();
    const id = await newReference();
    const p1 = await newPost(a);
    const p2 = await newPost(a);
    await useRef(p1, id);
    await useRef(p2, id);
    await run(id, { access: "gone", diff: "gone" });
    expect((await notifsFor(id)).map((r) => r.post_id).sort()).toEqual([p1, p2].sort());
  });

  it("a DRAFT, a hidden (moderated) and a removed post notify nobody; the live one is told (mutation: drop a filter)", async () => {
    const live = await newAuthor();
    const drafter = await newAuthor();
    const hidden = await newAuthor();
    const removed = await newAuthor();
    const id = await newReference();
    const pLive = await newPost(live);
    await useRef(pLive, id);
    await useRef(await newPost(drafter, { status: "draft" }), id);
    await useRef(await newPost(hidden, { hidden: true }), id);
    const pRemoved = await newPost(removed);
    await useRef(pRemoved, id);
    await client.query("DELETE FROM posts WHERE id = $1", [pRemoved]); // removal deletes the row and cascades its use
    await run(id, { access: "gone", diff: "gone" });
    const rows = await notifsFor(id);
    expect(rows.map((r) => r.recipient_id)).toEqual([live]);
    expect(rows[0]!.post_id).toBe(pLive);
  });
});

describe("reference-change notifications: changed (dedupe on the content hash)", () => {
  it("the same hash twice notifies once; a new hash notifies again (mutation: key on 'changed' alone, or no key)", async () => {
    const a = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(a), id);
    pushes.length = 0;
    await run(id, { access: "ok", diff: "changed", contentHash: "h1" });
    await run(id, { access: "ok", diff: "changed", contentHash: "h1" });
    expect((await notifsFor(id)).map((r) => r.reference_event)).toEqual(["changed:h1"]);
    expect(pushes).toEqual([a]); // the duplicate is a no-op: no second push either
    await run(id, { access: "ok", diff: "changed", contentHash: "h2" });
    expect((await notifsFor(id)).map((r) => r.reference_event).sort()).toEqual(["changed:h1", "changed:h2"]);
    expect(pushes).toEqual([a, a]);
  });

  it("a changed look with no contentHash is skipped and logged, never invented (mutation: key on 'changed:')", async () => {
    const a = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(a), id);
    expect(await run(id, { access: "ok", diff: "changed" })).toBe("refreshed");
    expect(await notifsFor(id)).toEqual([]);
  });
});

describe("reference-change notifications: the cap and the content", () => {
  it("drops notifications beyond 20 per author per rolling day (mutation: no cap, or 21)", async () => {
    const a = await newAuthor();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const id = await newReference();
      await useRef(await newPost(a), id);
      ids.push(id);
    }
    for (const id of ids) await run(id, { access: "gone", diff: "gone" });
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) n FROM notifications WHERE recipient_id = $1 AND kind = 'reference_changed'`,
      [a],
    );
    expect(Number(rows[0]!.n)).toBe(20);
  });

  it("the cap does not count rows older than a day (mutation: count all time)", async () => {
    const a = await newAuthor();
    for (let i = 0; i < 20; i++) {
      const id = await newReference();
      const post = await newPost(a);
      await useRef(post, id);
      await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, kind, post_id, reference_id, reference_event, created_at)
         VALUES ($1, NULL, 'reference_changed', $2, $3, 'gone', now() - interval '2 days')`,
        [a, post, id],
      );
    }
    const fresh = await newReference();
    await useRef(await newPost(a), fresh);
    await run(fresh, { access: "gone", diff: "gone" });
    expect(await notifsFor(fresh)).toHaveLength(1);
  });

  it("carries no snapshot text anywhere in the row (mutation: copy the title into a column)", async () => {
    const a = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(a), id);
    const snapshot = { kind: "web", title: SECRET_TITLE, description: SECRET_TITLE } as never;
    await run(id, { access: "ok", diff: "changed", contentHash: "h9", snapshot });
    const { rows } = await client.query(`SELECT n.* FROM notifications n WHERE n.reference_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(SECRET_TITLE);
  });

  it("a notification failure never fails or rolls back the refresh (mutation: let the error escape)", async () => {
    const a = await newAuthor();
    const id = await newReference();
    await useRef(await newPost(a), id);
    const throwing = {
      NOTIFY: {
        getByName: () => {
          throw new Error("DO down");
        },
      },
    };
    const outcome = await refreshReference(client, id, {
      registry: createRegistry([connector({ access: "gone", diff: "gone" })]),
      ctx: fetchCtx,
      budget,
      now: NOW,
      notify: { env: throwing, ctx: notifyCtx },
    });
    await Promise.all(waited.splice(0));
    expect(outcome).toBe("refreshed");
    const { rows } = await client.query<{ gone_at: Date | null }>(`SELECT gone_at FROM "references" WHERE id = $1`, [id]);
    expect(rows[0]!.gone_at).not.toBeNull();
  });
});

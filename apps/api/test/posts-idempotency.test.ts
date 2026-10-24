// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * POST /posts Idempotency-Key (design 2026-10-13, migration 0037).
 *
 * Drives the Worker with a stubbed WEB binding so the purge calls are observable
 * (a replay must purge nothing). Each test uses its own key and title, so the
 * shared database never makes one test depend on another.
 */
const ALLOWED_ORIGIN = "http://localhost:8787";

interface CreateOpts {
  key?: string;
  title?: string;
  markdownSource?: string;
  status?: string;
  tags?: string[];
}

function createRequest(actor: Actor, opts: CreateOpts = {}): Request {
  const headers: Record<string, string> = {
    Origin: ALLOWED_ORIGIN,
    Cookie: actor.cookie,
    "X-CSRF-Token": actor.csrfToken,
    "content-type": "application/json",
  };
  if (opts.key !== undefined) headers["Idempotency-Key"] = opts.key;
  return new Request("https://api.test/posts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: opts.title ?? `Idem fixture ${crypto.randomUUID()}`,
      markdownSource: opts.markdownSource ?? "# body",
      status: opts.status ?? "published",
      tags: opts.tags ?? [],
    }),
  });
}

async function send(request: Request): Promise<{ response: Response; purges: string[][] }> {
  const purges: string[][] = [];
  const web = {
    fetch: async (_url: string, init: RequestInit) => {
      purges.push((JSON.parse(init.body as string) as { tags: string[] }).tags);
      return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
    },
  };
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, WEB: web } as never, ctx);
  await waitOnExecutionContext(ctx);
  return { response, purges };
}

async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => (await c.query(sql, params)).rows as T[]);
  await waitOnExecutionContext(ctx);
  return rows;
}

const rowsForKey = (authorId: string, key: string) =>
  query<{ id: string; title: string }>(`SELECT id, title FROM posts WHERE author_id = $1 AND idempotency_key = $2`, [authorId, key]);

const newKey = (): string => crypto.randomUUID();

let actor: Actor;
let other: Actor;

beforeAll(async () => {
  actor = await createVerifiedActor();
  other = await createVerifiedActor();
});

afterAll(deleteCreatedUsers);

describe("POST /posts — Idempotency-Key", () => {
  it("T1: the first use is 201; the same key and body again is 200 with the SAME id and slug, one row, and no purge", async () => {
    const key = newKey();
    const opts = { key, title: `T1 ${key}`, tags: ["idem-a", "idem-b"] };
    const first = await send(createRequest(actor, opts));
    expect(first.response.status).toBe(201);
    const created = (await first.response.json()) as { id: string; slug: string; status: string; username: string };
    expect(first.purges.length, "control: a first publish purges").toBeGreaterThan(0);

    const replay = await send(createRequest(actor, opts));
    expect(replay.response.status).toBe(200);
    expect(await replay.response.json()).toEqual(created);
    expect(replay.purges).toEqual([]);
    expect(await rowsForKey(actor.userId, key)).toHaveLength(1);
    // No second set of tag rows was written for the replay.
    const tagRows = await query<{ n: string }>(`SELECT count(*) AS n FROM post_tags WHERE post_id = $1`, [created.id]);
    expect(Number(tagRows[0]!.n)).toBe(2);
  });

  it("T2: the same key with a DIFFERENT title, body, status or tags is 422 IDEMPOTENCY_KEY_REUSED and changes nothing", async () => {
    const key = newKey();
    const base = { key, title: `T2 ${key}`, markdownSource: "# one", status: "draft", tags: ["x-one"] };
    expect((await send(createRequest(actor, base))).response.status).toBe(201);

    const variants: CreateOpts[] = [
      { ...base, title: `T2 other ${key}` },
      { ...base, markdownSource: "# two" },
      { ...base, status: "published" },
      { ...base, tags: ["x-two"] },
    ];
    for (const v of variants) {
      const { response } = await send(createRequest(actor, v));
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    const rows = await rowsForKey(actor.userId, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe(base.title);
  });

  it("T2b: a later EDIT of the post does not make a legitimate replay look different (the hash is of the request as submitted)", async () => {
    const key = newKey();
    const opts = { key, title: `T2b ${key}`, markdownSource: "# as submitted" };
    const first = await send(createRequest(actor, opts));
    const { id } = (await first.response.json()) as { id: string };
    await query(`UPDATE posts SET title = 'edited later', markdown_source = '# edited later' WHERE id = $1`, [id]);

    const replay = await send(createRequest(actor, opts));
    expect(replay.response.status).toBe(200);
    expect(((await replay.response.json()) as { id: string }).id).toBe(id);
  });

  it("T3: the same key from two different authors makes two posts", async () => {
    const key = newKey();
    const a = await send(createRequest(actor, { key, title: `T3 ${key}` }));
    const b = await send(createRequest(other, { key, title: `T3 ${key}` }));
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    const ida = ((await a.response.json()) as { id: string }).id;
    const idb = ((await b.response.json()) as { id: string }).id;
    expect(ida).not.toBe(idb);
  });

  it("T4: with no header, two creates of the same title are two posts (today's behaviour), 201 each", async () => {
    const title = `T4 ${newKey()}`;
    const a = await send(createRequest(actor, { title }));
    const b = await send(createRequest(actor, { title }));
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    expect(((await a.response.json()) as { id: string }).id).not.toBe(((await b.response.json()) as { id: string }).id);
    const keyed = await query(`SELECT 1 FROM posts WHERE author_id = $1 AND title = $2 AND idempotency_key IS NOT NULL`, [actor.userId, title]);
    expect(keyed).toHaveLength(0);
  });

  it("T5: two concurrent creates with one key: exactly one row, one 201 and one 200 with the same id", async () => {
    const key = newKey();
    const opts = { key, title: `T5 ${key}` };
    const [a, b] = await Promise.all([send(createRequest(actor, opts)), send(createRequest(actor, opts))]);
    expect([a.response.status, b.response.status].sort()).toEqual([200, 201]);
    const ids = [((await a.response.json()) as { id: string }).id, ((await b.response.json()) as { id: string }).id];
    expect(ids[0]).toBe(ids[1]);
    expect(await rowsForKey(actor.userId, key)).toHaveLength(1);
  });

  it("T6: a replay is never retried as a slug collision, and a slug collision with a NEW key still gets its suffix", async () => {
    const title = `T6 shared title ${newKey()}`;
    const k1 = newKey();
    const k2 = newKey();
    const first = await send(createRequest(actor, { key: k1, title }));
    const firstBody = (await first.response.json()) as { id: string; slug: string };

    // Same title, NEW key: the slug collides, the key does not: a suffixed slug, a new post.
    const second = await send(createRequest(actor, { key: k2, title }));
    expect(second.response.status).toBe(201);
    const secondBody = (await second.response.json()) as { id: string; slug: string };
    expect(secondBody.id).not.toBe(firstBody.id);
    expect(secondBody.slug).not.toBe(firstBody.slug);

    // The first key again: its slug collides too (same title), but the answer is the FIRST post.
    const replay = await send(createRequest(actor, { key: k1, title }));
    expect(replay.response.status).toBe(200);
    expect(await replay.response.json()).toMatchObject({ id: firstBody.id, slug: firstBody.slug });
  });

  it("T7: a malformed key is 400 naming only the header, and writes nothing", async () => {
    const title = `T7 ${newKey()}`;
    const bad = ["a".repeat(15), "a".repeat(65), "has space in it 12345", "semi;colon;12345678"];
    for (const key of bad) {
      const { response } = await send(createRequest(actor, { key, title }));
      expect(response.status, key).toBe(400);
      const body = (await response.json()) as { code: string; fields?: string[] };
      expect(body).toEqual({ code: "INVALID_INPUT", fields: ["Idempotency-Key"] });
      expect(JSON.stringify(body)).not.toContain(key.trim());
    }
    expect(await query(`SELECT 1 FROM posts WHERE author_id = $1 AND title = $2`, [actor.userId, title])).toHaveLength(0);
    // Control: the shortest and longest valid keys are accepted.
    expect((await send(createRequest(actor, { key: "a".repeat(16), title: `${title} min ${newKey()}` }))).response.status).toBe(201);
    expect((await send(createRequest(actor, { key: "b".repeat(64), title: `${title} max ${newKey()}` }))).response.status).toBe(201);
  });

  it("T8: a replay after the post was DELETED creates a new post (the key lives and dies with its post)", async () => {
    const key = newKey();
    const opts = { key, title: `T8 ${key}` };
    const first = await send(createRequest(actor, opts));
    const { id } = (await first.response.json()) as { id: string };
    await query(`DELETE FROM posts WHERE id = $1`, [id]);

    const again = await send(createRequest(actor, opts));
    expect(again.response.status).toBe(201);
    expect(((await again.response.json()) as { id: string }).id).not.toBe(id);
    expect(await rowsForKey(actor.userId, key)).toHaveLength(1);
  });
});

describe("posts idempotency columns (0037)", () => {
  async function insertRaw(key: string | null, hash: string | null): Promise<void> {
    await query(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, idempotency_key, idempotency_request_sha256)
       VALUES ($1, 'raw', $2, 'x', 'draft', $3, $4)`,
      [actor.userId, `raw-${crypto.randomUUID()}`, key, hash],
    );
  }

  it("T10: a key without a hash, a hash without a key, and a key with a space are all refused", async () => {
    await expect(insertRaw(newKey(), null)).rejects.toThrow(/posts_idempotency_pair_chk/);
    await expect(insertRaw(null, "abc")).rejects.toThrow(/posts_idempotency_pair_chk/);
    await expect(insertRaw("has a space in it 1234", "abc")).rejects.toThrow(/posts_idempotency_key_shape_chk/);
    // Control: a well-formed pair is accepted, so the refusals above are the checks.
    await expect(insertRaw(newKey(), "abc")).resolves.toBeUndefined();
  });

  it("T10b: the unique index is PARTIAL: many keyless posts are fine, a duplicate (author, key) is not", async () => {
    await insertRaw(null, null);
    await insertRaw(null, null);
    const key = newKey();
    await insertRaw(key, "abc");
    await expect(insertRaw(key, "abc")).rejects.toThrow(/posts_author_idempotency_key/);
  });
});

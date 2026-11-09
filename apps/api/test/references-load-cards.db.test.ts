// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRefCards } from "../src/references/load-cards";

/**
 * loadRefCards (M3.1b; spec 2, 4, 6): the ONLY thing the render path reads. Postgres only: a render never calls a
 * source API. Each test names the mutation that must turn it red.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let postId: string;
let otherPostId: string;
const userIds: string[] = [];
const referenceIds: string[] = [];

async function newPost(): Promise<string> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-load.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `l${uid.replace(/-/g, "").slice(0, 20)}`]);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source, status, published_at)
     VALUES ($1, $2, 'A title', 'body', 'published', now()) RETURNING id`,
    [uid, `s-${randomUUID()}`],
  );
  return rows[0]!.id;
}

interface Seed {
  snapshot?: unknown;
  liveState?: unknown;
  goneAt?: Date | null;
  key?: string;
  kind?: string;
}
async function use(post: string, token: string, seed: Seed = {}): Promise<void> {
  const snapshot = "snapshot" in seed ? seed.snapshot : { kind: "web", title: "The title", description: "Desc", siteName: "Site", finalUrl: "https://example.com/p" };
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, snapshot, live_state, gone_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [seed.kind ?? "web", seed.key ?? `web:https://example.com/${randomUUID()}`, randomUUID(), snapshot === null ? null : JSON.stringify(snapshot), seed.liveState === undefined ? null : JSON.stringify(seed.liveState), seed.goneAt ?? null],
  );
  referenceIds.push(rows[0]!.id);
  await client.query("INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, $3)", [post, rows[0]!.id, token]);
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  postId = await newPost();
  otherPostId = await newPost();
});

afterAll(async () => {
  await client.query("DELETE FROM posts WHERE author_id = ANY($1::uuid[])", [userIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe("loadRefCards", () => {
  it("returns a card keyed by token, with the deepLink from the resource key", async () => {
    await use(postId, "AAAAAAAAAAAA", { key: "web:https://example.com/page" });
    const cards = await loadRefCards(client, [postId]);
    expect(cards.get("AAAAAAAAAAAA")).toEqual({ kind: "web", deepLink: "https://example.com/page", title: "The title", description: "Desc", siteName: "Site" });
  });

  it("carries a remote image through", async () => {
    await use(postId, "BBBBBBBBBBBB", {
      snapshot: { kind: "web", title: "T", finalUrl: "https://example.com/p", image: { storage: "remote", url: "https://i.example.com/a.png", alt: "x" } },
    });
    expect((await loadRefCards(client, [postId])).get("BBBBBBBBBBBB")?.image).toEqual({ storage: "remote", url: "https://i.example.com/a.png", alt: "x" });
  });

  // Mutation that must fail: skip the null-snapshot handling (a takedown nulls the snapshot in place).
  it("a null snapshot is a null card (the 'no longer available' card)", async () => {
    await use(postId, "CCCCCCCCCCCC", { snapshot: null });
    const cards = await loadRefCards(client, [postId]);
    expect(cards.has("CCCCCCCCCCCC")).toBe(true);
    expect(cards.get("CCCCCCCCCCCC")).toBeNull();
  });

  it("a snapshot of the wrong shape is a null card, never a throw", async () => {
    await use(postId, "DDDDDDDDDDDD", { snapshot: { kind: "web", title: 42 } });
    await use(postId, "EEEEEEEEEEEE", { snapshot: "a string" });
    const cards = await loadRefCards(client, [postId]);
    expect(cards.get("DDDDDDDDDDDD")).toBeNull();
    expect(cards.get("EEEEEEEEEEEE")).toBeNull();
  });

  const OBSERVED = "2026-11-09T10:00:00.000Z";
  it.each([
    ["HHHHHHHHHHHA", "changed", { access: "ok", diff: "changed", observedAt: OBSERVED }, { label: "changed", asOf: OBSERVED }],
    ["HHHHHHHHHHHB", "resolved", { access: "ok", diff: "resolved", observedAt: OBSERVED }, { label: "resolved", asOf: OBSERVED }],
    ["HHHHHHHHHHHC", "gone", { access: "gone", diff: "gone", observedAt: OBSERVED }, { label: "gone", asOf: OBSERVED }],
    ["HHHHHHHHHHHD", "forbidden (turned private)", { access: "forbidden", diff: "unknown", observedAt: OBSERVED }, { label: "gone", asOf: OBSERVED }],
  ])("live state %s (%s) shows a status label", async (token, _name, liveState, status) => {
    await use(postId, token, { liveState });
    expect((await loadRefCards(client, [postId])).get(token)?.status).toEqual(status);
  });

  // Mutation that must fail: derive a status from a rate_limited/error observation (access != diff).
  it.each([
    ["JJJJJJJJJJJA", "rate_limited"],
    ["JJJJJJJJJJJB", "error"],
    ["JJJJJJJJJJJC", "not_modified"],
  ])("live state %s access=%s shows NO status (a change we cannot see is not gone)", async (token, access) => {
    await use(postId, token, { liveState: { access, diff: "unknown", observedAt: OBSERVED } });
    expect((await loadRefCards(client, [postId])).get(token)?.status).toBeUndefined();
  });

  it("a row marked gone is a gone card that keeps its title", async () => {
    await use(postId, "GGGGGGGGGGGG", { goneAt: new Date("2026-11-08T00:00:00Z") });
    const card = (await loadRefCards(client, [postId])).get("GGGGGGGGGGGG");
    expect(card?.title).toBe("The title");
    expect(card?.status?.label).toBe("gone");
  });

  it("only the asked posts' tokens, and a post with none is an empty map", async () => {
    await use(otherPostId, "OOOOOOOOOOOO");
    expect((await loadRefCards(client, [postId])).has("OOOOOOOOOOOO")).toBe(false);
    expect((await loadRefCards(client, [otherPostId])).has("OOOOOOOOOOOO")).toBe(true);
    expect((await loadRefCards(client, [randomUUID()])).size).toBe(0);
    expect((await loadRefCards(client, [])).size).toBe(0);
  });

  it("renders from stored rows only: no fetch, so it works with the global fetch removed", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("loadRefCards must not touch the network");
    }) as typeof fetch;
    try {
      await expect(loadRefCards(client, [postId])).resolves.toBeInstanceOf(Map);
    } finally {
      globalThis.fetch = real;
    }
  });
});

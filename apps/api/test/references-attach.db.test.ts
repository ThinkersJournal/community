// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { ConnectorError, MAX_REFERENCES_PER_POST, type FetchCtx, type FetchedPage } from "@thinkersjournal/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachReference, encodeBase32, newRefToken, type AttachDeps } from "../src/references/attach";
import { withOriginLimit, type LimiterLike } from "../src/references/origin-limit";

/**
 * attachReference (M3.1b; spec 4.1, 4.2, 9) against the real schema (migration 0042), with a fake guarded door.
 * Each test names the mutation that must turn it red.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const userIds: string[] = [];

interface Author {
  userId: string;
  postId: string;
}
async function newAuthor(): Promise<Author> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-attach.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `a${uid.replace(/-/g, "").slice(0, 20)}`]);
  return { userId: uid, postId: await newPostFor(uid) };
}
async function newPostFor(uid: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source, status, published_at)
     VALUES ($1, $2, 'A title', 'body', 'published', now()) RETURNING id`,
    [uid, `s-${randomUUID()}`],
  );
  return rows[0]!.id;
}

const html = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body>x</body></html>`;
function page(over: Partial<FetchedPage> = {}): FetchedPage {
  return { status: 200, finalUrl: "https://example.com/x", contentType: "text/html", headers: {}, body: html("T"), truncated: false, ...over };
}

/** A fake door that answers by URL and counts calls. */
function door(answer: (url: string) => FetchedPage | Error = (url) => page({ finalUrl: url, body: html(`Title of ${url}`) })) {
  const calls: string[] = [];
  const ctx: FetchCtx = {
    fetch: async (url) => {
      calls.push(String(url));
      const out = answer(String(url));
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { ctx, calls };
}

const deps = (ctx: FetchCtx, over: Partial<AttachDeps> = {}): AttachDeps => ({ ctx, ...over });
const unique = () => `https://example.com/${randomUUID()}`;

async function useCount(postId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM post_references WHERE post_id = $1", [postId]);
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  const { rows } = await client.query<{ reference_id: string }>(
    "SELECT reference_id FROM post_references WHERE post_id IN (SELECT id FROM posts WHERE author_id = ANY($1::uuid[]))",
    [userIds],
  );
  await client.query("DELETE FROM posts WHERE author_id = ANY($1::uuid[])", [userIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.reference_id)]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe("attachReference: the happy path", () => {
  it("stores a reference and a use with a 12-character base32 token", async () => {
    const a = await newAuthor();
    const d = door();
    const url = unique();
    const out = await attachReference(client, { postId: a.postId, authorId: a.userId, url }, deps(d.ctx));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.token).toMatch(/^[A-Z2-7]{12}$/);
    expect(out.reused).toBe(false);
    const { rows } = await client.query(
      `SELECT r.kind, r.resource_key, r.snapshot->>'title' AS title, pr.token, pr.position
         FROM post_references pr JOIN "references" r ON r.id = pr.reference_id WHERE pr.post_id = $1`,
      [a.postId],
    );
    expect(rows).toEqual([{ kind: "web", resource_key: `web:${url}`, title: `Title of ${url}`, token: out.token, position: 0 }]);
  });

  it("the token is not derived from the URL", async () => {
    const a = await newAuthor();
    const d = door();
    const url = unique();
    const first = await attachReference(client, { postId: a.postId, authorId: a.userId, url }, deps(d.ctx));
    const b = await newAuthor();
    const second = await attachReference(client, { postId: b.postId, authorId: b.userId, url }, deps(d.ctx));
    expect(first.ok && second.ok && first.token !== second.token).toBe(true);
  });

  it("numbers uses in order", async () => {
    const a = await newAuthor();
    const d = door();
    await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx));
    await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx));
    const { rows } = await client.query<{ position: number }>("SELECT position FROM post_references WHERE post_id = $1 ORDER BY position", [a.postId]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });
});

describe("attachReference: dedupe (spec 4.1)", () => {
  // Mutation that must fail: skip the lookup (always resolve) or drop the UNIQUE.
  it("the same URL from two posts shares one references row and fetches once", async () => {
    const [a, b] = [await newAuthor(), await newAuthor()];
    const d = door();
    const url = unique();
    const one = await attachReference(client, { postId: a.postId, authorId: a.userId, url }, deps(d.ctx));
    const two = await attachReference(client, { postId: b.postId, authorId: b.userId, url }, deps(d.ctx));
    expect(one.ok && two.ok && one.referenceId === two.referenceId).toBe(true);
    expect(two.ok && two.reused).toBe(true);
    expect(d.calls).toEqual([url]);
  });

  // Mutation that must fail: treat a stale row as fresh.
  it("a row older than the freshness window is resolved again; changed content is a NEW row (different hash)", async () => {
    const [a, b] = [await newAuthor(), await newAuthor()];
    const url = unique();
    let title = "First";
    const d = door((u) => page({ finalUrl: u, body: html(title) }));
    const one = await attachReference(client, { postId: a.postId, authorId: a.userId, url }, deps(d.ctx));
    title = "Second";
    const later = () => new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const two = await attachReference(client, { postId: b.postId, authorId: b.userId, url }, deps(d.ctx, { now: later }));
    expect(d.calls).toHaveLength(2);
    expect(one.ok && two.ok && one.referenceId !== two.referenceId).toBe(true);
  });

  it("the same content resolved again after the window reuses the same row", async () => {
    const [a, b] = [await newAuthor(), await newAuthor()];
    const url = unique();
    const d = door((u) => page({ finalUrl: u, body: html("Same") }));
    const one = await attachReference(client, { postId: a.postId, authorId: a.userId, url }, deps(d.ctx));
    const later = () => new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const two = await attachReference(client, { postId: b.postId, authorId: b.userId, url }, deps(d.ctx, { now: later }));
    expect(d.calls).toHaveLength(2);
    expect(one.ok && two.ok && one.referenceId === two.referenceId).toBe(true);
  });
});

describe("attachReference: a takedown sticks", () => {
  // Mutation that must fail: DO UPDATE SET snapshot = EXCLUDED.snapshot (a re-attach would refill a nulled snapshot).
  it("a nulled snapshot stays null when identical content is attached again", async () => {
    const [a, b] = [await newAuthor(), await newAuthor()];
    const url = unique();
    const d = door((u) => page({ finalUrl: u, body: html("Same") }));
    const one = await attachReference(client, { postId: a.postId, authorId: a.userId, url }, deps(d.ctx));
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    await client.query('UPDATE "references" SET snapshot = NULL WHERE id = $1', [one.referenceId]);
    const two = await attachReference(client, { postId: b.postId, authorId: b.userId, url }, deps(d.ctx));
    expect(two.ok && two.referenceId === one.referenceId).toBe(true);
    expect(d.calls).toHaveLength(2); // a null snapshot is never "fresh": it was resolved again...
    const { rows } = await client.query('SELECT snapshot FROM "references" WHERE id = $1', [one.referenceId]);
    expect(rows[0]?.snapshot).toBeNull(); // ...and still not refilled
  });
});

describe("token generation", () => {
  // Mutation that must fail: map with b % 31 (or any non-uniform mapping).
  it("maps every byte 0..255 with b & 31: each of the 32 symbols exactly 8 times", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encoded = encodeBase32(all);
    expect(encoded).toHaveLength(256);
    const counts = new Map<string, number>();
    for (const ch of encoded) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((n) => n === 8)).toBe(true);
    expect(encoded.slice(0, 32)).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
  });

  it("newRefToken draws its bytes from the injected generator, 12 of them", () => {
    let asked = 0;
    const token = newRefToken((bytes) => {
      asked = bytes.length;
      bytes.fill(255);
      return bytes;
    });
    expect(asked).toBe(12);
    expect(token).toBe("7".repeat(12));
  });

  // Mutation that must fail: use Math.random anywhere in attach.ts.
  it("attach.ts never uses Math.random", () => {
    const source = readFileSync(new URL("../src/references/attach.ts", import.meta.url), "utf8");
    expect(source).toContain("getRandomValues"); // positive control: the scan reads the real file
    expect(source).not.toContain("Math.random");
  });
});

describe("attachReference: tokens", () => {
  // Mutation that must fail: do not retry on a unique violation.
  it("retries with a fresh token when the first collides within the post", async () => {
    const a = await newAuthor();
    const d = door();
    const tokens = ["AAAAAAAAAAAA", "AAAAAAAAAAAA", "BBBBBBBBBBBB"];
    const newToken = () => tokens.shift() ?? "CCCCCCCCCCCC";
    const one = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx, { newToken }));
    const two = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx, { newToken }));
    expect(one.ok && one.token).toBe("AAAAAAAAAAAA");
    expect(two.ok && two.token).toBe("BBBBBBBBBBBB");
    expect(await useCount(a.postId)).toBe(2);
  });

  it("gives up with a typed failure (not a throw) if tokens keep colliding", async () => {
    const a = await newAuthor();
    const d = door();
    await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx, { newToken: () => "AAAAAAAAAAAA" }));
    const out = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx, { newToken: () => "AAAAAAAAAAAA" }));
    expect(out).toEqual({ ok: false, reason: "internal" });
    expect(await useCount(a.postId)).toBe(1);
  });
});

describe("attachReference: a failed resolve never loses the post (spec 4.2)", () => {
  // Mutation that must fail: let the failure throw out of attachReference.
  it.each<[string, Error, string]>([
    ["blocked", new ConnectorError("blocked_target"), "blocked_target"],
    ["timeout", new ConnectorError("timeout"), "timeout"],
    ["too large", new ConnectorError("too_large"), "too_large"],
    ["unsupported type", new ConnectorError("unsupported"), "unsupported"],
    ["a plain Error", new Error("boom"), "internal"],
  ])("%s: a typed failure, the post stays, no use is stored", async (_name, error, reason) => {
    const a = await newAuthor();
    const out = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(door(() => error).ctx));
    expect(out).toEqual({ ok: false, reason });
    expect(await useCount(a.postId)).toBe(0);
    const post = await client.query("SELECT 1 FROM posts WHERE id = $1", [a.postId]);
    expect(post.rowCount).toBe(1);
  });

  it("a 404 page is not_found; a 500 is upstream", async () => {
    const a = await newAuthor();
    const nf = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(door(() => page({ status: 404, body: "" })).ctx));
    const up = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(door(() => page({ status: 500, body: "" })).ctx));
    expect(nf).toEqual({ ok: false, reason: "not_found" });
    expect(up).toEqual({ ok: false, reason: "upstream" });
  });

  it("the connection stays usable after a failure (no transaction left open)", async () => {
    const a = await newAuthor();
    await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(door(() => new Error("boom")).ctx));
    const ok = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(door().ctx));
    expect(ok.ok).toBe(true);
  });

  it("refuses a URL that does not parse, and one no connector claims", async () => {
    const a = await newAuthor();
    const d = door();
    expect(await attachReference(client, { postId: a.postId, authorId: a.userId, url: "not a url" }, deps(d.ctx))).toEqual({ ok: false, reason: "invalid_url" });
    expect(await attachReference(client, { postId: a.postId, authorId: a.userId, url: "ftp://example.com/a" }, deps(d.ctx))).toEqual({ ok: false, reason: "unsupported" });
    expect(d.calls).toEqual([]);
  });

  it("a post that is not the caller's is post_not_found and nothing is fetched", async () => {
    const [a, b] = [await newAuthor(), await newAuthor()];
    const d = door();
    const out = await attachReference(client, { postId: a.postId, authorId: b.userId, url: unique() }, deps(d.ctx));
    expect(out).toEqual({ ok: false, reason: "post_not_found" });
    expect(d.calls).toEqual([]);
  });
});

describe("attachReference: the cap is serialised by the post row lock", () => {
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM posts WHERE id%FOR UPDATE%'",
      );
      if ((rows[0]?.n ?? 0) >= 1) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no attach ever waited on the post lock");
  }

  // Mutation that must fail: drop FOR UPDATE from the post lock (B would not wait, and both would be accepted).
  it("a second attach waits for the first to commit, and the 11th is then refused", async () => {
    const a = await newAuthor();
    const seed = door();
    for (let i = 0; i < MAX_REFERENCES_PER_POST - 1; i += 1) {
      expect((await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(seed.ctx))).ok).toBe(true);
    }
    const [c1, c2] = await Promise.all([0, 1].map(async () => {
      const c = new Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      return c;
    }));
    try {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const holdingLock = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const first = attachReference(
        c1!,
        { postId: a.postId, authorId: a.userId, url: unique() },
        deps(seed.ctx, { afterLock: async () => { holding(); await gate; } }),
      );
      await holdingLock; // A holds the post lock, inside its transaction, with 9 uses stored
      let secondDone = false;
      const second = attachReference(c2!, { postId: a.postId, authorId: a.userId, url: unique() }, deps(seed.ctx)).then((r) => {
        secondDone = true;
        return r;
      });
      await waitForLockWaiter(); // B is provably blocked on the lock, not merely slow
      expect(secondDone).toBe(false);
      release();
      expect((await first).ok).toBe(true);
      expect(await second).toEqual({ ok: false, reason: "too_many_references" });
      expect(await useCount(a.postId)).toBe(MAX_REFERENCES_PER_POST);
    } finally {
      await Promise.all([c1!.end(), c2!.end()]);
    }
  });
});

describe("attachReference: limits", () => {
  // Mutation that must fail: remove the per-post cap.
  it("the 11th reference on a post is refused", async () => {
    const a = await newAuthor();
    const d = door();
    for (let i = 0; i < MAX_REFERENCES_PER_POST; i += 1) {
      const out = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx));
      expect(out.ok).toBe(true);
    }
    const before = d.calls.length;
    const eleventh = await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx));
    expect(eleventh).toEqual({ ok: false, reason: "too_many_references" });
    expect(await useCount(a.postId)).toBe(MAX_REFERENCES_PER_POST);
    expect(d.calls.length).toBe(before); // refused before any network call
  });

  it("the cap holds for concurrent attaches (the post row is locked)", async () => {
    const a = await newAuthor();
    const d = door();
    const clients = await Promise.all(Array.from({ length: 12 }, async () => {
      const c = new Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      return c;
    }));
    try {
      const results = await Promise.all(
        clients.map((c) => attachReference(c, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(MAX_REFERENCES_PER_POST);
      expect(await useCount(a.postId)).toBe(MAX_REFERENCES_PER_POST);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  function windowLimiter(limit: number): LimiterLike & { keys: string[] } {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
      keys,
      limit: async ({ key }) => {
        keys.push(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: (counts.get(key) ?? 0) <= limit };
      },
    };
  }

  // Mutation that must fail: skip the limiter (or key it on something shared).
  it("the per-user attach limit refuses before any network call and is per user", async () => {
    const [a, b] = [await newAuthor(), await newAuthor()];
    const d = door();
    const limiter = windowLimiter(2);
    for (let i = 0; i < 2; i += 1) {
      expect((await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx, { limiter }))).ok).toBe(true);
    }
    const before = d.calls.length;
    expect(await attachReference(client, { postId: a.postId, authorId: a.userId, url: unique() }, deps(d.ctx, { limiter }))).toEqual({ ok: false, reason: "rate_limited" });
    expect(d.calls.length).toBe(before);
    expect((await attachReference(client, { postId: b.postId, authorId: b.userId, url: unique() }, deps(d.ctx, { limiter }))).ok).toBe(true);
    expect(limiter.keys.every((k) => k.includes(a.userId) || k.includes(b.userId))).toBe(true);
  });

  // Mutation that must fail: do not map OriginRateLimitedError to rate_limited.
  it("the per-origin fetch limit surfaces as rate_limited and other origins are unaffected", async () => {
    const a = await newAuthor();
    const d = door();
    const limited = { fetch: withOriginLimit(d.ctx.fetch, windowLimiter(1)) };
    expect((await attachReference(client, { postId: a.postId, authorId: a.userId, url: "https://one.example.com/a" }, deps(limited))).ok).toBe(true);
    expect(await attachReference(client, { postId: a.postId, authorId: a.userId, url: "https://one.example.com/b" }, deps(limited))).toEqual({ ok: false, reason: "rate_limited" });
    expect((await attachReference(client, { postId: a.postId, authorId: a.userId, url: "https://two.example.com/a" }, deps(limited))).ok).toBe(true);
  });
});

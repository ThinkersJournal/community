import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  CLIENT_IP_HEADER, SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, SEARCH_Q_MAX, SEARCH_Q_MIN,
} from "@thinkersjournal/shared";

import worker from "../src";
import { withClient } from "../src/db/client";

import { awaitLimiterBurstWindow } from "./helpers/limiter-window";

const created: string[] = [];
afterAll(async () => {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`DELETE FROM users WHERE id = ANY($1)`, [created]));
  await waitOnExecutionContext(ctx);
});

async function fetchWorker(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

async function seedAuthorWithPost(title: string): Promise<{ username: string }> {
  const ctx = createExecutionContext();
  const username = `sada_${crypto.randomUUID().slice(0, 8)}`;
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`s-${crypto.randomUUID()}@t.test`]);
    const id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio)
       VALUES ($1,$2,'Search Ada','bio text')`, [id, username]);
    await c.query(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body', 'published', now())`,
      [id, title, `sl-${crypto.randomUUID()}`]);
  });
  await waitOnExecutionContext(ctx);
  return { username };
}

// Seeds ONE author with `n` published posts whose titles all share `term` (so the
// trigram matches every one of them). A single author keeps this from polluting
// the people-search tests with `n` extra matching profiles. Returns the post
// titles for cross-page coverage assertions.
async function seedAuthorWithNPosts(term: string, n: number): Promise<string[]> {
  const ctx = createExecutionContext();
  const titles = Array.from({ length: n }, (_, i) => `${term} number ${i}`);
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`s-${crypto.randomUUID()}@t.test`]);
    const id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio)
       VALUES ($1,$2,'Pager Author','pager bio')`,
      [id, `pgr_${crypto.randomUUID().slice(0, 8)}`]);
    for (const title of titles) {
      await c.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1,$2,$3,'body', 'published', now())`,
        [id, title, `sl-${crypto.randomUUID()}`]);
    }
  });
  await waitOnExecutionContext(ctx);
  return titles;
}

/**
 * Seed ONE author with two published posts sharing `term`; hide one. Returns the
 * two titles so the test can assert the visible one is found and the hidden one
 * is not (M4 Task 7 — hidden content must not leak through search).
 */
async function seedVisibleAndHidden(term: string): Promise<{ visible: string; hidden: string }> {
  const ctx = createExecutionContext();
  const visible = `${term} visible one`;
  const hidden = `${term} hidden one`;
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`s-${crypto.randomUUID()}@t.test`]);
    const id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio)
       VALUES ($1,$2,'Hidden Search Author','bio text')`,
      [id, `hsa_${crypto.randomUUID().slice(0, 8)}`]);
    await c.query(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body','published',now())`,
      [id, visible, `sl-${crypto.randomUUID()}`]);
    const { rows: h } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body','published',now()) RETURNING id`,
      [id, hidden, `sl-${crypto.randomUUID()}`]);
    await c.query("UPDATE posts SET hidden_at = now() WHERE id = $1", [h[0]!.id]);
  });
  await waitOnExecutionContext(ctx);
  return { visible, hidden };
}

const U = "https://api.test";

describe("GET /public/search", () => {
  it("excludes an auto-HIDDEN post from search while a non-hidden one is still found (M4 Task 7)", async () => {
    const term = "zzhiddensearchterm";
    const { visible, hidden } = await seedVisibleAndHidden(term);
    const r = await fetchWorker(`${U}/public/search?q=${term}&type=posts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { title: string }[] };
    const titles = body.results.map((p) => p.title);
    expect(titles).toContain(visible);
    expect(titles).not.toContain(hidden);
  });

  /**
   * Enumeration fix (board item 59 follow-up). Same shape as the auto-hide
   * case above — visible+scrubbed pair seeded together, control proves the
   * query itself still works.
   */
  it("excludes a scrubbed (anonymised) author's post from posts search while an ordinary one is still found", async () => {
    const term = "zzscrubbedsearchterm";
    const ctx = createExecutionContext();
    let scrubbedUserId = "";
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
        [`s-${crypto.randomUUID()}@t.test`]);
      scrubbedUserId = rows[0]!.id;
      created.push(scrubbedUserId);
      await c.query(
        `INSERT INTO profiles (user_id, username, display_name, bio)
         VALUES ($1,$2,'Scrubbed Search Author','bio text')`,
        [scrubbedUserId, `ssa_${crypto.randomUUID().slice(0, 8)}`]);
      await c.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1,$2,$3,'body','published',now())`,
        [scrubbedUserId, `${term} scrubbed one`, `sl-${crypto.randomUUID()}`]);
    });
    const scrubCtx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, scrubCtx, (c) =>
      c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [scrubbedUserId]),
    );
    await waitOnExecutionContext(scrubCtx);

    const { visible } = await seedVisibleAndHidden(term); // reuses its "visible" leg as the control

    const r = await fetchWorker(`${U}/public/search?q=${term}&type=posts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { title: string }[] };
    const titles = body.results.map((p) => p.title);
    expect(titles).not.toContain(`${term} scrubbed one`);
    expect(titles).toContain(visible);
  });

  it("finds a published post by a partial+typo query, no session needed", async () => {
    await seedAuthorWithPost("Quantum Chromodynamics Primer");
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("chromodynamcs")}&type=posts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { title: string }[]; nextOffset: number | null };
    expect(body.results.some((p) => p.title === "Quantum Chromodynamics Primer")).toBe(true);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("finds a person by partial name on the people tab", async () => {
    const { username } = await seedAuthorWithPost("Irrelevant Title Zzz");
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Search Ada")}&type=people`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { username: string }[] };
    expect(body.results.some((p) => p.username === username)).toBe(true);
  });

  /**
   * Enumeration fix (board item 59 follow-up), people-tab leg. `username`
   * itself is still a live search target after the scrub (display_name/bio
   * are already NULLed), so this pins that the shared scrubbed string does
   * not surface here either. Control: an ordinary person with a distinct
   * display_name is still found in the same pass.
   */
  it("excludes a scrubbed (anonymised) account from people search", async () => {
    const uniqueTerm = `Zqscrub${crypto.randomUUID().slice(0, 8)}`;
    const ctx = createExecutionContext();
    let scrubbedUserId = "";
    let scrubbedUsername = "";
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
        [`s-${crypto.randomUUID()}@t.test`]);
      scrubbedUserId = rows[0]!.id;
      created.push(scrubbedUserId);
      scrubbedUsername = `${uniqueTerm.toLowerCase()}h`;
      await c.query(
        `INSERT INTO profiles (user_id, username, display_name, bio)
         VALUES ($1,$2,$3,'bio text')`,
        [scrubbedUserId, scrubbedUsername, uniqueTerm]);
    });
    await waitOnExecutionContext(ctx);

    const scrubCtx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, scrubCtx, (c) =>
      c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [scrubbedUserId]),
    );
    await waitOnExecutionContext(scrubCtx);

    // Control: an ordinary person, findable by their own username substring.
    const { username: control } = await seedAuthorWithPost("Control Post Title");

    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent(uniqueTerm)}&type=people`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { username: string }[] };
    expect(body.results.some((p) => p.username === scrubbedUsername)).toBe(false);

    const r2 = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Search Ada")}&type=people`);
    const body2 = (await r2.json()) as { results: { username: string }[] };
    expect(body2.results.some((p) => p.username === control)).toBe(true);
  });

  /**
   * handle-at-signup Task 4/6: people search no longer filters on the retired
   * username-chosen onboarding flag — every account has a handle from
   * signup, there is no "not yet chosen" state to exclude, and (as of Task 6)
   * the column itself is gone. A freshly-created profile must appear with no
   * extra precondition.
   */
  it("finds a freshly-created author with no extra precondition", async () => {
    const ctx = createExecutionContext();
    const username = `fresh_${crypto.randomUUID().slice(0, 8)}`;
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
        [`s-${crypto.randomUUID()}@t.test`]);
      const id = rows[0]!.id;
      created.push(id);
      await c.query(
        `INSERT INTO profiles (user_id, username, display_name, bio)
         VALUES ($1,$2,'Fresh Signup','writes about being new here')`, [id, username]);
    });
    await waitOnExecutionContext(ctx);

    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Fresh Signup")}&type=people`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { username: string }[] };
    expect(body.results.some((p) => p.username === username)).toBe(true);
  });

  it("400s on q shorter than 2, longer than 100, and on a bad type/offset", async () => {
    expect((await fetchWorker(`${U}/public/search?q=a`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=${"x".repeat(101)}`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&type=bogus`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&offset=-1`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&offset=201`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&offset=abc`)).status).toBe(400);
  });

  it("defaults type to posts and returns nextOffset null on a small result set", async () => {
    // Seed our OWN distinctively-titled post so this test is self-contained (no
    // dependence on another test's seed or on run order). No `type` param — the
    // default MUST be posts. Assert on a POST-shaped field: people results carry no
    // `title`, so this fails if the default became people.
    const title = "Xylophone Sentinel Defaulting Post";
    await seedAuthorWithPost(title);
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Xylophone Sentinel")}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { title?: string }[]; nextOffset: number | null };
    expect(body.results.some((p) => p.title === title)).toBe(true);
    expect(body.nextOffset).toBeNull();
  });

  it("accepts the valid-side length/offset boundaries (q=MIN, q=MAX, offset=MAX)", async () => {
    // Guards against an off-by-one flip (`>` -> `>=`) rejecting legitimate input:
    // the shortest/longest allowed q, and the deepest offset the pager emits.
    expect((await fetchWorker(`${U}/public/search?q=${"a".repeat(SEARCH_Q_MIN)}`)).status).toBe(200);
    expect((await fetchWorker(`${U}/public/search?q=${"a".repeat(SEARCH_Q_MAX)}`)).status).toBe(200);
    expect(
      (await fetchWorker(`${U}/public/search?q=abc&offset=${SEARCH_MAX_OFFSET}`)).status,
    ).toBe(200);
  });

  it("paginates a >PAGE_SIZE result set: full first page + capped nextOffset, then the tail", async () => {
    const term = "zqpagerterm"; // distinctive: matches all seeded titles, nothing else in the DB
    const n = SEARCH_PAGE_SIZE + 1; // 21 — exactly one over a full page
    await seedAuthorWithNPosts(term, n);

    const first = await fetchWorker(`${U}/public/search?q=${term}&type=posts`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      results: { title: string }[];
      nextOffset: number | null;
    };
    // Full page, and the +1 sentinel drives a nextOffset one page forward.
    expect(firstBody.results.length).toBe(SEARCH_PAGE_SIZE);
    expect(firstBody.nextOffset).toBe(SEARCH_PAGE_SIZE);

    const second = await fetchWorker(`${U}/public/search?q=${term}&type=posts&offset=${SEARCH_PAGE_SIZE}`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      results: { title: string }[];
      nextOffset: number | null;
    };
    // The 21st row lands alone on the tail page; no sentinel beyond it.
    expect(secondBody.results.length).toBe(1);
    expect(secondBody.nextOffset).toBeNull();

    // The two pages together cover all 21 distinct rows (proves LIMIT/OFFSET +
    // the slice of the +1 sentinel actually walked the whole set, no overlap).
    const page1 = new Set(firstBody.results.map((r) => r.title));
    const tailTitle = secondBody.results[0]!.title;
    expect(page1.has(tailTitle)).toBe(false);
    expect(new Set([...page1, tailTitle]).size).toBe(n);
  });

  /**
   * ⚠️ WINDOW-ROLLOVER GUARD (fix round 3 — superseding rounds 1 and 2's
   * retry-after-the-fact approach, which round 2's CI failure showed was
   * still incomplete). Miniflare's `RateLimit` binding is a FIXED wall-clock
   * window — `epoch = floor(now / 60000)`, not a sliding window counted from
   * a burst's own first request — so a burst that straddles a minute
   * boundary can have its count silently reset mid-flight. `awaitLimiterBurstWindow`
   * (./helpers/limiter-window.ts, already used by login/signup/forgot-password/
   * dsa-notice-route) holds the burst off until there is a full budget of the
   * CURRENT window left, rather than detecting a roll-over after it already
   * broke the assertion. Combined with a UNIQUE key per test run
   * (`crypto.randomUUID()`), so no two runs — or this test and any other in
   * the file — ever share a bucket.
   */
  async function searchWithIp(ip: string): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${U}/public/search?q=ratelimittest&type=posts`, {
        headers: { "CF-Connecting-IP": ip },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function searchWithClientIpHeader(ip: string): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${U}/public/search?q=ratelimittest&type=posts`, {
        headers: { [CLIENT_IP_HEADER]: ip },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  // Matches SEARCH_LIMITER's `simple: { limit: 30, period: 60 }` in
  // apps/api/wrangler.jsonc — exactly `SEARCH_LIMIT` requests are allowed,
  // the next one is the 429.
  const SEARCH_LIMIT = 30;

  /**
   * Enumeration/DoS-hardening fix (spec-vs-code audit, 2026-09-27):
   * SEARCH_LIMITER. IP-keyed only (no session on this route) — a UNIQUE key
   * per run (see the window-rollover guard above) so this test's own budget
   * burn cannot pollute or be polluted by the rest of this file, which sends
   * no `CF-Connecting-IP` at all and therefore skips the limiter entirely (an
   * unknown IP is not pooled into a shared bucket; see the test below).
   */
  it("throttles a burst of searches from one IP (429 RATE_LIMITED)", async () => {
    const ip = `test-${crypto.randomUUID()}`;
    await awaitLimiterBurstWindow();

    for (let i = 0; i < SEARCH_LIMIT; i++) {
      expect((await searchWithIp(ip)).status).toBe(200);
    }
    const limited = await searchWithIp(ip);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("RATE_LIMITED");

    // Immediately after the burst: the SAME ip is still throttled right now.
    expect((await searchWithIp(ip)).status).toBe(429);
  });

  /**
   * The web->api forwarding fix (confirmed production bug): `apiFetch` can no
   * longer rely on `CF-Connecting-IP` surviving the Service Binding, so it
   * re-sends the browser's IP as `CLIENT_IP_HEADER` and `clientIp()`
   * (src/http/client-ip.ts) reads THAT first. Mirrors the burst test just
   * above but keyed on the new header, with its own unique per-run keys so
   * neither test's budget burn can pollute the other.
   */
  it("SEARCH_LIMITER buckets on X-TJ-Client-IP — different values don't share a bucket, the same value does", async () => {
    const ipA = `test-${crypto.randomUUID()}`;
    const ipB = `test-${crypto.randomUUID()}`;
    await awaitLimiterBurstWindow();

    for (let i = 0; i < SEARCH_LIMIT; i++) {
      expect((await searchWithClientIpHeader(ipA)).status).toBe(200);
    }
    const limited = await searchWithClientIpHeader(ipA);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("RATE_LIMITED");

    // Immediately after the burst: ipA is still throttled right now.
    expect((await searchWithClientIpHeader(ipA)).status).toBe(429);

    // A DIFFERENT X-TJ-Client-IP is NOT throttled by ipA's exhausted bucket.
    expect((await searchWithClientIpHeader(ipB)).status).toBe(200);
  });

  /**
   * ⚠️ EVERY 429 IS LOGGED (brute-force review 1, I3). A search scrape that hits
   * SEARCH_LIMITER must leave a `security: rate_limited` line the alerting
   * follow-up can count — with the route, the bucket name and the IP.
   */
  it("logs its 429 as a `security: rate_limited /public/search` line with the IP", async () => {
    const ip = `test-${crypto.randomUUID()}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await awaitLimiterBurstWindow();
      for (let i = 0; i < SEARCH_LIMIT; i++) await searchWithIp(ip);
      expect((await searchWithIp(ip)).status).toBe(429);
      const lines = warn.mock.calls
        .filter((args) => typeof args[0] === "string" && args[0].startsWith("security: rate_limited /public/search"))
        .map((args) => JSON.stringify(args));
      expect(lines.some((l) => l.includes(ip)), `saw ${JSON.stringify(warn.mock.calls)}`).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * ⚠️ AN UNKNOWN IP SKIPS THE LIMITER (review 1, I3). It used to fall back to one
   * shared "unknown" bucket: had the IP ever gone missing (off Cloudflare, a web
   * regression), one client could spend it and deny search to everyone. Same rule
   * as every limiter the brute-force work added. More than SEARCH_LIMIT IP-less
   * searches in one window must all succeed.
   */
  it("does NOT pool IP-less searches into one shared bucket", async () => {
    await awaitLimiterBurstWindow();
    for (let i = 0; i <= SEARCH_LIMIT; i++) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${U}/public/search?q=ratelimittest&type=posts`), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status, `IP-less search ${i + 1}`).toBe(200);
    }
  });
});

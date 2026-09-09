# M4 Module 2b-i — Moderation Queue (Read Path) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A moderator can *see* the review queue — the ranked list of reported posts and comments awaiting a decision — through an Access-gated endpoint.

**Architecture:** The queue is a **derived query, not a table**: a target is open if it has reports and no `content_*` action after the newest one. It reads the `moderation_actions` log shipped in module 2a as its single source of truth for "handled." No status column, ever.

**Tech Stack:** Cloudflare Workers (workerd), Neon Postgres 18, `pg` over Hyperdrive, node-pg-migrate, vitest (`pool` = workerd, `node` = plain Node).

**Spec:** `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` §4.1–4.2 (merged). Read them before starting.

## Global Constraints

- ⚠️ **DO NOT DENORMALIZE THE QUEUE INTO A `status` COLUMN.** The spec forbids it by name. A status column is a second copy of a fact the audit log already holds, and it fails silently: the column and the log disagree, the queue shows the column, and the log — the thing that must be true for appeals and DSA statements of reasons — is the copy nobody reads. If the derivation is ever too slow the answer is an index or a materialized view derived *from* the log, never a hand-maintained duplicate.
- **No `reporter_trust`, no AI score.** Ranking is severity, then report count, then oldest-first. Explainable, and every input exists today.
- **Severity order (founder decision, fixed):** `sexual` → `violence` → `hate` → `harassment` → `ip_infringement` → `spam` → `other`.
- **Admin authority comes only from the Access JWT** via `requireAdmin` (module 2a). `SessionData.roles` exists, is always `[]`, and must never be read for authorization.
- **This slice is READ-ONLY.** No decision routes, no mutations, no author-facing changes, no email. Those are 2b-ii.
- Every error response goes through `errorResponse(code, status)`. Every route goes in the `ROUTES` table.

## ⚠️ Two facts measured against the live schema before this plan was written

1. **The index the spec promised does not exist.** Design §4.2 states *"so `0013` adds `reports (created_at)`."* It does not — `0013` creates four indexes, all on `moderation_actions`, and `pg_indexes` on `reports` shows only `0012`'s two *partial* indexes plus the pkey and uniques. The Task 1 brief for 2a was scoped to `moderation_actions`, and the reviewer verified the implementation against **the brief**, not against the design. **Nobody checked the layer above.** Task 1 here creates it.
2. **Reopening requires a *different* reporter.** `reports_reporter_post_unique` / `reports_reporter_comment_unique` mean one report per reporter per target. So "a new report reopens a decided item" holds only for a **distinct** reporter — the same person cannot re-report to reopen. Found by a seeded transaction failing, not by reading the schema. The Task 2 tests encode it.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/0014_reports_created_idx.sql` | **Create.** The missing `reports (created_at)` index. |
| `apps/api/src/moderation/queue.ts` | **Create.** The derived queue query. One exported function; no HTTP, no connection management. |
| `apps/api/src/routes/admin.ts` | **Modify.** Add `handleAdminQueue`. |
| `apps/api/src/routes.ts` | **Modify.** Register `GET /admin/queue`. |
| `apps/api/test/moderation-queue.db.test.ts` | **Create.** The semantics: open, closed by action, reopened, ranking. |
| `apps/api/test/admin-queue-route.test.ts` | **Create.** The gate and the response shape. |

### ⚠️ A declared exemption, named by property rather than category

`src/moderation/queue.ts` deliberately reads **hidden** rows — that is its entire purpose, since the queue exists to show a moderator what auto-hide took down. The `hidden-at-read-guard` structural test scans `src/routes/**` only, so a query living in `src/moderation/` is **outside its scope and would escape it silently**.

That is an undeclared exemption, and an exemption nobody declared is the shape that bites. So state the property, not the category:

> **The property assumed:** this query is reachable only through `requireAdmin`, i.e. only by a verified Cloudflare Access principal — never by a member session and never by an anonymous request.
> **Not the category:** "it's in `src/moderation/`, which the guard doesn't scan."

Task 3 **re-checks that property with a test**, rather than trusting the file's location.

---

## Task 1: Migration 0014 — the missing `reports (created_at)` index

**Files:**
- Create: `apps/api/migrations/0014_reports_created_idx.sql`
- Modify: `apps/api/test/migrations.db.test.ts`

**Interfaces:** Consumes nothing. Produces the index `reports_created_idx` that Task 2's ordering relies on.

- [ ] **Step 1: Write the failing assertion**

In `apps/api/test/migrations.db.test.ts`, add to the "up" assertion blocks (there is one round-trip `it()`; it has a pre-down check, a post-down check, and a post-re-up check — add to **all three**, `true` / `false` / `true`):

```ts
      expect(await indexExists(client, "reports_created_idx")).toBe(true);
```

If `indexExists` does not exist in that file, add it beside the existing `tableExists` / `columnExists` helpers:

```ts
async function indexExists(client: Client, indexName: string): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [indexName],
  );
  return Number(rows[0]!.n) > 0;
}
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `pnpm --filter @thinkersjournal/api exec vitest run --project node test/migrations.db.test.ts`
Expected: FAIL — the index does not exist.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/0014_reports_created_idx.sql`:

```sql
-- Up Migration
-- The moderation queue (module 2b) orders open items globally by recency.
--
-- ⚠️ 0012 gave `reports` only PARTIAL indexes — (post_id, created_at) WHERE
-- post_id IS NOT NULL, and the comment equivalent. Neither can serve an
-- ordering across BOTH target kinds, and neither covers a scan by time alone.
--
-- The 2026-09-06 design says migration 0013 adds this. It did not: 0013's four
-- indexes are all on moderation_actions. The 2a task brief was scoped to that
-- table and the review checked the implementation against the brief rather than
-- against the design, so the gap survived both. It is created here.
CREATE INDEX reports_created_idx ON reports (created_at);

-- Down Migration
DROP INDEX IF EXISTS reports_created_idx;
```

- [ ] **Step 4: Apply and verify it PASSES**

Run: `pnpm --filter @thinkersjournal/api run migrate:test && pnpm --filter @thinkersjournal/api exec vitest run --project node test/migrations.db.test.ts`
Expected: PASS. ⚠️ The `&&` is deliberate — an unchained migrate step that fails would let the test run against an unmigrated database and report a pass that means nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/0014_reports_created_idx.sql apps/api/test/migrations.db.test.ts
git commit -m "feat(m4): add the reports(created_at) index the queue ordering needs"
```

---

## Task 2: The derived queue query

**Files:**
- Create: `apps/api/src/moderation/queue.ts`
- Create: `apps/api/test/moderation-queue.db.test.ts`

**Interfaces:**
- Consumes: Task 1's index; `moderation_actions` (module 2a); the caller's `pg.Client`.
- Produces:
  ```ts
  export interface QueueItem {
    readonly kind: "post" | "comment";
    readonly targetId: string;
    readonly excerpt: string;
    readonly hiddenAt: Date | null;
    readonly reportCount: number;
    readonly severityRank: number;
    readonly oldestReportAt: Date;
  }
  export const QUEUE_PAGE_SIZE = 50;
  export async function listOpenQueue(c: Client, limit?: number): Promise<QueueItem[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/moderation-queue.db.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { listOpenQueue } from "../src/moderation/queue";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const madeUsers: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => { await client.end(); });

// Every fixture hangs off a user; ON DELETE CASCADE removes posts, comments and
// reports with it. moderation_actions has NO FK (module 2a, deliberately), so
// its rows are cleaned explicitly.
afterEach(async () => {
  if (madeUsers.length > 0) {
    await client.query(`DELETE FROM moderation_actions WHERE actor_admin = 'queue-test'`);
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
    madeUsers.length = 0;
  }
});

async function mkUser(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'h', now())`, [id, `${id}@queue.test`],
  );
  madeUsers.push(id);
  return id;
}

async function mkPost(author: string, title: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO posts (id, author_id, title, slug, markdown_source, status, published_at)
     VALUES ($1, $2, $3, $4, 'body', 'published', now())`,
    [id, author, title, `${id}-slug`],
  );
  return id;
}

async function report(reporter: string, postId: string, reason: string, minutesAgo = 0): Promise<void> {
  await client.query(
    `INSERT INTO reports (reporter_id, post_id, reason, created_at)
     VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
    [reporter, postId, reason, String(minutesAgo)],
  );
}

async function act(postId: string, action: string): Promise<void> {
  await client.query(
    `INSERT INTO moderation_actions (actor_admin, action, post_id, reason)
     VALUES ('queue-test', $1, $2, 'test')`, [action, postId],
  );
}

const idsOf = (items: { targetId: string }[]): string[] => items.map((i) => i.targetId);

describe("listOpenQueue", () => {
  it("returns a reported post as an OPEN item, with its report count", async () => {
    const author = await mkUser();
    const r1 = await mkUser();
    const post = await mkPost(author, "Reported");
    await report(r1, post, "spam");

    const items = await listOpenQueue(client);
    const mine = items.find((i) => i.targetId === post);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("post");
    expect(mine!.reportCount).toBe(1);
  });

  it("⚠️ SEVERITY OUTRANKS COUNT — one 'sexual' report sorts above two 'spam'", async () => {
    const author = await mkUser();
    const [r1, r2, r3] = [await mkUser(), await mkUser(), await mkUser()];
    const spammy = await mkPost(author, "Spammy");
    const severe = await mkPost(author, "Severe");
    await report(r1, spammy, "spam", 30);
    await report(r2, spammy, "spam", 20);
    await report(r3, severe, "sexual", 10);

    const ids = idsOf(await listOpenQueue(client));
    expect(ids.indexOf(severe)).toBeLessThan(ids.indexOf(spammy));
  });

  it("DROPS an item once a content_ action is recorded after its newest report", async () => {
    const author = await mkUser();
    const r1 = await mkUser();
    const post = await mkPost(author, "Decided");
    await report(r1, post, "spam", 10);
    expect(idsOf(await listOpenQueue(client))).toContain(post);

    await act(post, "content_keep_hidden");
    expect(idsOf(await listOpenQueue(client))).not.toContain(post);
  });

  it("⚠️ REOPENS when a DIFFERENT reporter reports after the decision", async () => {
    // The same reporter cannot reopen: reports_reporter_post_unique allows one
    // report per reporter per target. Only a distinct reporter can.
    const author = await mkUser();
    const r1 = await mkUser();
    const r2 = await mkUser();
    const post = await mkPost(author, "Reopened");
    await report(r1, post, "spam", 10);
    await act(post, "content_keep_hidden");
    expect(idsOf(await listOpenQueue(client))).not.toContain(post);

    await report(r2, post, "hate");
    const items = await listOpenQueue(client);
    expect(idsOf(items)).toContain(post);
    expect(items.find((i) => i.targetId === post)!.reportCount).toBe(2);
  });

  it("a NON-content action does NOT close an item (only content_ decisions do)", async () => {
    const author = await mkUser();
    const r1 = await mkUser();
    const post = await mkPost(author, "Warned");
    await report(r1, post, "spam", 10);
    await act(post, "user_warn");
    expect(idsOf(await listOpenQueue(client))).toContain(post);
  });
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `pnpm --filter @thinkersjournal/api exec vitest run --project node test/moderation-queue.db.test.ts`
Expected: FAIL — cannot resolve `../src/moderation/queue`.

- [ ] **Step 3: Implement**

Create `apps/api/src/moderation/queue.ts`. ⚠️ **The SQL below was executed against the live schema before this plan was written** — it parses, and its open/closed/reopen/ranking semantics were each proven in a rolled-back transaction. Use it as given.

```ts
/**
 * THE MODERATION REVIEW QUEUE — a derived query, never a table.
 *
 * ⚠️ A target is OPEN if it has at least one report and NO `content_*` action
 * recorded after its newest report. That definition lives here and nowhere
 * else: `moderation_actions` is the single source of truth for "handled".
 *
 * ⚠️ DO NOT ADD A `status` COLUMN. The spec forbids it by name. A status column
 * is a second copy of a fact the log already holds, and the two drift silently —
 * the queue would show the column while the log, the thing that must be true for
 * appeals and DSA statements of reasons, is the copy nobody reads. If this ever
 * gets too slow the answer is an index or a materialized view derived FROM the
 * log, never a hand-maintained duplicate of it.
 *
 * ⚠️ THIS QUERY DELIBERATELY READS HIDDEN ROWS. That is its purpose — the queue
 * exists to show a moderator what auto-hide took down. It therefore does NOT
 * carry `hidden_at IS NULL`, and it lives outside `src/routes/`, which is the
 * only tree `test/hidden-at-read-guard.node.test.ts` scans.
 *
 * The property that makes that safe is NOT its directory. It is:
 *   ⚠️ THIS FUNCTION IS REACHABLE ONLY THROUGH `requireAdmin` — a verified
 *   Cloudflare Access principal, never a member session, never anonymous.
 * `test/admin-queue-route.test.ts` re-checks that property rather than trusting
 * the file's location.
 *
 * Takes the caller's `pg.Client` and never opens its own connection, matching
 * `auto-hide.ts`, `is-blocked.ts` and `actions.ts`.
 */
import type { Client } from "pg";

export const QUEUE_PAGE_SIZE = 50;

export interface QueueItem {
  readonly kind: "post" | "comment";
  readonly targetId: string;
  /** Post title, or the first 120 characters of a comment. */
  readonly excerpt: string;
  /** Non-null when auto-hide (or a prior decision) has taken it down. */
  readonly hiddenAt: Date | null;
  readonly reportCount: number;
  /** 7 = sexual … 1 = other. Higher sorts first. */
  readonly severityRank: number;
  /** Age of the oldest unactioned report — surfaced so an item cannot rot unseen. */
  readonly oldestReportAt: Date;
}

interface QueueRow {
  kind: "post" | "comment";
  target_id: string;
  excerpt: string;
  hidden_at: Date | null;
  report_count: number;
  severity_rank: number;
  oldest_report_at: Date;
}

// Founder decision, fixed: sexual > violence > hate > harassment >
// ip_infringement > spam > other. Inline in SQL so ordering happens in the
// database rather than over a truncated page.
const SEVERITY_CASE = `CASE r.reason
        WHEN 'sexual' THEN 7 WHEN 'violence' THEN 6 WHEN 'hate' THEN 5
        WHEN 'harassment' THEN 4 WHEN 'ip_infringement' THEN 3
        WHEN 'spam' THEN 2 ELSE 1 END`;

const SELECT_OPEN_QUEUE = `
WITH post_reports AS (
  SELECT r.post_id AS target_id, count(*)::int AS report_count,
         min(r.created_at) AS oldest_report_at, max(r.created_at) AS newest_report_at,
         max(${SEVERITY_CASE}) AS severity_rank
    FROM reports r WHERE r.post_id IS NOT NULL GROUP BY r.post_id
),
comment_reports AS (
  SELECT r.comment_id AS target_id, count(*)::int AS report_count,
         min(r.created_at) AS oldest_report_at, max(r.created_at) AS newest_report_at,
         max(${SEVERITY_CASE}) AS severity_rank
    FROM reports r WHERE r.comment_id IS NOT NULL GROUP BY r.comment_id
)
SELECT 'post' AS kind, pr.target_id, p.title AS excerpt, p.hidden_at,
       pr.report_count, pr.severity_rank, pr.oldest_report_at
  FROM post_reports pr JOIN posts p ON p.id = pr.target_id
 WHERE NOT EXISTS (SELECT 1 FROM moderation_actions ma
                    WHERE ma.post_id = pr.target_id
                      AND ma.action LIKE 'content\\_%'
                      AND ma.created_at > pr.newest_report_at)
UNION ALL
SELECT 'comment' AS kind, cr.target_id, left(c.body_markdown, 120) AS excerpt, c.hidden_at,
       cr.report_count, cr.severity_rank, cr.oldest_report_at
  FROM comment_reports cr JOIN comments c ON c.id = cr.target_id
 WHERE NOT EXISTS (SELECT 1 FROM moderation_actions ma
                    WHERE ma.comment_id = cr.target_id
                      AND ma.action LIKE 'content\\_%'
                      AND ma.created_at > cr.newest_report_at)
 ORDER BY severity_rank DESC, report_count DESC, oldest_report_at ASC
 LIMIT $1`;

export async function listOpenQueue(c: Client, limit = QUEUE_PAGE_SIZE): Promise<QueueItem[]> {
  const { rows } = await c.query<QueueRow>(SELECT_OPEN_QUEUE, [limit]);
  return rows.map((r) => ({
    kind: r.kind,
    targetId: r.target_id,
    excerpt: r.excerpt,
    hiddenAt: r.hidden_at,
    reportCount: r.report_count,
    severityRank: r.severity_rank,
    oldestReportAt: r.oldest_report_at,
  }));
}
```

⚠️ **Note the doubled backslash in `'content\\_%'`.** In SQL, `\_` escapes the LIKE wildcard so `content_` matches literally rather than `content` + any character; in a TypeScript template literal the backslash must itself be escaped. Getting this wrong makes the pattern match more actions than intended, which would close queue items that were never decided.

- [ ] **Step 4: Run and verify it PASSES**

Run: `pnpm --filter @thinkersjournal/api exec vitest run --project node test/moderation-queue.db.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/moderation/queue.ts apps/api/test/moderation-queue.db.test.ts
git commit -m "feat(m4): derived moderation queue — open items ranked by severity"
```

---

## Task 3: `GET /admin/queue`

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes.ts`
- Create: `apps/api/test/admin-queue-route.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (2a), `listOpenQueue` + `QueueItem` (Task 2), `withClient`.
- Produces: `handleAdminQueue`, registered as `GET /admin/queue`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/admin-queue-route.test.ts`. Reuse the Access-JWT harness from `test/admin-route.test.ts` verbatim (the RSA keypair, `makeJwt`, the stubbed JWKS `fetch`, `__resetJwksCacheForTests` in `beforeEach`) — copy it rather than importing, matching how the existing route tests are written. Then:

```ts
describe("GET /admin/queue", () => {
  it("401s with ADMIN_REQUIRED when the Access header is absent", async () => {
    const res = await call("/admin/queue");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("401s when the Access JWT is invalid", async () => {
    const res = await call("/admin/queue", { "Cf-Access-Jwt-Assertion": "not.a.jwt" });
    expect(res.status).toBe(401);
  });

  // ⚠️ THE DECLARED EXEMPTION, RE-CHECKED. The queue query deliberately reads
  // HIDDEN rows and lives outside the tree hidden-at-read-guard scans. The
  // property that makes that safe is that it is reachable ONLY by an Access
  // principal — not that it happens to sit in src/moderation/. This asserts the
  // property directly, so a future refactor that exposes it another way fails.
  it("⚠️ a member session confers NO access to the queue", async () => {
    const res = await call("/admin/queue", { cookie: "tj_session=whatever-a-member-sends" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "ADMIN_REQUIRED" });
  });

  it("200s with a JSON array for a valid Access JWT", async () => {
    const res = await call("/admin/queue", { "Cf-Access-Jwt-Assertion": await makeJwt() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray((body as { items: unknown }).items)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `pnpm --filter @thinkersjournal/api exec vitest run --project pool test/admin-queue-route.test.ts`
Expected: FAIL — the route is unregistered, so every case gets the generic 404 envelope.

- [ ] **Step 3: Implement the handler**

Append to `apps/api/src/routes/admin.ts`:

```ts
/**
 * The moderation review queue. GET, so it does not touch the mutating pipeline.
 *
 * ⚠️ `listOpenQueue` reads HIDDEN rows by design. The gate below is the whole
 * of what keeps that safe — see the property stated in src/moderation/queue.ts.
 */
export async function handleAdminQueue(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const items = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listOpenQueue(c));

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

Add the imports at the top of that file:

```ts
import { withClient } from "../db/client";
import { listOpenQueue } from "../moderation/queue";
```

⚠️ Use `HYPERDRIVE_FRESH`, not `HYPERDRIVE_CACHED`. The cached binding never invalidates on write, so a moderator could act on a stale queue and re-decide an item someone already handled.

- [ ] **Step 4: Register the route**

In `apps/api/src/routes.ts`, extend the existing admin import and add the entry:

```ts
import { handleAdminQueue, handleAdminWhoami } from "./routes/admin";
```
```ts
  { method: "GET", pattern: "/admin/queue", handler: handleAdminQueue },
```

- [ ] **Step 5: Add the error-envelope probe**

`GET /admin/queue` is a GET, so `test/error-envelope.test.ts`'s LAYER 1 never probes it, but it has a real 401 path so it does not belong in `ERROR_FREE`. Add a `CASES` entry beside the `/admin/whoami` one added in module 2a:

```ts
  {
    name: "401 admin queue with no Access header",
    route: "GET /admin/queue",
    build: () => new Request("https://api.test/admin/queue"),
  },
```

⚠️ This is a **probe that drives the route**, not an allowlist entry. If a check fails, fix the route — do not silence it.

- [ ] **Step 6: Run the new test, then the FULL suite and typecheck**

```
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/admin-queue-route.test.ts \
  && pnpm --filter @thinkersjournal/api exec vitest run \
  && pnpm --filter @thinkersjournal/api run typecheck
```
Expected: all pass. ⚠️ Chained deliberately, and **typecheck is not optional** — module 2a passed every test while leaving the branch red on typecheck, because only the tests were run.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes.ts \
        apps/api/test/admin-queue-route.test.ts apps/api/test/error-envelope.test.ts
git commit -m "feat(m4): GET /admin/queue — the Access-gated review queue"
```

---

## Self-Review

**Spec coverage.** §4.1 (derived OPEN definition, no status column) → Task 2. §4.2 (ranking, and the missing index) → Tasks 1 and 2. §9 (Access-gated, API-first) → Task 3. §4.3 decisions, §4.4 author-facing state and §7 email are **2b-ii**, deliberately excluded.

**Placeholder scan.** None. Every step carries its code or its exact command.

**Type consistency.** `QueueItem` and `listOpenQueue(c, limit?)` are produced in Task 2 and consumed unchanged in Task 3. `QueueRow`'s snake_case fields match the SQL's output column names exactly — the mapping in `listOpenQueue` is the only place the two conventions meet.

⚠️ **The SQL in Task 2 was run against the live schema before this plan was written**, and its four behaviours (open / severity-outranks-count / closed-by-action / reopened-by-a-distinct-reporter) were each proven in a rolled-back transaction. This is deliberate: three defects in module 2a came from code written into a plan and handed over as "use this verbatim" without ever being executed. **A plan that ships code is two artifacts, and the second one gets the same gates as the first.**

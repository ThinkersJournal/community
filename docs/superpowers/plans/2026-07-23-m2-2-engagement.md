# M2.2 — Engagement (comments + reactions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Threaded Markdown comments SSR'd into the cached post page (purge-on-write) plus 4-tone multi-toggle reactions on posts and comments, per the approved spec `docs/superpowers/specs/2026-07-22-m2-2-engagement-comments-reactions-design.md`.

**Architecture:** api Worker grows a `comments` materialized-path table + `reactions` dual-nullable-FK table (migration 0004), five mutating routes and three reads; web SSRs the comment tree into `[handle]/[slug].astro` through the existing sanitize-first `renderMarkdown` and hydrates per-viewer affordances (forms, edit/delete, reaction toggles) via two new bundled islands talking to same-origin `/api/*` proxies. Comment writes purge `post:<id>` through the existing purge hop; reactions never purge.

**Tech Stack:** existing only — TS 6.0.3, zod, pg over Hyperdrive, wrangler ratelimits, Astro 7 + `@astrojs/cloudflare`, Playwright. No new dependencies.

**Branch:** `m2-2-engagement` off `main`.

## Global Constraints

- Baseline that must never regress (main @ f3a10f6): typecheck 0 · shared 27 · markdown 93 · api 471 · web 449/6skip · `check:workerd` clean · e2e 13/13. Docker Postgres must be up (`docker compose up -d db`).
- **Bindings rule:** edit `apps/api/wrangler.jsonc` → `pnpm --filter @thinkersjournal/api exec wrangler types` → COMMIT the regenerated `src/worker-configuration.d.ts`. Never hand-edit `Env`. Ratelimit `period` must be `10` or `60`; the key is the PLURAL `ratelimits`.
- **Vitest split (api):** workerd pool = `test/**/*.test.ts` EXCLUDING `*.db.test.ts` / `*.node.test.ts`; node project = those suffixes (direct pg). A test needing a Cloudflare binding must NOT use those suffixes.
- `withClient(hd, ctx, fn)` is 3-arg; `pg.Client`, never Pool. `HYPERDRIVE_FRESH` for everything in this milestone. `HYPERDRIVE_CACHED` stays EXACTLY ONE live use (`handlePublicRecent`) — the hyperdrive-binding-inventory guard fails on a second.
- **Route table rule:** every new route goes in `src/routes.ts`'s `ROUTES`; route-protection holds mutating routes to default-deny automatically; every new GET route needs an explicit `CASES` entry in `test/error-envelope.test.ts`. Errors are ALWAYS `errorResponse(code, status)` — never a bare Response.
- **Purge discipline:** ONE `purgeTags(env, tags)` call per write, AWAITED, AFTER the ownership/existence check (quota-burn vector), never before. A failed purge never fails the write (purgeTags never throws).
- **Cache discipline (web):** Cookie is NOT in the Workers Cache key. The post page render stays anonymous-by-construction — its api calls omit `request`. Never add `request: Astro.request` to a cacheable page's fetch. Per-viewer state hydrates client-side only. Every `src/pages` file calls exactly ONE cache helper (page-cache-inventory SWEEP A auto-enumerates new files).
- **Island rule:** bundled `<script>import { fn } from "<rel>/scripts/<mod>"; fn()</script>` — never inline logic (CSP `script-src 'self'`; `assetsInlineLimit: 0` already forces externalization). Islands build DOM via `createElement`/`textContent` ONLY — no `innerHTML`/`insertAdjacentHTML`.
- **Web redirect rule:** never `Astro.redirect` on a path that may carry cookies — manual 302 + `applyCookies` (tripwires exist). Not expected to arise here (islands reload; no page-level redirects change).
- **Web test style:** source/structure tests (`readFileSync` + `stripComments` + regex) + built-manifest greps (`it.skipIf(!existsSync("dist/server/entry.mjs"))`); no in-vitest render. Every negative assertion is preceded by a positive one (anti-vacuity).
- Comment bodies render ONLY through `renderMarkdown` (sanitize-first, `packages/markdown`). NEVER add rehype-raw/DOMPurify; never `set:html` anything but `renderMarkdown` output / `jsonLdScript` output.
- Reaction kinds are exactly `insightful | curious | agree | challenging`, everywhere (DB CHECK, zod, labels, islands).
- Depth: top-level 0, max 8 (DB CHECK + app 409); UI hides Reply at 8.
- Comment body cap 10_000 chars (zod + DB CHECK).

**Documented deviations from the spec letter** (justify-once, carry through):
1. The `username_chosen` gate is enforced on `POST /comments` and `POST /reactions` but NOT on comment PATCH/DELETE or reaction DELETE — the actor there is by-construction already onboarded (they authored the thing, or authored the post), and `DELETE /follows/:id` sets the precedent of not re-checking. One less DB round-trip per request; the create-side gates are the real fence.
2. The spec's web-proxy list gains a 7th file: `GET /api/comments` (anonymous passthrough of `/public/comments`) — the comments island needs it for edit-prefill (the SSR page carries rendered HTML, not markdown source).
3. `REACTION_LABELS` (display strings) lives in `packages/shared` next to `REACTION_KINDS` so web components/islands never hand-roll tone wording.

---

## File Structure

**Create**
- `apps/api/migrations/0004_engagement.sql` — comments + reactions tables
- `packages/shared/src/engagement.ts` — zod inputs + wire types + kind constants
- `apps/api/src/db/onboarding.ts` — shared `hasChosenUsername` (extracted from follows.ts; 3rd/4th consumers arrive here)
- `apps/api/src/routes/comments.ts` — create / update / delete handlers
- `apps/api/src/routes/comments-public.ts` — `GET /public/comments`
- `apps/api/src/routes/reactions.ts` — add / remove / public counts / mine
- `apps/api/test/engagement-schema.db.test.ts`, `test/comments.test.ts`, `test/comments-public.test.ts`, `test/reactions.test.ts`
- `apps/web/src/pages/api/{comment,comment-update,comment-delete,comments,react,unreact,reactions}.ts` — proxies
- `apps/web/src/components/ReactionChips.astro` — markup-only chip row
- `apps/web/src/scripts/comments.ts`, `apps/web/src/scripts/reactions.ts` — islands
- `apps/web/test/{comment-proxies,reaction-proxies,comments-island,reactions-island}.test.ts`
- `e2e/engagement.spec.ts`

**Modify**
- `packages/shared/src/errors.ts` (+4 codes), `src/social.ts` (`Me.userId`), `src/index.ts` (export)
- `apps/api/src/routes.ts` (+8 routes), `wrangler.jsonc` (+2 limiters), `src/worker-configuration.d.ts` (regen), `src/routes/follows.ts` (import extracted helper), `src/routes/username.ts` (`userId` in Me)
- `apps/api/test/error-envelope.test.ts` (+3 CASES), `test/purge-wiring.test.ts` (+comment purge blocks), `test/username.test.ts` (additive userId assertions)
- `apps/web/src/pages/api/me.ts` (`userId`), `src/pages/[handle]/[slug].astro` (comments SSR + chips + islands)
- `apps/web/test/post-page.test.ts` (three-sink pin + comments-section assertions), `test/nav-auth-proxies.test.ts` (additive, only if it enumerates keys)

---

### Task 1: Migration 0004 — comments + reactions schema

**Files:**
- Create: `apps/api/migrations/0004_engagement.sql`
- Test: `apps/api/test/engagement-schema.db.test.ts`

**Interfaces:**
- Consumes: `users`, `posts` tables (0001/0002); native `uuidv7()` (PG18).
- Produces: `comments` and `reactions` tables exactly as below — every later task's SQL depends on these column names and constraint names (`comments_depth_check`-style auto names are NOT relied on; the two named constraints are `comments_body_len` and `reactions_target_unique`, plus `reactions_one_target`).

- [ ] **Step 1: Write the failing schema test**

`apps/api/test/engagement-schema.db.test.ts` (node project via `.db.test.ts` — direct pg, mirrors `follows-schema.db.test.ts`):

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let author: string;
let postId: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`engagement-${crypto.randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

async function makePost(authorId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
     VALUES ($1, 't', $2, 'b', 'published', now()) RETURNING id`,
    [authorId, `s-${crypto.randomUUID()}`],
  );
  return rows[0]!.id;
}

async function makeComment(
  postIdArg: string,
  authorId: string,
  parent?: { id: string; path: string; depth: number },
): Promise<{ id: string; path: string; depth: number }> {
  const depth = parent === undefined ? 0 : parent.depth + 1;
  const { rows } = await client.query<{ id: string; path: string }>(
    `WITH ids AS (SELECT uuidv7() AS id)
     INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
     SELECT ids.id, $1, $2, $3,
            CASE WHEN $4::text IS NULL THEN ids.id::text ELSE $4 || '/' || ids.id::text END,
            $5, 'hello'
       FROM ids
     RETURNING id, path`,
    [postIdArg, authorId, parent?.id ?? null, parent?.path ?? null, depth],
  );
  return { id: rows[0]!.id, path: rows[0]!.path, depth };
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  author = await makeUser();
  postId = await makePost(author);
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = $1", [author]);
  await client.end();
});

describe("comments schema", () => {
  it("assigns a uuidv7 id and stores the id-chain path", async () => {
    const top = await makeComment(postId, author);
    expect(top.id[14]).toBe("7");
    expect(top.path).toBe(top.id);
    const child = await makeComment(postId, author, { ...top });
    expect(child.path).toBe(`${top.path}/${child.id}`);
    // uuidv7 text sorts by time → the child sorts after its parent, siblings in
    // creation order — the ORDER BY path property everything else rides on.
    expect(child.path > top.path).toBe(true);
  });

  it("rejects depth > 8 (CHECK 23514)", async () => {
    await expect(
      client.query(
        `INSERT INTO comments (post_id, author_id, path, depth, body_markdown)
         VALUES ($1, $2, 'x', 9, 'b')`,
        [postId, author],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a body over 10000 chars (CHECK 23514)", async () => {
    await expect(
      client.query(
        `INSERT INTO comments (post_id, author_id, path, depth, body_markdown)
         VALUES ($1, $2, 'x', 0, $3)`,
        [postId, author, "a".repeat(10_001)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("cascade-deletes the subtree when a parent ROW is deleted (row deletion, not tombstoning)", async () => {
    const top = await makeComment(postId, author);
    const child = await makeComment(postId, author, { ...top });
    await client.query("DELETE FROM comments WHERE id = $1", [top.id]);
    const { rows } = await client.query("SELECT 1 FROM comments WHERE id = $1", [child.id]);
    expect(rows).toHaveLength(0);
  });

  it("cascade-deletes comments when the post is deleted", async () => {
    const p2 = await makePost(author);
    const c = await makeComment(p2, author);
    await client.query("DELETE FROM posts WHERE id = $1", [p2]);
    const { rows } = await client.query("SELECT 1 FROM comments WHERE id = $1", [c.id]);
    expect(rows).toHaveLength(0);
  });
});

describe("reactions schema", () => {
  it("rejects both targets set and neither target set (CHECK 23514)", async () => {
    const c = await makeComment(postId, author);
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, post_id, comment_id, kind) VALUES ($1,$2,$3,'agree')",
        [author, postId, c.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, kind) VALUES ($1,'agree')",
        [author],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unknown kind (CHECK 23514)", async () => {
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'love')",
        [author, postId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces one row per (user, target, kind) — NULLS NOT DISTINCT (23505)", async () => {
    await client.query(
      "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'insightful')",
      [author, postId],
    );
    // Without NULLS NOT DISTINCT the NULL comment_id would make every duplicate
    // distinct and this INSERT would succeed — the whole idempotency anchor.
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'insightful')",
        [author, postId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // A DIFFERENT kind on the same target is fine (multi-toggle).
    await client.query(
      "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'agree')",
      [author, postId],
    );
  });

  it("cascade-deletes reactions when the comment is deleted", async () => {
    const c = await makeComment(postId, author);
    await client.query(
      "INSERT INTO reactions (user_id, comment_id, kind) VALUES ($1,$2,'curious')",
      [author, c.id],
    );
    await client.query("DELETE FROM comments WHERE id = $1", [c.id]);
    const { rows } = await client.query("SELECT 1 FROM reactions WHERE comment_id = $1", [c.id]);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it → FAIL.** `pnpm --filter @thinkersjournal/api test engagement-schema` — every case fails with `relation "comments" does not exist` (globalSetup migrates the test DB, but 0004 doesn't exist yet).

- [ ] **Step 3: Write the migration.** `apps/api/migrations/0004_engagement.sql`:

```sql
-- Up Migration

-- THREADED COMMENTS — materialized-path tree. `path` is the ancestor id chain
-- joined by '/', ending in the row's own id (top-level path = id::text).
-- uuid::text is fixed-width and uuidv7 is time-ordered, so lexicographic
-- `ORDER BY path` walks the whole tree in thread order (siblings oldest-first)
-- off one index scan. `path`/`depth` are computed by the api, never client-supplied.
CREATE TABLE comments (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES comments(id) ON DELETE CASCADE, -- NULL = top-level
  path           text NOT NULL,
  depth          int  NOT NULL CHECK (depth >= 0 AND depth <= 8),
  -- ⚠️ App-level delete is a TOMBSTONE (deleted_at + body emptied), never a row
  -- DELETE — the row cascades here exist for USER/POST deletion, and a future
  -- account-deletion design must tombstone, not delete (spec §4's cascade note:
  -- deleting a user's rows would take other people's reply subtrees with them).
  body_markdown  text NOT NULL CONSTRAINT comments_body_len CHECK (char_length(body_markdown) <= 10000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  deleted_at     timestamptz
);

-- The one read path: a post's tree in path order, keyset on path.
CREATE INDEX comments_post_path_idx ON comments (post_id, path);

-- REACTIONS — dual-nullable-FK; exactly one target. `kind` is text + CHECK
-- (adding a tone later = additive CHECK swap, no enum type migration).
CREATE TABLE reactions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id) ON DELETE CASCADE,
  comment_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('insightful','curious','agree','challenging')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reactions_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
  -- The idempotency anchor (ON CONFLICT target). NULLS NOT DISTINCT is
  -- load-bearing: without it the NULL side of the pair makes every row distinct.
  CONSTRAINT reactions_target_unique UNIQUE NULLS NOT DISTINCT (user_id, post_id, comment_id, kind)
);

-- Count paths: per-post and per-comment GROUP BY kind.
CREATE INDEX reactions_post_idx    ON reactions (post_id);
CREATE INDEX reactions_comment_idx ON reactions (comment_id);

-- Down Migration
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS comments;
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test engagement-schema` → all green. Also run `pnpm --filter @thinkersjournal/api test migrations` (the migration-runner suite must still pass with a 4th file).

- [ ] **Step 5: Commit.**
```bash
git add apps/api/migrations/0004_engagement.sql apps/api/test/engagement-schema.db.test.ts
git commit -m "feat(m2.2): migration 0004 — comments (materialized path) + reactions"
```

---

### Task 2: Shared engagement DTOs + error codes

**Files:**
- Create: `packages/shared/src/engagement.ts`
- Modify: `packages/shared/src/errors.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Produces (every later task imports these EXACT names from `@thinkersjournal/shared`): `COMMENT_MAX`, `CreateCommentInput`, `UpdateCommentInput`, `REACTION_KINDS`, `REACTION_LABELS`, `ReactionKind`, `ReactionInput`, `ReactionCounts`, `PublicReactions`, `MyReactions`, `CommentAuthor`, `CommentRow`, `CommentsPage`; error codes `COMMENT_NOT_FOUND`, `COMMENT_DELETED`, `COMMENT_DEPTH_EXCEEDED`, `INVALID_REACTION_KIND`.

- [ ] **Step 1: Write the failing test.** Extend `packages/shared` tests (`packages/shared/test/` — mirror the existing schema-test file layout there; check `ls packages/shared/test` and add `engagement.test.ts` beside its siblings):

```ts
import { describe, expect, it } from "vitest";

import {
  COMMENT_MAX,
  CreateCommentInput,
  REACTION_KINDS,
  REACTION_LABELS,
  ReactionInput,
  UpdateCommentInput,
} from "../src";

describe("CreateCommentInput", () => {
  const base = { postId: crypto.randomUUID(), markdownSource: "hi" };
  it("accepts top-level and nested shapes", () => {
    expect(CreateCommentInput.safeParse(base).success).toBe(true);
    expect(
      CreateCommentInput.safeParse({ ...base, parentId: crypto.randomUUID() }).success,
    ).toBe(true);
  });
  it("rejects an empty body, an over-cap body, and a non-uuid parent", () => {
    expect(CreateCommentInput.safeParse({ ...base, markdownSource: "" }).success).toBe(false);
    expect(
      CreateCommentInput.safeParse({ ...base, markdownSource: "a".repeat(COMMENT_MAX + 1) }).success,
    ).toBe(false);
    expect(CreateCommentInput.safeParse({ ...base, parentId: "nope" }).success).toBe(false);
  });
});

describe("UpdateCommentInput", () => {
  it("accepts a body and rejects empty/over-cap", () => {
    expect(UpdateCommentInput.safeParse({ markdownSource: "x" }).success).toBe(true);
    expect(UpdateCommentInput.safeParse({ markdownSource: "" }).success).toBe(false);
  });
});

describe("ReactionInput", () => {
  const kind = "agree";
  it("accepts exactly one target", () => {
    expect(ReactionInput.safeParse({ postId: crypto.randomUUID(), kind }).success).toBe(true);
    expect(ReactionInput.safeParse({ commentId: crypto.randomUUID(), kind }).success).toBe(true);
  });
  it("rejects zero targets and two targets", () => {
    expect(ReactionInput.safeParse({ kind }).success).toBe(false);
    expect(
      ReactionInput.safeParse({
        postId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        kind,
      }).success,
    ).toBe(false);
  });
  it("kind stays a free string here — the route maps unknown kinds to INVALID_REACTION_KIND", () => {
    expect(ReactionInput.safeParse({ postId: crypto.randomUUID(), kind: "love" }).success).toBe(true);
  });
});

describe("reaction constants", () => {
  it("four tones, each with a label", () => {
    expect(REACTION_KINDS).toEqual(["insightful", "curious", "agree", "challenging"]);
    for (const k of REACTION_KINDS) expect(typeof REACTION_LABELS[k]).toBe("string");
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/shared test engagement` — module not found.

- [ ] **Step 3: Implement.** `packages/shared/src/engagement.ts`:

```ts
/**
 * ENGAGEMENT WIRE TYPES (M2.2) — comments + reactions, shared by both Workers.
 * Same viewer-scoping discipline as posts.ts: `CommentRow`/`CommentsPage`/
 * `PublicReactions` are ANONYMOUS shapes (safe in cached HTML / public reads);
 * `MyReactions` is viewer-scoped and must never reach a shared cache.
 */
import { z } from "zod";

/** 10k chars — a comment is a comment, not a post (posts cap at ~100k). */
export const COMMENT_MAX = 10_000;

export const CreateCommentInput = z.object({
  postId: z.string().uuid(),
  /** Omitted = top-level. The api derives path/depth — the client never sends them. */
  parentId: z.string().uuid().optional(),
  markdownSource: z.string().min(1).max(COMMENT_MAX),
});

export const UpdateCommentInput = z.object({
  markdownSource: z.string().min(1).max(COMMENT_MAX),
});

/** The four thinker tones — order is display order. DB CHECK mirrors this list. */
export const REACTION_KINDS = ["insightful", "curious", "agree", "challenging"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** Display wording (founder-final, standing decision #12). */
export const REACTION_LABELS: Record<ReactionKind, string> = {
  insightful: "Insightful",
  curious: "Curious",
  agree: "Agree",
  challenging: "Challenging",
};

/**
 * `kind` is a plain string HERE so the route can answer the dedicated
 * INVALID_REACTION_KIND code (a z.enum reject would collapse it into
 * INVALID_INPUT). Exactly-one-target IS enforced here — that one is shape.
 */
export const ReactionInput = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    kind: z.string(),
  })
  .refine((t) => (t.postId === undefined) !== (t.commentId === undefined), {
    message: "exactly one of postId/commentId",
  });

export type ReactionCounts = Record<ReactionKind, number>;

/** `GET /public/reactions?postId=` — per-kind counts for the post AND all its comments. */
export interface PublicReactions {
  post: ReactionCounts;
  comments: Record<string, ReactionCounts>;
}

/** `GET /reactions/mine?postId=` — the signed-in viewer's own toggles. Never cached. */
export interface MyReactions {
  post: ReactionKind[];
  comments: Record<string, ReactionKind[]>;
}

export interface CommentAuthor {
  /** Public (same class as PublicPost.authorId) — safe in cached HTML data-attrs. */
  userId: string;
  username: string;
  displayName: string | null;
}

/** One comment in path order. Tombstones: `deleted: true`, empty body, null author. */
export interface CommentRow {
  id: string;
  parentId: string | null;
  depth: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  bodyMarkdown: string;
  author: CommentAuthor | null;
}

/** `GET /public/comments?postId=&cursor=` — keyset page over `path` ASC. */
export interface CommentsPage {
  comments: CommentRow[];
  /** The last row's `path` on this page, or null when there are no more. */
  nextCursor: string | null;
}
```

Edit `packages/shared/src/errors.ts` — add to the union (keep the section-banner style):

```ts
  // in --- resources ---, after USERNAME_ALREADY_SET:
  | "COMMENT_NOT_FOUND"      // 404 — no such visible comment / parent (M2.2)
  | "COMMENT_DELETED"        // 409 — the target comment is tombstoned (M2.2)
  | "COMMENT_DEPTH_EXCEEDED" // 409 — reply would exceed the depth-8 cap (M2.2)
  // in --- request shape ---, after CANNOT_FOLLOW_SELF:
  | "INVALID_REACTION_KIND"  // 400 — kind not in the four-tone set (M2.2)
```

Edit `packages/shared/src/index.ts` — add `export * from "./engagement";` beside the existing star-exports.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/shared test` (all, not just engagement — the union change must not break siblings) and `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/engagement.ts packages/shared/src/errors.ts packages/shared/src/index.ts packages/shared/test/engagement.test.ts
git commit -m "feat(m2.2): shared engagement DTOs, reaction constants, 4 error codes"
```

---

### Task 3: `POST /comments` (+ COMMENT_LIMITER, + shared onboarding helper)

**Files:**
- Create: `apps/api/src/db/onboarding.ts`, `apps/api/src/routes/comments.ts`
- Modify: `apps/api/src/routes/follows.ts` (use the extracted helper), `apps/api/src/routes.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/worker-configuration.d.ts` (regen)
- Test: `apps/api/test/comments.test.ts` (create-side), additions to `apps/api/test/purge-wiring.test.ts`

**Interfaces:**
- Consumes: `CreateCommentInput` (Task 2), `runMutatingPipeline`, `enforceRateLimit`, `withClient`, `errorResponse`, `purgeTags`, migration 0004.
- Produces: `hasChosenUsername(env: Env, ctx: ExecutionContext, userId: string): Promise<boolean>` in `src/db/onboarding.ts` (Tasks 4/6 import it); `handleCreateComment` registered as `POST /comments`; 201 body `{ id: string }`; binding `COMMENT_LIMITER` (10/60s, namespace_id "1006").

- [ ] **Step 1: Bindings first (build-order, not TDD — types must exist to compile the handler).** In `apps/api/wrangler.jsonc`, append to `ratelimits` after FOLLOW_LIMITER:

```jsonc
    // Bounds POST /comments (see src/routes/comments.ts). Session-user-keyed,
    // same reasoning as FOLLOW_LIMITER. Comments are heavier rows than follows
    // (10k body + a purge per write) — tighter limit.
    {
      "name": "COMMENT_LIMITER",
      "namespace_id": "1006",
      "simple": { "limit": 10, "period": 60 }
    },
    // Bounds POST/DELETE /reactions (Task 6 — added now so wrangler types runs once).
    // Toggles are cheap and bursty (a reader reacting down a thread) — looser.
    {
      "name": "REACTION_LIMITER",
      "namespace_id": "1007",
      "simple": { "limit": 60, "period": 60 }
    }
```

Run `pnpm --filter @thinkersjournal/api exec wrangler types` and stage the regenerated `src/worker-configuration.d.ts`. Also mirror whatever `vitest.config.ts` does for FOLLOW_LIMITER (check `apps/api/vitest.config.ts` — if limiter bindings are stubbed/injected there, add the two new ones identically).

- [ ] **Step 2: Extract the onboarding helper.** Create `apps/api/src/db/onboarding.ts`:

```ts
import { withClient } from "./client";

/**
 * true iff this user has chosen a durable handle (the M2.1 onboarding gate).
 * Extracted from routes/follows.ts when comments/reactions became the 3rd/4th
 * consumers. HYPERDRIVE_FRESH always: this is a permission read.
 */
export async function hasChosenUsername(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.username_chosen === true;
  });
}
```

In `apps/api/src/routes/follows.ts`: delete the local `hasChosenUsername`, add `import { hasChosenUsername } from "../db/onboarding";`. Run `pnpm --filter @thinkersjournal/api test follows` → still green (pure move).

- [ ] **Step 3: Write the failing route tests.** `apps/api/test/comments.test.ts` (workerd pool — drives the real Worker):

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Verified + handle chosen (mirrors follows.test.ts). */
async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
}

function mutatingHeaders(actor: Actor): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    Cookie: actor.cookie,
    "X-CSRF-Token": actor.csrfToken,
    "content-type": "application/json",
  };
}

/** Insert a post row directly (status parameterized) and return its id. */
async function insertPost(authorId: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, 'b', $3, CASE WHEN $3 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, `c-${crypto.randomUUID()}`, status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

function createComment(
  actor: Actor,
  body: { postId: string; parentId?: string; markdownSource: string },
): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/comments", {
      method: "POST",
      headers: mutatingHeaders(actor),
      body: JSON.stringify(body),
    }),
  );
}

async function commentRow(id: string): Promise<{ path: string; depth: number } | null> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ path: string; depth: number }>(
      "SELECT path, depth FROM comments WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  });
  await waitOnExecutionContext(ctx);
  return row;
}

let author: Actor;
let reader: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  reader = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});
afterAll(deleteCreatedUsers);

describe("POST /comments", () => {
  it("creates a top-level comment (depth 0, path = own id) and 201s", async () => {
    const response = await createComment(reader, { postId, markdownSource: "first!" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const row = await commentRow(id);
    expect(row).toEqual({ path: id, depth: 0 });
  });

  it("creates a nested reply (depth+1, path = parent/child)", async () => {
    const top = await createComment(reader, { postId, markdownSource: "top" });
    const { id: parentId } = (await top.json()) as { id: string };
    const reply = await createComment(author, { postId, parentId, markdownSource: "re" });
    expect(reply.status).toBe(201);
    const { id } = (await reply.json()) as { id: string };
    expect(await commentRow(id)).toEqual({ path: `${parentId}/${id}`, depth: 1 });
  });

  it("404s a DRAFT post exactly like a nonexistent one (parity)", async () => {
    const draftId = await insertPost(author.userId, "draft");
    const onDraft = await createComment(reader, { postId: draftId, markdownSource: "x" });
    const onMissing = await createComment(reader, {
      postId: crypto.randomUUID(),
      markdownSource: "x",
    });
    expect(onDraft.status).toBe(404);
    expect(onMissing.status).toBe(404);
    expect(((await onDraft.json()) as { code: string }).code).toBe(
      ((await onMissing.json()) as { code: string }).code,
    );
  });

  it("404s COMMENT_NOT_FOUND for a parent from a DIFFERENT post", async () => {
    const otherPost = await insertPost(author.userId, "published");
    const other = await createComment(reader, { postId: otherPost, markdownSource: "elsewhere" });
    const { id: foreignParent } = (await other.json()) as { id: string };
    const response = await createComment(reader, {
      postId,
      parentId: foreignParent,
      markdownSource: "x",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
  });

  it("409s COMMENT_DELETED replying to a tombstone", async () => {
    const top = await createComment(reader, { postId, markdownSource: "doomed" });
    const { id: parentId } = (await top.json()) as { id: string };
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1", [parentId]),
    );
    await waitOnExecutionContext(ctx);
    const response = await createComment(reader, { postId, parentId, markdownSource: "x" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_DELETED");
  });

  it("409s COMMENT_DEPTH_EXCEEDED replying at the cap", async () => {
    // Build a depth-8 chain, then attempt depth 9.
    let parentId: string | undefined;
    for (let d = 0; d <= 8; d++) {
      const r = await createComment(reader, { postId, parentId, markdownSource: `d${d}` });
      expect(r.status).toBe(201);
      parentId = ((await r.json()) as { id: string }).id;
    }
    const over = await createComment(reader, { postId, parentId, markdownSource: "d9" });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { code: string }).code).toBe("COMMENT_DEPTH_EXCEEDED");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified commenter", async () => {
    const unverified = await createUnverifiedActor();
    const response = await createComment(unverified, { postId, markdownSource: "x" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("409s USERNAME_REQUIRED for a verified commenter with no handle", async () => {
    const noHandle = await createVerifiedActor();
    const response = await createComment(noHandle, { postId, markdownSource: "x" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
  });

  it("400s INVALID_INPUT for an empty body and an over-cap body", async () => {
    const empty = await createComment(reader, { postId, markdownSource: "" });
    expect(empty.status).toBe(400);
    const over = await createComment(reader, { postId, markdownSource: "a".repeat(10_001) });
    expect(over.status).toBe(400);
  });
});
```

Note the depth-cap case creates 9 comments — one COMMENT_LIMITER window holds 10; if the suite trips 429 flakily, bump nothing — give the depth case its OWN `onboardedActor()` so its budget is fresh (do that from the start).

- [ ] **Step 4: Run → FAIL.** `pnpm --filter @thinkersjournal/api test comments` — 404s everywhere (route unregistered).

- [ ] **Step 5: Implement the handler.** `apps/api/src/routes/comments.ts`:

```ts
/**
 * THREADED COMMENTS — the write side. Path/depth are DERIVED HERE, never
 * client-supplied: parent is looked up (same post, not tombstoned, depth < 8)
 * and the child id is minted IN the insert (uuidv7()), so `path` is always
 * `parent.path || '/' || id`. The parent check and the insert share one
 * connection but no explicit transaction: the only race (parent tombstoned
 * between the two) strands a reply under a fresh tombstone — harmless, renders
 * fine, and a transaction would not stop the SAME interleaving one tick earlier.
 *
 * ⚠️ PURGE-ON-WRITE (spec decision 4): comments are CONTENT, SSR'd into the
 * cached post page — every successful write here purges `post:<id>`, exactly
 * like a post edit. ONE call, ONE tag, AFTER the write, AWAITED.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { purgeTags } from "../cache/purge";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { hasChosenUsername } from "../db/onboarding";
import { errorResponse } from "../http/errors";

import { CreateCommentInput, UpdateCommentInput } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 8;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleCreateComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.COMMENT_LIMITER, `comment:${userId}`);
  if (limited !== null) return limited;

  if (!(await hasChosenUsername(env, ctx, userId))) {
    return errorResponse("USERNAME_REQUIRED", 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = CreateCommentInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((i) => i.path.join(".")),
    });
  }
  const { postId, parentId, markdownSource } = parsed.data;

  let outcome: { id: string } | { error: Response };
  try {
    outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // Draft parity: an unpublished post 404s exactly like a nonexistent one.
      const post = await c.query<{ status: string }>(
        "SELECT status FROM posts WHERE id = $1",
        [postId],
      );
      if (post.rows[0]?.status !== "published") {
        return { error: errorResponse("NOT_FOUND", 404) };
      }

      let parentPath: string | null = null;
      let depth = 0;
      if (parentId !== undefined) {
        const parent = await c.query<{ path: string; depth: number; deleted: boolean }>(
          `SELECT path, depth, (deleted_at IS NOT NULL) AS deleted
             FROM comments WHERE id = $1 AND post_id = $2`,
          [parentId, postId],
        );
        const row = parent.rows[0];
        // Cross-post parents 404 identically to nonexistent ones (no probe signal).
        if (row === undefined) return { error: errorResponse("COMMENT_NOT_FOUND", 404) };
        if (row.deleted) return { error: errorResponse("COMMENT_DELETED", 409) };
        if (row.depth >= MAX_DEPTH) return { error: errorResponse("COMMENT_DEPTH_EXCEEDED", 409) };
        parentPath = row.path;
        depth = row.depth + 1;
      }

      const { rows } = await c.query<{ id: string }>(
        `WITH ids AS (SELECT uuidv7() AS id)
         INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
         SELECT ids.id, $1, $2, $3,
                CASE WHEN $4::text IS NULL THEN ids.id::text
                     ELSE $4 || '/' || ids.id::text END,
                $5, $6
           FROM ids
         RETURNING id`,
        [postId, userId, parentId ?? null, parentPath, depth, markdownSource],
      );
      return { id: rows[0]!.id };
    });
  } catch (err) {
    // Post deleted between the status check and the insert → FK 23503.
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if ("error" in outcome) return outcome.error;

  // The write is committed; the cached post page is now stale. One call, one tag.
  await purgeTags(env, [`post:${postId}`]);
  return json({ id: outcome.id }, 201);
}
```

(`UpdateCommentInput`, `UUID_RE`, `json` are used by Task 4's handlers in this same file — importing `UpdateCommentInput` now is fine; if the linter flags it unused, add it in Task 4 instead.)

Register in `src/routes.ts` (after the `/follows/status` entry, before `/feed`):

```ts
  // Engagement writes (M2.2). Comment writes purge `post:<id>` — see
  // src/routes/comments.ts's header. PATCH/DELETE own their gates per-handler.
  { method: "POST", pattern: "/comments", handler: handleCreateComment },
```
with `import { handleCreateComment } from "./routes/comments";` (extend this import in Task 4).

- [ ] **Step 6: Run → PASS.** `pnpm --filter @thinkersjournal/api test comments` green; then the two structural guards: `pnpm --filter @thinkersjournal/api test route-protection error-envelope` (POST /comments is mutating → auto-held to default-deny; both must pass with no CASES edit — POST routes are probed generically).

- [ ] **Step 7: Purge wiring.** Add to `apps/api/test/purge-wiring.test.ts` (reuse its `fetchCapturingPurges` + `onboardedActor`):

```ts
function createCommentRequest(actor: Actor, postId: string): Request {
  return new Request("https://api.test/comments", {
    method: "POST",
    headers: {
      Origin: "http://localhost:8787",
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ postId, markdownSource: "purge probe" }),
  });
}

describe("POST /comments purges the post page", () => {
  it("a comment purges post:<id> in ONE call", async () => {
    const postId = await createPublished(actor);
    const { response, purges } = await fetchCapturingPurges(createCommentRequest(actor, postId));
    expect(response.status).toBe(201);
    expect(purges).toHaveLength(1);
    expect(purges[0]).toEqual([`post:${postId}`]);
  });

  it("a rejected comment (draft post) purges NOTHING", async () => {
    const { response: draft } = await fetchCapturingPurges(createPostRequest(actor, "draft"));
    const draftId = ((await draft.json()) as { id: string }).id;
    const { response, purges } = await fetchCapturingPurges(createCommentRequest(actor, draftId));
    expect(response.status).toBe(404);
    expect(purges).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @thinkersjournal/api test purge-wiring` → PASS.

- [ ] **Step 8: Commit.**
```bash
git add -A apps/api packages/shared
git commit -m "feat(m2.2): POST /comments — path/depth derivation, gates, purge; shared onboarding helper; COMMENT/REACTION limiters"
```

---

### Task 4: `PATCH /comments/:id` + `DELETE /comments/:id` (tombstone + author moderation)

**Files:**
- Modify: `apps/api/src/routes/comments.ts`, `apps/api/src/routes.ts`
- Test: extend `apps/api/test/comments.test.ts`, `apps/api/test/purge-wiring.test.ts`

**Interfaces:**
- Consumes: Task 3's file/module, `UpdateCommentInput` (Task 2).
- Produces: `handleUpdateComment`, `handleDeleteComment` registered as `PATCH /comments/:id` / `DELETE /comments/:id`. PATCH 200 body `{}`; DELETE 200 body `{}`; both purge `post:<id>` on success only. Delete ownership = comment author OR post author (spec decision 7). No `username_chosen` re-check (documented deviation 1).

- [ ] **Step 1: Write the failing tests** (append to `test/comments.test.ts`; helpers exist from Task 3):

```ts
function updateComment(actor: Actor, id: string, markdownSource: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/comments/${id}`, {
      method: "PATCH",
      headers: mutatingHeaders(actor),
      body: JSON.stringify({ markdownSource }),
    }),
  );
}

function deleteComment(actor: Actor, id: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/comments/${id}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function tombstoned(id: string): Promise<{ deleted: boolean; body: string } | null> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ deleted: boolean; body: string }>(
      `SELECT (deleted_at IS NOT NULL) AS deleted, body_markdown AS body
         FROM comments WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
  await waitOnExecutionContext(ctx);
  return row;
}

describe("PATCH /comments/:id", () => {
  it("edits own comment, sets edited_at, 200s", async () => {
    const created = await createComment(reader, { postId, markdownSource: "v1" });
    const { id } = (await created.json()) as { id: string };
    const response = await updateComment(reader, id, "v2");
    expect(response.status).toBe(200);
    const ctx = createExecutionContext();
    const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ body: string; edited: boolean }>(
        `SELECT body_markdown AS body, (edited_at IS NOT NULL) AS edited
           FROM comments WHERE id = $1`,
        [id],
      );
      return rows[0]!;
    });
    await waitOnExecutionContext(ctx);
    expect(row).toEqual({ body: "v2", edited: true });
  });

  it("404s COMMENT_NOT_FOUND editing someone ELSE'S comment (no ownership leak)", async () => {
    const created = await createComment(reader, { postId, markdownSource: "mine" });
    const { id } = (await created.json()) as { id: string };
    const response = await updateComment(author, id, "hijack"); // author of the POST, not the comment
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
  });

  it("404s editing a tombstoned comment", async () => {
    const created = await createComment(reader, { postId, markdownSource: "bye" });
    const { id } = (await created.json()) as { id: string };
    await deleteComment(reader, id);
    const response = await updateComment(reader, id, "necro");
    expect(response.status).toBe(404);
  });

  it("400s INVALID_INPUT for a non-uuid id", async () => {
    const response = await updateComment(reader, "not-a-uuid", "x");
    expect(response.status).toBe(400);
  });
});

describe("DELETE /comments/:id", () => {
  it("comment author tombstones own comment: body emptied, row + children remain", async () => {
    const top = await createComment(reader, { postId, markdownSource: "parent text" });
    const { id: parentId } = (await top.json()) as { id: string };
    const child = await createComment(author, { postId, parentId, markdownSource: "child" });
    const { id: childId } = (await child.json()) as { id: string };

    const response = await deleteComment(reader, parentId);
    expect(response.status).toBe(200);
    expect(await tombstoned(parentId)).toEqual({ deleted: true, body: "" });
    // The child SURVIVES — tombstone, not row delete.
    expect(await tombstoned(childId)).toEqual({ deleted: false, body: "child" });
  });

  it("POST AUTHOR may tombstone another user's comment on their post (decision 7)", async () => {
    const created = await createComment(reader, { postId, markdownSource: "on author's post" });
    const { id } = (await created.json()) as { id: string };
    const response = await deleteComment(author, id); // author owns the POST
    expect(response.status).toBe(200);
    expect(await tombstoned(id)).toEqual({ deleted: true, body: "" });
  });

  it("a THIRD PARTY (neither comment nor post author) gets 404", async () => {
    const third = await onboardedActor();
    const created = await createComment(reader, { postId, markdownSource: "x" });
    const { id } = (await created.json()) as { id: string };
    const response = await deleteComment(third, id);
    expect(response.status).toBe(404);
    expect(await tombstoned(id)).toEqual({ deleted: false, body: "x" });
  });

  it("is idempotent: deleting an already-tombstoned comment 200s", async () => {
    const created = await createComment(reader, { postId, markdownSource: "x" });
    const { id } = (await created.json()) as { id: string };
    await deleteComment(reader, id);
    const again = await deleteComment(reader, id);
    expect(again.status).toBe(200);
  });

  it("400s INVALID_INPUT for a non-uuid id", async () => {
    const response = await deleteComment(reader, "nope");
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`404` route-not-found on every new case). `pnpm --filter @thinkersjournal/api test comments`

- [ ] **Step 3: Implement** (append to `src/routes/comments.ts`):

```ts
export async function handleUpdateComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse("INVALID_INPUT", 400, { fields: ["id"] });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = UpdateCommentInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["markdownSource"] });
  }

  // Ownership + liveness in the WHERE (atomic; no existence leak): a not-mine
  // and a not-there answer identically. No username re-check — the author
  // necessarily passed it to create this row (documented deviation 1).
  const postId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ postId: string }>(
      `UPDATE comments SET body_markdown = $3, edited_at = now()
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL
       RETURNING post_id AS "postId"`,
      [id, userId, parsed.data.markdownSource],
    );
    return rows[0]?.postId ?? null;
  });
  if (postId === null) return errorResponse("COMMENT_NOT_FOUND", 404);

  await purgeTags(env, [`post:${postId}`]);
  return json({});
}

export async function handleDeleteComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse("INVALID_INPUT", 400, { fields: ["id"] });

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    // TOMBSTONE, never DELETE: children keep their parent row; the body is
    // genuinely emptied (privacy). Ownership predicate = comment author OR
    // post author (spec decision 7), atomic in the WHERE.
    const { rows } = await c.query<{ postId: string }>(
      `UPDATE comments c
          SET deleted_at = now(), body_markdown = ''
         FROM posts p
        WHERE c.id = $1 AND p.id = c.post_id
          AND c.deleted_at IS NULL
          AND (c.author_id = $2 OR p.author_id = $2)
       RETURNING c.post_id AS "postId"`,
      [id, userId],
    );
    if (rows[0] !== undefined) return { purged: rows[0].postId };

    // Nothing updated: idempotent-success iff it IS tombstoned and this caller
    // COULD have deleted it; anything else (missing, third party) is the same 404.
    const probe = await c.query<{ mine: boolean }>(
      `SELECT (c.author_id = $2 OR p.author_id = $2) AS mine
         FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = $1 AND c.deleted_at IS NOT NULL`,
      [id, userId],
    );
    return probe.rows[0]?.mine === true ? { alreadyGone: true as const } : { notFound: true as const };
  });

  if ("notFound" in outcome) return errorResponse("COMMENT_NOT_FOUND", 404);
  if ("purged" in outcome) await purgeTags(env, [`post:${outcome.purged}`]);
  return json({}); // both fresh-tombstone and already-tombstoned answer 200
}
```

Register in `src/routes.ts` (beside `POST /comments`; note the routing comment style):

```ts
  { method: "PATCH", pattern: "/comments/:id", handler: handleUpdateComment },
  { method: "DELETE", pattern: "/comments/:id", handler: handleDeleteComment },
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test comments route-protection error-envelope`

- [ ] **Step 5: Purge wiring** (append to `purge-wiring.test.ts` — the delete-miss case is the quota-burn pin, mirroring the 404-edit case):

```ts
describe("comment edit/delete purge the post page", () => {
  async function seedComment(postId: string): Promise<string> {
    const { response } = await fetchCapturingPurges(createCommentRequest(actor, postId));
    return ((await response.json()) as { id: string }).id;
  }

  it("PATCH purges post:<id> in ONE call", async () => {
    const postId = await createPublished(actor);
    const commentId = await seedComment(postId);
    const { response, purges } = await fetchCapturingPurges(
      new Request(`https://api.test/comments/${commentId}`, {
        method: "PATCH",
        headers: {
          Origin: "http://localhost:8787",
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ markdownSource: "edited" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(purges).toHaveLength(1);
    expect(purges[0]).toEqual([`post:${postId}`]);
  });

  it("DELETE purges once; a 404 delete (third party) purges NOTHING", async () => {
    const postId = await createPublished(actor);
    const commentId = await seedComment(postId);
    const attacker = await onboardedActor();
    const miss = await fetchCapturingPurges(
      new Request(`https://api.test/comments/${commentId}`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:8787",
          Cookie: attacker.cookie,
          "X-CSRF-Token": attacker.csrfToken,
        },
      }),
    );
    expect(miss.response.status).toBe(404);
    expect(miss.purges).toHaveLength(0);

    const hit = await fetchCapturingPurges(
      new Request(`https://api.test/comments/${commentId}`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:8787",
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
        },
      }),
    );
    expect(hit.response.status).toBe(200);
    expect(hit.purges).toHaveLength(1);
    expect(hit.purges[0]).toEqual([`post:${postId}`]);

    // Idempotent repeat: nothing changed, nothing purged.
    const again = await fetchCapturingPurges(
      new Request(`https://api.test/comments/${commentId}`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:8787",
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
        },
      }),
    );
    expect(again.response.status).toBe(200);
    expect(again.purges).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @thinkersjournal/api test purge-wiring` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/routes/comments.ts apps/api/src/routes.ts apps/api/test/comments.test.ts apps/api/test/purge-wiring.test.ts
git commit -m "feat(m2.2): comment edit + tombstone delete (author moderation), purge-wired"
```

---

### Task 5: `GET /public/comments` — path-order keyset read

**Files:**
- Create: `apps/api/src/routes/comments-public.ts`, `apps/api/test/comments-public.test.ts`
- Modify: `apps/api/src/routes.ts`, `apps/api/test/error-envelope.test.ts`

**Interfaces:**
- Consumes: `CommentsPage`/`CommentRow` (Task 2), migration 0004, `withClient`, `errorResponse`.
- Produces: `handlePublicComments` at `GET /public/comments?postId=<uuid>&cursor=<path>` — anonymous, HYPERDRIVE_FRESH, no cache-tag (web SSR consumes it per-render; the EDGE cache of the post page is the cache). Page size 50, ascending `path` keyset (`path > cursor`), `nextCursor` = last row's path. Tombstones: `deleted: true`, `bodyMarkdown: ""`, `author: null`.

- [ ] **Step 1: Write the failing tests.** `apps/api/test/comments-public.test.ts` (workerd; reuse Task 3's helper shapes — import nothing across test files, re-declare the small local helpers as the house style does):

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { CommentsPage } from "@thinkersjournal/shared";
import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
}

async function insertPost(authorId: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, 'b', $3, CASE WHEN $3 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, `pc-${crypto.randomUUID()}`, status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

/** Direct insert (read suite — the write route is Task 3's concern). */
async function insertComment(
  postId: string,
  authorId: string,
  parent?: { id: string; path: string; depth: number },
  deleted = false,
): Promise<{ id: string; path: string; depth: number }> {
  const depth = parent === undefined ? 0 : parent.depth + 1;
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; path: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown, deleted_at)
       SELECT ids.id, $1, $2, $3,
              CASE WHEN $4::text IS NULL THEN ids.id::text ELSE $4 || '/' || ids.id::text END,
              $5, $6, CASE WHEN $7 THEN now() ELSE NULL END
         FROM ids
       RETURNING id, path`,
      [postId, authorId, parent?.id ?? null, parent?.path ?? null, depth, deleted ? "" : "body", deleted],
    );
    return rows[0]!;
  });
  await waitOnExecutionContext(ctx);
  return { ...row, depth };
}

function getComments(postId: string, cursor?: string): Promise<Response> {
  const q = new URLSearchParams({ postId });
  if (cursor !== undefined) q.set("cursor", cursor);
  return fetchWorker(new Request(`https://api.test/public/comments?${q.toString()}`));
}

let author: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});
afterAll(deleteCreatedUsers);

describe("GET /public/comments", () => {
  it("returns the tree in PATH order (thread order, siblings oldest-first)", async () => {
    const p = await insertPost(author.userId, "published");
    const a = await insertComment(p, author.userId);        // first top-level
    const a1 = await insertComment(p, author.userId, a);    // its reply
    const b = await insertComment(p, author.userId);        // second top-level
    const response = await getComments(p);
    expect(response.status).toBe(200);
    const page = (await response.json()) as CommentsPage;
    expect(page.comments.map((c) => c.id)).toEqual([a.id, a1.id, b.id]);
    expect(page.comments[1]).toMatchObject({ parentId: a.id, depth: 1, deleted: false });
    expect(page.comments[0]!.author).toMatchObject({ userId: author.userId });
    expect(page.nextCursor).toBeNull();
  });

  it("keyset-paginates on path: pages are disjoint, complete, and ordered", async () => {
    const p = await insertPost(author.userId, "published");
    const all: string[] = [];
    for (let i = 0; i < 51; i++) all.push((await insertComment(p, author.userId)).id);
    const page1 = (await (await getComments(p)).json()) as CommentsPage;
    expect(page1.comments).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await (await getComments(p, page1.nextCursor!)).json()) as CommentsPage;
    expect(page2.comments).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect([...page1.comments, ...page2.comments].map((c) => c.id)).toEqual(all);
  });

  it("tombstones ship deleted:true, EMPTY body, NULL author", async () => {
    const p = await insertPost(author.userId, "published");
    await insertComment(p, author.userId, undefined, true);
    const page = (await (await getComments(p)).json()) as CommentsPage;
    expect(page.comments[0]).toMatchObject({ deleted: true, bodyMarkdown: "", author: null });
  });

  it("404s a draft post and a nonexistent post identically (parity)", async () => {
    const draft = await insertPost(author.userId, "draft");
    await insertComment(draft, author.userId);
    const onDraft = await getComments(draft);
    const onMissing = await getComments(crypto.randomUUID());
    expect(onDraft.status).toBe(404);
    expect(onMissing.status).toBe(404);
  });

  it("404s a missing/malformed postId", async () => {
    expect((await fetchWorker(new Request("https://api.test/public/comments"))).status).toBe(404);
    expect((await getComments("not-a-uuid")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test comments-public`

- [ ] **Step 3: Implement.** `apps/api/src/routes/comments-public.ts`:

```ts
/**
 * ANONYMOUS comment read — the post page's SSR source. Like social-public.ts:
 * viewer-independent, HYPERDRIVE_FRESH, NO cache-tag of its own — the EDGE
 * cache of the rendered post page (purged on every comment write) is the cache.
 *
 * Ascending `path` keyset: `ORDER BY path` IS thread order (the materialized-
 * path payoff), so the cursor is simply the last path seen. A page may cut a
 * thread mid-branch; the next page continues it exactly. Tombstones stay IN the
 * stream (their children need anchoring) but ship with no body and no author.
 */
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import type { CommentRow, CommentsPage } from "@thinkersjournal/shared";

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DbRow {
  id: string;
  parentId: string | null;
  depth: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  bodyMarkdown: string;
  path: string;
  authorUserId: string;
  username: string;
  displayName: string | null;
}

export async function handlePublicComments(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const postId = url.searchParams.get("postId") ?? "";
  // Missing and malformed collapse into the same 404 a nonexistent post gets.
  if (!UUID_RE.test(postId)) return errorResponse("NOT_FOUND", 404);
  // '' sorts before every path — the natural first-page sentinel for an ASC keyset.
  const cursor = url.searchParams.get("cursor") ?? "";

  const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const post = await c.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [postId],
    );
    // Draft parity — indistinguishable from nonexistent.
    if (post.rows[0]?.status !== "published") return null;

    const { rows } = await c.query<DbRow>(
      `SELECT c.id, c.parent_id AS "parentId", c.depth,
              c.created_at AS "createdAt", c.edited_at AS "editedAt",
              (c.deleted_at IS NOT NULL) AS deleted,
              c.body_markdown AS "bodyMarkdown", c.path,
              pr.user_id AS "authorUserId", pr.username, pr.display_name AS "displayName"
         FROM comments c
         JOIN profiles pr ON pr.user_id = c.author_id
        WHERE c.post_id = $1 AND c.path > $2
        ORDER BY c.path
        LIMIT ${PAGE_SIZE + 1}`,
      [postId, cursor],
    );
    const hasMore = rows.length > PAGE_SIZE;
    const slice = rows.slice(0, PAGE_SIZE);
    const comments: CommentRow[] = slice.map((r) =>
      r.deleted
        ? {
            id: r.id, parentId: r.parentId, depth: r.depth,
            createdAt: r.createdAt, editedAt: null,
            deleted: true, bodyMarkdown: "", author: null,
          }
        : {
            id: r.id, parentId: r.parentId, depth: r.depth,
            createdAt: r.createdAt, editedAt: r.editedAt,
            deleted: false, bodyMarkdown: r.bodyMarkdown,
            author: { userId: r.authorUserId, username: r.username, displayName: r.displayName },
          },
    );
    return {
      comments,
      nextCursor: hasMore ? slice[slice.length - 1]!.path : null,
    } satisfies CommentsPage;
  });

  if (page === null) return errorResponse("NOT_FOUND", 404);
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

Register in `src/routes.ts` under the anonymous-social block:

```ts
  { method: "GET", pattern: "/public/comments", handler: handlePublicComments },
```

Add the `CASES` entry in `test/error-envelope.test.ts` (beside the other GET entries):

```ts
  {
    name: "404 public comments without a postId",
    route: "GET /public/comments",
    build: () => new Request("https://api.test/public/comments"),
  },
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test comments-public error-envelope route-protection hyperdrive-binding-inventory`

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/comments-public.ts apps/api/src/routes.ts apps/api/test/comments-public.test.ts apps/api/test/error-envelope.test.ts
git commit -m "feat(m2.2): GET /public/comments — path-order keyset, tombstone shape, draft parity"
```

---

### Task 6: `POST /reactions` + `DELETE /reactions` — idempotent toggles

**Files:**
- Create: `apps/api/src/routes/reactions.ts`, `apps/api/test/reactions.test.ts`
- Modify: `apps/api/src/routes.ts`, `apps/api/test/purge-wiring.test.ts`

**Interfaces:**
- Consumes: `ReactionInput`, `REACTION_KINDS`, `ReactionKind` (Task 2), `REACTION_LIMITER` (bound in Task 3), `hasChosenUsername` (Task 3), constraint `reactions_target_unique` (Task 1).
- Produces: `handleAddReaction` (`POST /reactions`, 201 always on success), `handleRemoveReaction` (`DELETE /reactions?postId=|commentId=&kind=`, 200 always, no target-state validation). NEITHER purges (spec decision 5 — Task 6's purge-wiring case pins that).

- [ ] **Step 1: Write the failing tests.** `apps/api/test/reactions.test.ts` — reuse the local-helper idiom (fetchWorker / onboardedActor / mutatingHeaders / insertPost / insertComment exactly as in Task 5's file):

```ts
// …same imports + local helpers as comments-public.test.ts (fetchWorker,
// onboardedActor, mutatingHeaders, insertPost, insertComment), plus:

function react(
  actor: Actor,
  body: { postId?: string; commentId?: string; kind: string },
): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/reactions", {
      method: "POST",
      headers: mutatingHeaders(actor),
      body: JSON.stringify(body),
    }),
  );
}

function unreact(
  actor: Actor,
  target: { postId?: string; commentId?: string },
  kind: string,
): Promise<Response> {
  const q = new URLSearchParams({ kind });
  if (target.postId !== undefined) q.set("postId", target.postId);
  if (target.commentId !== undefined) q.set("commentId", target.commentId);
  return fetchWorker(
    new Request(`https://api.test/reactions?${q.toString()}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function reactionCount(where: { postId?: string; commentId?: string }, kind: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const col = where.postId !== undefined ? "post_id" : "comment_id";
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM reactions WHERE ${col} = $1 AND kind = $2`,
      [where.postId ?? where.commentId, kind],
    );
    return Number(rows[0]!.n);
  });
  await waitOnExecutionContext(ctx);
  return n;
}

let author: Actor;
let reader: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  reader = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});
afterAll(deleteCreatedUsers);

describe("POST /reactions", () => {
  it("toggles on a post reaction idempotently (201, one row)", async () => {
    expect((await react(reader, { postId, kind: "insightful" })).status).toBe(201);
    expect((await react(reader, { postId, kind: "insightful" })).status).toBe(201);
    expect(await reactionCount({ postId }, "insightful")).toBe(1);
  });

  it("allows MULTIPLE tones from one user on one target (multi-toggle)", async () => {
    await react(reader, { postId, kind: "agree" });
    await react(reader, { postId, kind: "challenging" });
    expect(await reactionCount({ postId }, "agree")).toBe(1);
    expect(await reactionCount({ postId }, "challenging")).toBe(1);
  });

  it("reacts to a comment", async () => {
    const c = await insertComment(postId, author.userId);
    expect((await react(reader, { commentId: c.id, kind: "curious" })).status).toBe(201);
    expect(await reactionCount({ commentId: c.id }, "curious")).toBe(1);
  });

  it("400s INVALID_REACTION_KIND for an unknown kind", async () => {
    const response = await react(reader, { postId, kind: "love" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_REACTION_KIND");
  });

  it("400s INVALID_INPUT for zero or two targets", async () => {
    expect((await react(reader, { kind: "agree" })).status).toBe(400);
    const c = await insertComment(postId, author.userId);
    expect((await react(reader, { postId, commentId: c.id, kind: "agree" })).status).toBe(400);
  });

  it("404s a draft post and a nonexistent post (parity)", async () => {
    const draft = await insertPost(author.userId, "draft");
    expect((await react(reader, { postId: draft, kind: "agree" })).status).toBe(404);
    expect((await react(reader, { postId: crypto.randomUUID(), kind: "agree" })).status).toBe(404);
  });

  it("404s COMMENT_NOT_FOUND / 409s COMMENT_DELETED for comment targets", async () => {
    const missing = await react(reader, { commentId: crypto.randomUUID(), kind: "agree" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
    const c = await insertComment(postId, author.userId, undefined, true); // tombstoned
    const dead = await react(reader, { commentId: c.id, kind: "agree" });
    expect(dead.status).toBe(409);
    expect(((await dead.json()) as { code: string }).code).toBe("COMMENT_DELETED");
  });

  it("gates: 403 unverified, 409 no handle", async () => {
    const unverified = await createUnverifiedActor();
    expect((await react(unverified, { postId, kind: "agree" })).status).toBe(403);
    const noHandle = await createVerifiedActor();
    expect((await react(noHandle, { postId, kind: "agree" })).status).toBe(409);
  });
});

describe("DELETE /reactions", () => {
  it("toggles off (200) and is a 200 no-op when absent", async () => {
    await react(reader, { postId, kind: "curious" });
    expect((await unreact(reader, { postId }, "curious")).status).toBe(200);
    expect(await reactionCount({ postId }, "curious")).toBe(0);
    expect((await unreact(reader, { postId }, "curious")).status).toBe(200);
  });

  it("retracts from a since-tombstoned comment (no target-state validation)", async () => {
    const c = await insertComment(postId, author.userId);
    await react(reader, { commentId: c.id, kind: "agree" });
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (cl) =>
      cl.query("UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1", [c.id]),
    );
    await waitOnExecutionContext(ctx);
    expect((await unreact(reader, { commentId: c.id }, "agree")).status).toBe(200);
    expect(await reactionCount({ commentId: c.id }, "agree")).toBe(0);
  });

  it("400s on bad kind / bad target shape", async () => {
    expect((await unreact(reader, { postId }, "love")).status).toBe(400);
    expect((await unreact(reader, {}, "agree")).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test reactions`

- [ ] **Step 3: Implement.** `apps/api/src/routes/reactions.ts` (write handlers only in this task — the two GET reads are Task 7's, same file):

```ts
/**
 * REACTION TOGGLES — idempotent by construction, both directions:
 * on = INSERT … ON CONFLICT (reactions_target_unique) DO NOTHING; off = an
 * unconditional DELETE of the matching row. NO PURGE on either (spec decision 5):
 * reaction counts live in a client island, never in cached HTML — purging the
 * post page per toggle would be a purge storm against a 5/min zone budget.
 * Removal skips target-state validation on purpose: a user must always be able
 * to retract, even from a since-tombstoned comment.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { hasChosenUsername } from "../db/onboarding";
import { errorResponse } from "../http/errors";

import { REACTION_KINDS, ReactionInput } from "@thinkersjournal/shared";

import type { ReactionKind } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isKind(v: string): v is ReactionKind {
  return (REACTION_KINDS as readonly string[]).includes(v);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleAddReaction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.REACTION_LIMITER, `reaction:${userId}`);
  if (limited !== null) return limited;

  if (!(await hasChosenUsername(env, ctx, userId))) {
    return errorResponse("USERNAME_REQUIRED", 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = ReactionInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["postId", "commentId", "kind"] });
  }
  const { postId, commentId, kind } = parsed.data;
  if (!isKind(kind)) return errorResponse("INVALID_REACTION_KIND", 400);

  let error: Response | null = null;
  try {
    error = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      if (postId !== undefined) {
        const post = await c.query<{ status: string }>(
          "SELECT status FROM posts WHERE id = $1",
          [postId],
        );
        if (post.rows[0]?.status !== "published") return errorResponse("NOT_FOUND", 404);
      } else {
        // A comment target must be live AND sit on a published post (draft parity).
        const comment = await c.query<{ deleted: boolean }>(
          `SELECT (c.deleted_at IS NOT NULL) AS deleted
             FROM comments c JOIN posts p ON p.id = c.post_id AND p.status = 'published'
            WHERE c.id = $1`,
          [commentId],
        );
        const row = comment.rows[0];
        if (row === undefined) return errorResponse("COMMENT_NOT_FOUND", 404);
        if (row.deleted) return errorResponse("COMMENT_DELETED", 409);
      }

      await c.query(
        `INSERT INTO reactions (user_id, post_id, comment_id, kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT reactions_target_unique DO NOTHING`,
        [userId, postId ?? null, commentId ?? null, kind],
      );
      return null;
    });
  } catch (err) {
    // Target deleted between check and insert → FK 23503; same answer as "never there".
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if (error !== null) return error;
  return json({}, 201);
}

export async function handleRemoveReaction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.REACTION_LIMITER, `reaction:${userId}`);
  if (limited !== null) return limited;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "";
  const postId = url.searchParams.get("postId");
  const commentId = url.searchParams.get("commentId");
  if (!isKind(kind)) return errorResponse("INVALID_REACTION_KIND", 400);
  const oneTarget = (postId === null) !== (commentId === null);
  const target = postId ?? commentId ?? "";
  if (!oneTarget || !UUID_RE.test(target)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["postId", "commentId"] });
  }

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    postId !== null
      ? c.query("DELETE FROM reactions WHERE user_id=$1 AND kind=$2 AND post_id=$3", [userId, kind, postId])
      : c.query("DELETE FROM reactions WHERE user_id=$1 AND kind=$2 AND comment_id=$3", [userId, kind, commentId]),
  );
  return json({});
}
```

Register in `src/routes.ts` (with the engagement-writes block):

```ts
  { method: "POST", pattern: "/reactions", handler: handleAddReaction },
  { method: "DELETE", pattern: "/reactions", handler: handleRemoveReaction },
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test reactions route-protection error-envelope`

- [ ] **Step 5: Purge-wiring negative** (append to `purge-wiring.test.ts`):

```ts
describe("reactions NEVER purge (spec decision 5)", () => {
  it("react + unreact both purge NOTHING", async () => {
    const postId = await createPublished(actor);
    const on = await fetchCapturingPurges(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: {
          Origin: "http://localhost:8787",
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ postId, kind: "insightful" }),
      }),
    );
    expect(on.response.status).toBe(201);
    expect(on.purges).toHaveLength(0);
    const off = await fetchCapturingPurges(
      new Request(`https://api.test/reactions?postId=${postId}&kind=insightful`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:8787",
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
        },
      }),
    );
    expect(off.response.status).toBe(200);
    expect(off.purges).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @thinkersjournal/api test purge-wiring` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/routes/reactions.ts apps/api/src/routes.ts apps/api/test/reactions.test.ts apps/api/test/purge-wiring.test.ts
git commit -m "feat(m2.2): reaction toggles — idempotent on/off, gates, no purge"
```

### Task 7: `GET /public/reactions` + `GET /reactions/mine`

**Files:**
- Modify: `apps/api/src/routes/reactions.ts`, `apps/api/src/routes.ts`, `apps/api/test/reactions.test.ts`, `apps/api/test/error-envelope.test.ts`

**Interfaces:**
- Consumes: `PublicReactions`, `MyReactions`, `REACTION_KINDS` (Task 2); Task 6's file-local `json`/`UUID_RE`.
- Produces: `handlePublicReactions` at `GET /public/reactions?postId=` (anonymous — counts for the post AND every comment on it, all four kinds always present, zero-filled) and `handleMyReactions` at `GET /reactions/mine?postId=` (session via `readCurrentSession`, 401 `LOGIN_REQUIRED`; the viewer's own kinds, same two-level shape). Both 404 on missing/draft posts (parity).

- [ ] **Step 1: Write the failing tests** (append to `test/reactions.test.ts`):

```ts
function getPublicReactions(postId: string): Promise<Response> {
  return fetchWorker(new Request(`https://api.test/public/reactions?postId=${postId}`));
}

function getMine(actor: Actor, postId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/reactions/mine?postId=${postId}`, {
      headers: { Cookie: actor.cookie },
    }),
  );
}

describe("GET /public/reactions", () => {
  it("zero-fills all four kinds for post and listed comments", async () => {
    const p = await insertPost(author.userId, "published");
    const c = await insertComment(p, author.userId);
    await react(reader, { postId: p, kind: "insightful" });
    await react(author, { postId: p, kind: "insightful" });
    await react(reader, { commentId: c.id, kind: "challenging" });
    const body = (await (await getPublicReactions(p)).json()) as {
      post: Record<string, number>;
      comments: Record<string, Record<string, number>>;
    };
    expect(body.post).toEqual({ insightful: 2, curious: 0, agree: 0, challenging: 0 });
    expect(body.comments[c.id]).toEqual({ insightful: 0, curious: 0, agree: 0, challenging: 1 });
  });

  it("404s draft/nonexistent posts and a missing postId", async () => {
    const draft = await insertPost(author.userId, "draft");
    expect((await getPublicReactions(draft)).status).toBe(404);
    expect((await getPublicReactions(crypto.randomUUID())).status).toBe(404);
    expect((await fetchWorker(new Request("https://api.test/public/reactions"))).status).toBe(404);
  });
});

describe("GET /reactions/mine", () => {
  it("returns ONLY the viewer's toggles, two-level", async () => {
    const p = await insertPost(author.userId, "published");
    const c = await insertComment(p, author.userId);
    await react(reader, { postId: p, kind: "agree" });
    await react(reader, { commentId: c.id, kind: "curious" });
    await react(author, { postId: p, kind: "challenging" }); // someone else's — must not appear
    const body = (await (await getMine(reader, p)).json()) as {
      post: string[];
      comments: Record<string, string[]>;
    };
    expect(body.post).toEqual(["agree"]);
    expect(body.comments[c.id]).toEqual(["curious"]);
  });

  it("401s LOGIN_REQUIRED with no session", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/reactions/mine?postId=${postId}`),
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("LOGIN_REQUIRED");
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement** (append to `src/routes/reactions.ts`; add `readCurrentSession` to the pipeline import):

```ts
import type { MyReactions, PublicReactions, ReactionCounts } from "@thinkersjournal/shared";

function zeroCounts(): ReactionCounts {
  return { insightful: 0, curious: 0, agree: 0, challenging: 0 };
}

/** Shared 404-parity gate for the two reads. Returns true iff postId names a published post. */
async function postIsPublished(env: Env, ctx: ExecutionContext, postId: string): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [postId],
    );
    return rows[0]?.status === "published";
  });
}

export async function handlePublicReactions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const postId = new URL(request.url).searchParams.get("postId") ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("NOT_FOUND", 404);
  if (!(await postIsPublished(env, ctx, postId))) return errorResponse("NOT_FOUND", 404);

  const body = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const post = await c.query<{ kind: ReactionKind; n: number }>(
      "SELECT kind, count(*)::int AS n FROM reactions WHERE post_id = $1 GROUP BY kind",
      [postId],
    );
    const comments = await c.query<{ commentId: string; kind: ReactionKind; n: number }>(
      `SELECT r.comment_id AS "commentId", r.kind, count(*)::int AS n
         FROM reactions r JOIN comments c2 ON c2.id = r.comment_id
        WHERE c2.post_id = $1
        GROUP BY r.comment_id, r.kind`,
      [postId],
    );
    const result: PublicReactions = { post: zeroCounts(), comments: {} };
    for (const row of post.rows) result.post[row.kind] = row.n;
    for (const row of comments.rows) {
      (result.comments[row.commentId] ??= zeroCounts())[row.kind] = row.n;
    }
    return result;
  });
  return json(body);
}

export async function handleMyReactions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const postId = new URL(request.url).searchParams.get("postId") ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("NOT_FOUND", 404);
  if (!(await postIsPublished(env, ctx, postId))) return errorResponse("NOT_FOUND", 404);

  const body = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const post = await c.query<{ kind: ReactionKind }>(
      "SELECT kind FROM reactions WHERE user_id = $1 AND post_id = $2",
      [session.userId, postId],
    );
    const comments = await c.query<{ commentId: string; kind: ReactionKind }>(
      `SELECT r.comment_id AS "commentId", r.kind
         FROM reactions r JOIN comments c2 ON c2.id = r.comment_id
        WHERE r.user_id = $1 AND c2.post_id = $2`,
      [session.userId, postId],
    );
    const result: MyReactions = { post: post.rows.map((r) => r.kind), comments: {} };
    for (const row of comments.rows) (result.comments[row.commentId] ??= []).push(row.kind);
    return result;
  });
  return json(body);
}
```

Register both (public one in the anonymous block, mine beside `/follows/status`):

```ts
  { method: "GET", pattern: "/public/reactions", handler: handlePublicReactions },
  // The viewer's own reaction toggles (M2.2) — session-read GET, like /follows/status.
  { method: "GET", pattern: "/reactions/mine", handler: handleMyReactions },
```

Add TWO `CASES` entries in `error-envelope.test.ts`:

```ts
  {
    name: "404 public reactions without a postId",
    route: "GET /public/reactions",
    build: () => new Request("https://api.test/public/reactions"),
  },
  {
    name: "401 reactions/mine with no session",
    route: "GET /reactions/mine",
    build: () =>
      new Request("https://api.test/reactions/mine?postId=00000000-0000-7000-8000-000000000000"),
  },
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test reactions error-envelope route-protection` then the FULL api suite once: `pnpm --filter @thinkersjournal/api test` (expect 471 baseline + all new green) and `pnpm --filter @thinkersjournal/api run check:workerd` if that script exists in the api package (else the root `pnpm run check:workerd`).

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/reactions.ts apps/api/src/routes.ts apps/api/test/reactions.test.ts apps/api/test/error-envelope.test.ts
git commit -m "feat(m2.2): reaction reads — public zero-filled counts + viewer's own toggles"
```

---

### Task 8: `Me.userId` — the identity the comments island needs

**Files:**
- Modify: `packages/shared/src/social.ts`, `apps/api/src/routes/username.ts`, `apps/api/test/username.test.ts`, `apps/web/src/pages/api/me.ts`, `apps/web/test/nav-auth-proxies.test.ts` (only if it enumerates keys)

**Interfaces:**
- Consumes: `Me`, `handleGetMe`, `handleChooseUsername`, web `/api/me`.
- Produces: `Me` gains `userId: string`; `GET /profile/me` and `POST /profile/username` include it; web `/api/me` responds `{ loggedIn, userId, username, usernameChosen, csrfToken }` (`userId: null` logged out). Task 11's island reads `userId` from `/api/me`. Additive — nav-auth island ignores unknown keys.

- [ ] **Step 1: Failing test.** In `apps/api/test/username.test.ts`, find the `GET /profile/me` happy-path case and ADD (do not replace) an assertion that the body includes `userId` equal to the actor's id; same for the choose-username 200 body. Run `pnpm --filter @thinkersjournal/api test username` → the new assertions FAIL.

- [ ] **Step 2: Implement.**
  - `packages/shared/src/social.ts` — `Me` gains a first field: `/** The viewer's own user id — the comments island compares it to data-author-id. */ userId: string;`
  - `apps/api/src/routes/username.ts` — `handleChooseUsername`'s success: `json({ userId, username, usernameChosen: true } satisfies Me)`. `handleGetMe`: select `user_id AS "userId"` alongside the two columns (or spread `{ userId: session.userId, ...me }` — pick the SELECT so the row is the single source) and keep the `satisfies Me`.
  - `apps/web/src/pages/api/me.ts` — logged-out body gains `userId: null`; logged-in body gains `userId: me.data.userId`.
  - TypeScript will now FLAG every other `satisfies Me` / consumer that omits `userId` — fix each it names (that enumeration is the point of the `satisfies`).

- [ ] **Step 3: Run → PASS.** `pnpm --filter @thinkersjournal/api test username && pnpm --filter @thinkersjournal/web test nav-auth && pnpm typecheck`. If `nav-auth-proxies.test.ts` pins exact JSON key sets, extend those assertions additively (assert `userId` present) — never delete an existing assertion.

- [ ] **Step 4: Commit.**
```bash
git add packages/shared/src/social.ts apps/api/src/routes/username.ts apps/api/test/username.test.ts apps/web/src/pages/api/me.ts apps/web/test/nav-auth-proxies.test.ts
git commit -m "feat(m2.2): Me.userId — additive identity for the comments island"
```

---

### Task 9: Web proxies — comments + reactions

**Files:**
- Create: `apps/web/src/pages/api/comment.ts`, `comment-update.ts`, `comment-delete.ts`, `comments.ts`, `react.ts`, `unreact.ts`, `reactions.ts`
- Test: `apps/web/test/comment-proxies.test.ts`, `apps/web/test/reaction-proxies.test.ts`

**Interfaces:**
- Consumes: `apiFetch`/`applyCookies` (`src/lib/api.ts`), `markPrivate` (`src/lib/cache.ts`), api routes from Tasks 3–7.
- Produces (island contracts, Task 11/12 fetch these):
  - `POST /api/comment` `{postId, parentId?, markdownSource}` → api `POST /comments` (authed hop)
  - `POST /api/comment-update` `{commentId, markdownSource}` → api `PATCH /comments/:id`
  - `POST /api/comment-delete` `{commentId}` → api `DELETE /comments/:id`
  - `GET /api/comments?postId=&cursor=` → api `GET /public/comments` (ANONYMOUS passthrough — edit-prefill)
  - `POST /api/react` / `POST /api/unreact` `{postId?|commentId?, kind}` → api `POST /reactions` / `DELETE /reactions?…`
  - `GET /api/reactions?postId=` → merged `{ counts: PublicReactions, mine: MyReactions | null, viewerLoggedIn: boolean, csrfToken: string | null }`

- [ ] **Step 1: Write the failing source-structure tests.** `apps/web/test/comment-proxies.test.ts` (mirror `social-proxies.test.ts`'s exact idiom — `readFileSync` + `stripComments` + table-driven):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const AUTHED = [
  { file: "comment.ts", upstream: "/comments", method: "POST" },
  { file: "comment-update.ts", upstream: "/comments/", method: "PATCH" },
  { file: "comment-delete.ts", upstream: "/comments/", method: "DELETE" },
] as const;

describe("comment write proxies", () => {
  for (const { file, upstream, method } of AUTHED) {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    it(`${file} is markPrivate and forwards cookie+origin+csrf to ${method} ${upstream}`, () => {
      expect(code).toContain("markPrivate(");
      expect(code).toContain(`"${upstream}`);
      expect(code).toContain("request: context.request");
      expect(code).toContain('context.request.headers.get("Origin")');
      expect(code).toContain('context.request.headers.get("X-CSRF-Token")');
      expect(code).toContain("applyCookies(");
      if (method !== "POST") expect(code).toContain(`method: "${method}"`);
    });
  }
});

describe("GET /api/comments (anonymous passthrough)", () => {
  const code = stripComments(readFileSync(join(DIR, "comments.ts"), "utf8"));
  it("is markPrivate and hits /public/comments", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toContain("/public/comments");
  });
  it("forwards NO cookie — the upstream is anonymous", () => {
    expect(code).toContain("apiFetch"); // anti-vacuity anchor
    expect(code).not.toContain("request: context.request");
  });
});
```

`apps/web/test/reaction-proxies.test.ts`:

```ts
// same imports/stripComments helper as above

describe("reaction toggle proxies", () => {
  for (const { file, upstream } of [
    { file: "react.ts", upstream: '"/reactions"' },
    { file: "unreact.ts", upstream: "`/reactions?" },
  ] as const) {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    it(`${file} is markPrivate, authed, and targets /reactions`, () => {
      expect(code).toContain("markPrivate(");
      expect(code).toContain(upstream);
      expect(code).toContain("request: context.request");
      expect(code).toContain('context.request.headers.get("X-CSRF-Token")');
      expect(code).toContain("applyCookies(");
    });
  }
  it("unreact maps to the api's DELETE", () => {
    const code = stripComments(readFileSync(join(DIR, "unreact.ts"), "utf8"));
    expect(code).toContain('method: "DELETE"');
  });
});

describe("GET /api/reactions (merge)", () => {
  const code = stripComments(readFileSync(join(DIR, "reactions.ts"), "utf8"));
  it("is markPrivate; counts hop is ANONYMOUS, mine hop is authed", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toContain("/public/reactions");
    expect(code).toContain("/reactions/mine");
    // The counts fetch call must not carry the browser request…
    const countsCall = code.slice(code.indexOf("/public/reactions"), code.indexOf("/reactions/mine"));
    expect(countsCall).not.toContain("request: context.request");
    // …the mine fetch must.
    const mineCall = code.slice(code.indexOf("/reactions/mine"));
    expect(mineCall).toContain("request: context.request");
  });
  it("propagates upstream errors honestly (no 200-masking) and merges csrf", () => {
    expect(code).toContain("counts.status"); // branches on it
    expect(code).toContain("/auth/csrf");
    expect(code).toContain("viewerLoggedIn");
  });
});
```

Run `pnpm --filter @thinkersjournal/web test comment-proxies reaction-proxies` → FAIL (files missing).

- [ ] **Step 2: Implement the seven files.** Each mirrors `api/follow.ts` / `api/social.ts` verbatim in shape. Representative code (the others differ only in path/body — write each out fully in its file):

`src/pages/api/comment.ts`:
```ts
/**
 * BROWSER → api authed hop for COMMENT CREATE. Same pattern as /api/follow:
 * forwards HttpOnly cookie + browser Origin + double-submit CSRF over the
 * Service Binding. Never cached (markPrivate).
 */
import { apiFetch, applyCookies } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  }

  const response = await apiFetch<unknown>("/comments", {
    method: "POST",
    body,
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
};
```

`comment-update.ts` — same skeleton; parse `{ commentId, markdownSource }`, validate `typeof commentId === "string"` (else 400 INVALID_INPUT), then
`apiFetch(`/comments/${encodeURIComponent(commentId)}`, { method: "PATCH", body: { markdownSource }, request, origin, csrfToken })`.

`comment-delete.ts` — parse `{ commentId }`, then `apiFetch(`/comments/${encodeURIComponent(commentId)}`, { method: "DELETE", request, origin, csrfToken })`.

`comments.ts` (GET, anonymous):
```ts
export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });
  const url = new URL(context.request.url);
  const q = new URLSearchParams({ postId: url.searchParams.get("postId") ?? "" });
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) q.set("cursor", cursor);
  // ⚠️ ANONYMOUS on purpose — /public/comments reads no session; forwarding the
  // cookie here would buy nothing and break the anonymous-hop convention.
  const response = await apiFetch<unknown>(`/public/comments?${q.toString()}`);
  return new Response(response.text, { status: response.status, headers });
};
```

`react.ts` — `comment.ts`'s skeleton against `"/reactions"`. `unreact.ts`:
```ts
  const body = (await context.request.json().catch(() => null)) as
    | { postId?: unknown; commentId?: unknown; kind?: unknown }
    | null;
  if (body === null) return new Response(JSON.stringify({ code: "INVALID_JSON" }), { status: 400, headers });
  const q = new URLSearchParams();
  if (typeof body.postId === "string") q.set("postId", body.postId);
  if (typeof body.commentId === "string") q.set("commentId", body.commentId);
  if (typeof body.kind === "string") q.set("kind", body.kind);
  const response = await apiFetch<unknown>(`/reactions?${q.toString()}`, {
    method: "DELETE",
    request: context.request,
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
  });
  applyCookies(headers, response.setCookies);
  return new Response(response.text, { status: response.status, headers });
```

`reactions.ts` (GET merge — the `/api/social` status-mode pattern):
```ts
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { MyReactions, PublicReactions } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const postId = new URL(context.request.url).searchParams.get("postId") ?? "";
  const counts = await apiFetch<PublicReactions>(
    `/public/reactions?postId=${encodeURIComponent(postId)}`,
  );
  if (counts.status !== 200) {
    // Honest propagation — a 404/500 here must not masquerade as an empty page.
    return new Response(counts.text, { status: counts.status, headers });
  }

  const mine = await apiFetch<MyReactions>(
    `/reactions/mine?postId=${encodeURIComponent(postId)}`,
    { request: context.request },
  );
  if (mine.status === 401) {
    return new Response(
      JSON.stringify({ counts: counts.data, mine: null, viewerLoggedIn: false, csrfToken: null }),
      { status: 200, headers },
    );
  }
  if (mine.status !== 200) {
    return new Response(mine.text, { status: mine.status, headers });
  }
  const csrf = await apiFetch<{ csrfToken: string }>("/auth/csrf", { request: context.request });
  return new Response(
    JSON.stringify({
      counts: counts.data,
      mine: mine.data,
      viewerLoggedIn: true,
      csrfToken: csrf.status === 200 ? (csrf.data?.csrfToken ?? null) : null,
    }),
    { status: 200, headers },
  );
};
```

- [ ] **Step 3: Run → PASS.** `pnpm --filter @thinkersjournal/web test comment-proxies reaction-proxies page-cache-inventory` — the inventory SWEEP auto-enumerates the seven new files; each calls exactly one helper (`markPrivate`) so it must pass unedited.

- [ ] **Step 4: Commit.**
```bash
git add apps/web/src/pages/api apps/web/test/comment-proxies.test.ts apps/web/test/reaction-proxies.test.ts
git commit -m "feat(m2.2): web proxies — comment writes, comments passthrough, reaction toggles + merge read"
```

---

### Task 10: Post page — SSR comments + reaction chip markup

**Files:**
- Create: `apps/web/src/components/ReactionChips.astro`
- Modify: `apps/web/src/pages/[handle]/[slug].astro`
- Test: extend `apps/web/test/post-page.test.ts`

**Interfaces:**
- Consumes: `GET /public/comments` (Task 5), `CommentsPage`, `REACTION_KINDS`, `REACTION_LABELS` (Task 2), `renderMarkdown`.
- Produces: the SSR comment tree + static chip markup Task 11/12's islands hydrate. Data contract (the islands' ONLY inputs): section `[data-comments][data-post-id][data-post-author-id]`; per-comment `<li data-comment-id data-depth data-author-id?>` (`data-author-id` ABSENT on tombstones); `[data-comment-form-slot]` with an SSR login-link default; chips `[data-reactions][data-target-post|data-target-comment]` containing `button[data-kind]` + `[data-count]`; cursor link `?comments=<path>`.

- [ ] **Step 1: Write the failing tests** (append to `post-page.test.ts`, matching its stripComments/source-grep idiom):

```ts
describe("comments SSR (M2.2)", () => {
  it("fetches /public/comments ANONYMOUSLY and renders through renderMarkdown", () => {
    expect(code).toContain("/public/comments");
    // The comments fetch, like the post fetch, must omit `request:` — positive
    // anchor first, then the page-wide negative the M1 tripwires already pin.
    expect(code).toContain("apiFetch<CommentsPage>");
    expect(code).toContain("renderMarkdown(c.bodyMarkdown)");
  });

  it("exposes EXACTLY the island data contract", () => {
    expect(code).toContain("data-comments");
    expect(code).toContain(`data-post-id={post.id}`);
    expect(code).toContain(`data-post-author-id={post.authorId}`);
    expect(code).toContain("data-comment-id={c.id}");
    expect(code).toContain("data-depth={c.depth}");
    expect(code).toContain("data-comment-form-slot");
  });

  it("tombstones render [deleted] with NO author link and NO author id", () => {
    expect(code).toContain("[deleted]");
    // authorId is undefined for tombstones (flat map below) → Astro omits the attr:
    expect(code).toContain("data-author-id={c.authorId}");
    expect(code).toContain("authorId: c.author?.userId");
    expect(code).toMatch(/c\.deleted\s*\?/);
  });

  it("paginates via ?comments= cursor and noindexes cursor variants", () => {
    expect(code).toContain('Astro.url.searchParams.get("comments")');
    expect(code).toContain("?comments=${encodeURIComponent(");
    expect(code).toContain('name="robots" content="noindex, follow"');
  });

  it("mounts BOTH islands as bundled imports", () => {
    expect(code).toContain('import { initCommentsIsland } from "../../scripts/comments"');
    expect(code).toContain('import { initReactionsIsland } from "../../scripts/reactions"');
  });
});
```

AND update the existing sink-count pin: the current test asserts EXACTLY TWO `set:html` sinks. Change it to assert EXACTLY THREE, each named — `set:html={html}` (post body), `set:html={jsonLdScript(jsonLd)}` (ld+json), `set:html={c.html}` (comment bodies, bound only to `renderMarkdown` output). Keep the “no OTHER set:html” negative. This is a deliberate, documented strengthening — the sink inventory grows by one NAMED entry; it must never become a loose count.

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/web test post-page`

- [ ] **Step 3: Implement.** `src/components/ReactionChips.astro` (markup only — components never touch cache helpers):

```astro
---
/**
 * Static reaction chips — counts and pressed-state hydrate CLIENT-SIDE
 * (scripts/reactions.ts): reaction state is per-viewer/volatile and must never
 * enter this cached HTML (spec decision 5). Buttons ship disabled; the island
 * enables them once it knows the viewer.
 */
import { REACTION_KINDS, REACTION_LABELS } from "@thinkersjournal/shared";

interface Props {
  postId?: string;
  commentId?: string;
}
const { postId, commentId } = Astro.props;
---
<div class="reactions" data-reactions data-target-post={postId} data-target-comment={commentId}>
  {REACTION_KINDS.map((kind) => (
    <button type="button" class="chip" data-kind={kind} aria-pressed="false" disabled>
      {REACTION_LABELS[kind]} <span data-count>—</span>
    </button>
  ))}
</div>
```

In `[handle]/[slug].astro` — frontmatter additions (after the `post` fetch, before `markPublicCacheable`):

```ts
import ReactionChips from "../../components/ReactionChips.astro";
// … existing imports; add CommentsPage to the shared type import.

// ⚠️ ANONYMOUS, like the post fetch above — no `request`, no Cookie, nothing
// viewer-specific in this render. Comments are CONTENT: they live in this
// cached HTML and every comment write purges post:<id> (api routes/comments.ts).
const commentsCursor = Astro.url.searchParams.get("comments");
const commentsQ = new URLSearchParams({ postId: post.id });
if (commentsCursor !== null) commentsQ.set("cursor", commentsCursor);
const commentsResp = await apiFetch<CommentsPage>(`/public/comments?${commentsQ.toString()}`);
// Fail-soft: a comments hiccup must not 404 a healthy post page.
const commentsPage: CommentsPage =
  commentsResp.status === 200 && commentsResp.data !== null
    ? commentsResp.data
    : { comments: [], nextCursor: null };
// READ-TIME RENDER through the same sanitize-first pipeline as the post body —
// the ONLY producer of comment HTML. Tombstones render no body at all.
// FLATTENED for the template: `author` is nullable and JSX can't narrow it off
// `deleted`, so derive plain fields here (authorId undefined on tombstones →
// Astro omits the data attribute entirely).
const renderedComments = await Promise.all(
  commentsPage.comments.map(async (c) => ({
    id: c.id,
    depth: c.depth,
    deleted: c.deleted,
    createdAt: c.createdAt,
    edited: c.editedAt !== null,
    authorId: c.author?.userId,
    authorUsername: c.author?.username ?? "",
    authorName: c.author === null ? null : (c.author.displayName ?? c.author.username),
    html: c.deleted ? "" : await renderMarkdown(c.bodyMarkdown),
  })),
);
const olderCommentsHref =
  commentsPage.nextCursor === null
    ? null
    : `?comments=${encodeURIComponent(commentsPage.nextCursor)}`;
```

Head slot addition (cursor variants are pagination, not distinct content — the profile page's exact pattern):

```astro
    {commentsCursor !== null && <meta name="robots" content="noindex, follow" />}
```

Markup after `</article>`, before the closing `</BaseLayout>`:

```astro
  <section class="wrap comments" data-comments data-post-id={post.id} data-post-author-id={post.authorId}>
    <h2>Comments</h2>

    <ReactionChips postId={post.id} />

    {/* SSR default = the logged-out affordance. The comments island REPLACES
        this for signed-in viewers (form) / un-onboarded ones (choose-handle
        link) — progressive enhancement, nav-auth style; the cached HTML is
        identical for everyone. */}
    <div data-comment-form-slot>
      <p><a class="link" href="/login">Log in</a> to join the conversation.</p>
    </div>

    {renderedComments.length === 0 && <p class="no-comments">No comments yet.</p>}
    <ol class="comment-list">
      {renderedComments.map((c) => (
        <li
          class={`comment depth-${Math.min(c.depth, 6)}`}
          data-comment-id={c.id}
          data-depth={c.depth}
          data-author-id={c.authorId}
          data-deleted={c.deleted ? "true" : undefined}
        >
          {c.deleted ? (
            <p class="tombstone">[deleted]</p>
          ) : (
            <>
              <p class="meta">
                <a class="link" href={`/@${encodeURIComponent(c.authorUsername)}`}>
                  {c.authorName}
                </a>
                · <time datetime={c.createdAt}>{c.createdAt.slice(0, 10)}</time>
                {c.edited && <span class="edited">(edited)</span>}
              </p>
              {/* The third and FINAL set:html sink — renderMarkdown output only,
                  same safety class as #post-body. Never bind anything else here. */}
              <div class="comment-body" set:html={c.html} />
              <ReactionChips commentId={c.id} />
              <div data-comment-actions></div>
            </>
          )}
        </li>
      ))}
    </ol>
    {olderCommentsHref !== null && <a class="link" href={olderCommentsHref}>Older comments →</a>}
  </section>

  <script>
    import { initCommentsIsland } from "../../scripts/comments";
    import { initReactionsIsland } from "../../scripts/reactions";
    initCommentsIsland();
    initReactionsIsland();
  </script>
```

Style block additions (append to the existing `<style>`):

```css
  .comments{padding:0 0 clamp(40px,7vw,80px);max-width:min(var(--wrap),760px)}
  .comment-list{list-style:none;margin:18px 0;padding:0;display:grid;gap:14px}
  .comment{border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .comment .meta{color:var(--dim);margin:0 0 6px}
  .comment .edited{color:var(--dim);font-size:.85em;margin-left:6px}
  .tombstone{color:var(--dim);font-style:italic;margin:0}
  .depth-1{margin-left:16px}.depth-2{margin-left:32px}.depth-3{margin-left:48px}
  .depth-4{margin-left:64px}.depth-5{margin-left:80px}.depth-6{margin-left:96px}
  .reactions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
  .chip{font-size:.85em}
  .chip[aria-pressed="true"]{outline:1px solid var(--green)}
```

The islands don't exist yet — create STUB modules so the build resolves (Task 11/12 fill them): `src/scripts/comments.ts` with `export function initCommentsIsland(): void {}` and `src/scripts/reactions.ts` with `export function initReactionsIsland(): void {}`, each with a one-line header naming its task.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test post-page page-cache-inventory feed-pages && pnpm --filter @thinkersjournal/web build && pnpm --filter @thinkersjournal/web test` (full — the build-gated manifest greps must run against the fresh build; the two island scripts must externalize like nav-auth).

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/components/ReactionChips.astro "apps/web/src/pages/[handle]/[slug].astro" apps/web/src/scripts/comments.ts apps/web/src/scripts/reactions.ts apps/web/test/post-page.test.ts
git commit -m "feat(m2.2): post page — SSR comment tree + chip markup, third named set:html sink"
```

---

### Task 11: The comments island

**Files:**
- Modify: `apps/web/src/scripts/comments.ts` (replace the stub)
- Test: `apps/web/test/comments-island.test.ts`

**Interfaces:**
- Consumes: `/api/me` (Task 8 shape), `/api/comment`, `/api/comment-update`, `/api/comment-delete`, `/api/comments` (Task 9), Task 10's data contract.
- Produces: `initCommentsIsland(): void`.

- [ ] **Step 1: Failing source tests.** `apps/web/test/comments-island.test.ts` (source-grep like `social-island.test.ts` / `nav-auth-island.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const code = readFileSync(join(__dirname, "..", "src", "scripts", "comments.ts"), "utf8");

describe("comments island", () => {
  it("reads viewer identity from /api/me and sends the CSRF header on writes", () => {
    expect(code).toContain('fetch("/api/me")');
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("builds DOM safely — createElement/textContent only", () => {
    expect(code).toContain("document.createElement"); // positive anchor
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
  it("routes the un-onboarded to /choose-username with a return path", () => {
    expect(code).toContain("/choose-username?next=");
  });
  it("reloads after a successful write (the purge already made the page fresh)", () => {
    expect(code).toContain("location.reload()");
  });
  it("hides Reply at the depth cap and edit-prefills from /api/comments", () => {
    expect(code).toContain("MAX_DEPTH");
    expect(code).toContain("/api/comments?");
  });
});
```

- [ ] **Step 2: Run → FAIL** (stub has none of it), then **Step 3: implement** `src/scripts/comments.ts`:

```ts
/**
 * THE COMMENTS ISLAND — hydrates per-viewer comment affordances onto the CACHED
 * post page: the comment form (or the right gate affordance), Reply/Edit/Delete
 * per comment. The page HTML is identical for every viewer; everything decided
 * here comes from /api/me at runtime. After ANY successful write it reloads —
 * the api purged post:<id> before answering, so the reload IS the fresh render.
 * DOM is built with createElement/textContent ONLY (no HTML injection sink).
 */
interface MeResponse {
  loggedIn: boolean;
  userId: string | null;
  username: string | null;
  usernameChosen: boolean;
  csrfToken: string | null;
}

interface CommentRowWire {
  id: string;
  bodyMarkdown: string;
}

const MAX_DEPTH = 8;

async function loadMe(): Promise<MeResponse> {
  try {
    const resp = await fetch("/api/me");
    if (!resp.ok) throw new Error("me failed");
    return (await resp.json()) as MeResponse;
  } catch {
    return { loggedIn: false, userId: null, username: null, usernameChosen: false, csrfToken: null };
  }
}

function showError(container: HTMLElement, message: string): void {
  let note = container.querySelector<HTMLElement>("[data-error]");
  if (note === null) {
    note = document.createElement("p");
    note.setAttribute("data-error", "");
    note.className = "comment-error";
    container.appendChild(note);
  }
  note.textContent = message;
}

function buildForm(opts: {
  csrfToken: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (markdownSource: string, form: HTMLFormElement) => Promise<Response>;
}): HTMLFormElement {
  const form = document.createElement("form");
  const textarea = document.createElement("textarea");
  textarea.name = "markdownSource";
  textarea.required = true;
  textarea.maxLength = 10_000;
  textarea.rows = 4;
  if (opts.initial !== undefined) textarea.value = opts.initial;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "btn btn-primary";
  button.textContent = opts.submitLabel;
  form.appendChild(textarea);
  form.appendChild(button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    void opts
      .onSubmit(textarea.value, form)
      .then(async (resp) => {
        if (resp.ok) {
          location.reload();
          return;
        }
        const body = (await resp.json().catch(() => null)) as { code?: string } | null;
        if (body?.code === "USERNAME_REQUIRED") {
          location.href = `/choose-username?next=${encodeURIComponent(location.pathname)}`;
          return;
        }
        button.disabled = false;
        showError(
          form,
          body?.code === "EMAIL_NOT_VERIFIED"
            ? "Verify your email to comment."
            : body?.code === "RATE_LIMITED"
              ? "Slow down a moment, then try again."
              : "Something went wrong — try again.",
        );
      })
      .catch(() => {
        button.disabled = false;
        showError(form, "Network error — try again.");
      });
  });
  return form;
}

function postJson(url: string, csrfToken: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
  });
}

/** The page's ?comments= cursor — edit-prefill must fetch the SAME page. */
function commentsCursor(): string | null {
  return new URLSearchParams(location.search).get("comments");
}

async function fetchSource(postId: string, commentId: string): Promise<string | null> {
  const q = new URLSearchParams({ postId });
  const cursor = commentsCursor();
  if (cursor !== null) q.set("cursor", cursor);
  const resp = await fetch(`/api/comments?${q.toString()}`);
  if (!resp.ok) return null;
  const page = (await resp.json()) as { comments: CommentRowWire[] };
  return page.comments.find((c) => c.id === commentId)?.bodyMarkdown ?? null;
}

export function initCommentsIsland(): void {
  const section = document.querySelector<HTMLElement>("[data-comments]");
  if (section === null) return;
  const postId = section.dataset.postId ?? "";
  const postAuthorId = section.dataset.postAuthorId ?? "";
  const slot = section.querySelector<HTMLElement>("[data-comment-form-slot]");

  void loadMe().then((me) => {
    // 1. The form slot: logged-out keeps the SSR login link; un-onboarded gets
    //    the choose-handle affordance; onboarded gets the real form.
    if (slot !== null && me.loggedIn) {
      if (!me.usernameChosen || me.csrfToken === null) {
        const p = document.createElement("p");
        const a = document.createElement("a");
        a.className = "link";
        a.href = `/choose-username?next=${encodeURIComponent(location.pathname)}`;
        a.textContent = "Choose your handle";
        p.appendChild(a);
        p.appendChild(document.createTextNode(" to join the conversation."));
        slot.replaceChildren(p);
      } else {
        const csrfToken = me.csrfToken;
        slot.replaceChildren(
          buildForm({
            csrfToken,
            submitLabel: "Comment",
            onSubmit: (markdownSource) =>
              postJson("/api/comment", csrfToken, { postId, markdownSource }),
          }),
        );
      }
    }

    // 2. Per-comment affordances — only for onboarded viewers with a token.
    if (!me.loggedIn || !me.usernameChosen || me.csrfToken === null || me.userId === null) return;
    const csrfToken = me.csrfToken;
    const viewerId = me.userId;

    for (const li of Array.from(
      section.querySelectorAll<HTMLElement>("[data-comment-id]:not([data-deleted])"),
    )) {
      const commentId = li.dataset.commentId ?? "";
      const authorId = li.dataset.authorId ?? "";
      const depth = Number(li.dataset.depth ?? "0");
      const actions = li.querySelector<HTMLElement>("[data-comment-actions]");
      if (actions === null) continue;

      if (depth < MAX_DEPTH) {
        const reply = document.createElement("button");
        reply.type = "button";
        reply.className = "btn btn-ghost";
        reply.textContent = "Reply";
        reply.addEventListener("click", () => {
          reply.disabled = true;
          actions.appendChild(
            buildForm({
              csrfToken,
              submitLabel: "Reply",
              onSubmit: (markdownSource) =>
                postJson("/api/comment", csrfToken, { postId, parentId: commentId, markdownSource }),
            }),
          );
        });
        actions.appendChild(reply);
      }

      if (authorId === viewerId) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "btn btn-ghost";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => {
          edit.disabled = true;
          void fetchSource(postId, commentId).then((source) => {
            if (source === null) {
              edit.disabled = false;
              return;
            }
            actions.appendChild(
              buildForm({
                csrfToken,
                submitLabel: "Save",
                initial: source,
                onSubmit: (markdownSource) =>
                  postJson("/api/comment-update", csrfToken, { commentId, markdownSource }),
              }),
            );
          });
        });
        actions.appendChild(edit);
      }

      // Delete: own comment, or ANY comment on the viewer's own post (decision 7).
      if (authorId === viewerId || viewerId === postAuthorId) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn btn-ghost";
        del.textContent = "Delete";
        del.addEventListener("click", () => {
          del.disabled = true;
          void postJson("/api/comment-delete", csrfToken, { commentId })
            .then((resp) => {
              if (resp.ok) location.reload();
              else del.disabled = false;
            })
            .catch(() => {
              del.disabled = false;
            });
        });
        actions.appendChild(del);
      }
    }
  });
}
```

(If `wrangler`'s ambient DOM types fight `replaceChildren`/`appendChild` the way they did `append` in M2.1, use the same fix the ledger records: `appendChild` + block-body arrows.)

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test comments-island post-page && pnpm --filter @thinkersjournal/web build` (island must externalize; check the built manifest greps stay green via the full suite).

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/scripts/comments.ts apps/web/test/comments-island.test.ts
git commit -m "feat(m2.2): comments island — gated form, reply/edit/delete affordances, reload-on-write"
```

---

### Task 12: The reactions island

**Files:**
- Modify: `apps/web/src/scripts/reactions.ts` (replace the stub)
- Test: `apps/web/test/reactions-island.test.ts`

**Interfaces:**
- Consumes: `/api/reactions` merge shape (Task 9), `/api/react`, `/api/unreact`, Task 10's chip markup.
- Produces: `initReactionsIsland(): void`.

- [ ] **Step 1: Failing source tests.** `apps/web/test/reactions-island.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const code = readFileSync(join(__dirname, "..", "src", "scripts", "reactions.ts"), "utf8");

describe("reactions island", () => {
  it("hydrates from ONE /api/reactions call and toggles via /api/react|unreact", () => {
    expect(code).toContain("/api/reactions?postId=");
    expect(code).toContain('"/api/react"');
    expect(code).toContain('"/api/unreact"');
  });
  it("sends the viewer to /login when logged out, with the CSRF header when not", () => {
    expect(code).toContain('"/login"');
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("is optimistic but reverts on failure", () => {
    expect(code).toContain("aria-pressed");
    expect(code).toContain("revert"); // function name below — keeps the intent greppable
  });
  it("never injects HTML", () => {
    expect(code).toContain("textContent"); // positive anchor
    expect(code).not.toContain("innerHTML");
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement** `src/scripts/reactions.ts`:

```ts
/**
 * THE REACTIONS ISLAND — hydrates every chip row on the post page (the post's
 * and each comment's) from ONE /api/reactions round trip: public counts always,
 * the viewer's own toggles + CSRF when signed in. Toggles are optimistic
 * (chip + count update immediately) and revert on a failed write. Reaction
 * state NEVER touches the cached HTML (spec decision 5) — chips ship disabled
 * with "—" counts and come alive only here.
 */
type Kind = "insightful" | "curious" | "agree" | "challenging";

interface ReactionsResponse {
  counts: { post: Record<Kind, number>; comments: Record<string, Record<Kind, number>> };
  mine: { post: Kind[]; comments: Record<string, Kind[]> } | null;
  viewerLoggedIn: boolean;
  csrfToken: string | null;
}

let csrfToken: string | null = null;

function applyState(section: HTMLElement, counts: Record<Kind, number>, mine: Kind[]): void {
  for (const btn of Array.from(section.querySelectorAll<HTMLButtonElement>("button[data-kind]"))) {
    const kind = btn.dataset.kind as Kind;
    const count = btn.querySelector<HTMLElement>("[data-count]");
    if (count !== null) count.textContent = String(counts[kind] ?? 0);
    btn.setAttribute("aria-pressed", mine.includes(kind) ? "true" : "false");
    btn.disabled = false;
  }
}

function toggle(btn: HTMLButtonElement, target: { postId?: string; commentId?: string }): void {
  if (csrfToken === null) {
    location.href = "/login";
    return;
  }
  const kind = btn.dataset.kind as Kind;
  const wasPressed = btn.getAttribute("aria-pressed") === "true";
  const count = btn.querySelector<HTMLElement>("[data-count]");
  const before = Number(count?.textContent ?? "0");

  // Optimistic flip…
  btn.setAttribute("aria-pressed", wasPressed ? "false" : "true");
  if (count !== null) count.textContent = String(wasPressed ? before - 1 : before + 1);

  const revert = (): void => {
    btn.setAttribute("aria-pressed", wasPressed ? "true" : "false");
    if (count !== null) count.textContent = String(before);
  };

  btn.disabled = true;
  void fetch(wasPressed ? "/api/unreact" : "/api/react", {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ ...target, kind }),
  })
    .then((resp) => {
      btn.disabled = false;
      if (!resp.ok) revert();
    })
    .catch(() => {
      btn.disabled = false;
      revert();
    });
}

export function initReactionsIsland(): void {
  const root = document.querySelector<HTMLElement>("[data-comments]");
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-reactions]"));
  if (root === null || sections.length === 0) return;
  const postId = root.dataset.postId ?? "";

  void fetch(`/api/reactions?postId=${encodeURIComponent(postId)}`)
    .then(async (resp) => {
      if (!resp.ok) return; // chips stay disabled with "—" — an honest degraded state
      const data = (await resp.json()) as ReactionsResponse;
      csrfToken = data.csrfToken;
      for (const section of sections) {
        const commentId = section.dataset.targetComment;
        const isPost = section.dataset.targetPost !== undefined;
        const counts = isPost
          ? data.counts.post
          : (data.counts.comments[commentId ?? ""] ??
             { insightful: 0, curious: 0, agree: 0, challenging: 0 });
        const mine = isPost ? (data.mine?.post ?? []) : (data.mine?.comments[commentId ?? ""] ?? []);
        applyState(section, counts, mine);
        for (const btn of Array.from(section.querySelectorAll<HTMLButtonElement>("button[data-kind]"))) {
          btn.addEventListener("click", () => {
            toggle(btn, isPost ? { postId } : { commentId: commentId ?? "" });
          });
        }
      }
    })
    .catch(() => {
      /* degraded state: chips stay disabled */
    });
}
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test reactions-island && pnpm --filter @thinkersjournal/web build && pnpm --filter @thinkersjournal/web test && pnpm typecheck` (full web pass before the e2e task).

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/scripts/reactions.ts apps/web/test/reactions-island.test.ts
git commit -m "feat(m2.2): reactions island — one-call hydration, optimistic toggles with revert"
```

---

### Task 13: E2E — the engagement spine

**Files:**
- Create: `e2e/engagement.spec.ts`

**Interfaces:**
- Consumes: `signUpAndVerify(page, request)`, `chooseUsername(page, handle)`, `uniqueHandle(prefix)`, `publishPost(page, {title, markdownSource})` from `e2e/helpers.ts`; everything above, through two real Workers + real Postgres.
- Produces: the only proof the whole loop works in a browser. (Reminder from `publish.spec.ts`: miniflare has NO Workers Cache — "the comment appears" locally proves the DB-backed re-render, and that IS the requirement here; the purge hop's cache effect stays deploy-gate-only.)

- [ ] **Step 1: Write the spec.** `e2e/engagement.spec.ts`:

```ts
/**
 * THE ENGAGEMENT SPINE — a real browser drives comment + reaction life-cycles
 * across both Workers: author A publishes; reader B comments, replies, edits,
 * reacts; an anonymous reader sees the comments; A moderates (deletes B's
 * comment on A's post); the un-onboarded see the gate affordance, not a form.
 *
 * ⚠️ miniflare does not simulate Workers Cache (see publish.spec.ts's header):
 * "the comment appears after reload" here observes the DB-backed re-render,
 * which is exactly what the requirement asks; the purge-driven cache
 * invalidation is deploy-gate-only and this file does NOT claim to test it.
 */
import { expect, test } from "@playwright/test";

import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("comment → reply → edit → react → anonymous sees it → author moderates", async ({
  page,
  browser,
}) => {
  // ---- Author A publishes --------------------------------------------------
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, {
    title: "Engagement Spine",
    markdownSource: "A post worth **discussing**.",
  });

  // ---- Reader B comments ---------------------------------------------------
  const readerCtx = await browser.newContext();
  const readerPage = await readerCtx.newPage();
  try {
    await signUpAndVerify(readerPage, readerPage.request);
    await chooseUsername(readerPage, uniqueHandle("reader"));

    await readerPage.goto(url);
    // The island replaced the SSR login-link with a real form.
    const form = readerPage.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill("A comment with `code` in it.");
    await form.locator("button[type=submit]").click();
    // reload happened; the SSR'd comment renders THROUGH the markdown pipeline.
    await expect(readerPage.locator(".comment-body code")).toHaveText("code");

    // ---- Reply (nested) ----------------------------------------------------
    const commentLi = readerPage.locator("[data-comment-id]").first();
    await commentLi.locator("button", { hasText: "Reply" }).click();
    const replyForm = commentLi.locator("[data-comment-actions] form");
    await replyForm.locator("textarea").fill("Replying to myself.");
    await replyForm.locator("button[type=submit]").click();
    await expect(readerPage.locator('[data-depth="1"]')).toContainText("Replying to myself.");

    // ---- Edit own reply ----------------------------------------------------
    const replyLi = readerPage.locator('[data-depth="1"]');
    await replyLi.locator("button", { hasText: "Edit" }).click();
    const editForm = replyLi.locator("[data-comment-actions] form");
    await expect(editForm.locator("textarea")).toHaveValue("Replying to myself.");
    await editForm.locator("textarea").fill("Edited reply.");
    await editForm.locator("button[type=submit]").click();
    await expect(readerPage.locator('[data-depth="1"]')).toContainText("Edited reply.");
    await expect(readerPage.locator('[data-depth="1"] .edited')).toBeVisible();

    // ---- React to the post -------------------------------------------------
    const postChips = readerPage.locator('[data-reactions][data-target-post]');
    const insightful = postChips.locator('button[data-kind="insightful"]');
    await expect(insightful).toBeEnabled(); // island hydrated
    await insightful.click();
    await expect(insightful).toHaveAttribute("aria-pressed", "true");
    await expect(insightful.locator("[data-count]")).toHaveText("1");
    // Survives a reload (server state, not client optimism).
    await readerPage.reload();
    await expect(
      readerPage
        .locator('[data-reactions][data-target-post] button[data-kind="insightful"]')
        .locator("[data-count]"),
    ).toHaveText("1");

    // ---- Anonymous reader sees the comments --------------------------------
    const anonCtx = await browser.newContext();
    try {
      const anonPage = await anonCtx.newPage();
      await anonPage.goto(url);
      await expect(anonPage.locator(".comment-body").first()).toContainText("A comment with");
      // Anonymous: form slot still shows the SSR login affordance.
      await expect(anonPage.locator("[data-comment-form-slot]")).toContainText("Log in");
    } finally {
      await anonCtx.close();
    }

    // ---- Author A moderates: deletes B's top-level comment on A's post -----
    await page.goto(url);
    const target = page.locator("[data-comment-id]").first();
    await target.locator("button", { hasText: "Delete" }).click();
    await expect(page.locator(".tombstone").first()).toHaveText("[deleted]");
    // The reply SURVIVES under the tombstone.
    await expect(page.locator('[data-depth="1"]')).toContainText("Edited reply.");
  } finally {
    await readerCtx.close();
  }
});

test("a verified but UN-ONBOARDED user gets the choose-handle affordance, not a form", async ({
  page,
  browser,
}) => {
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, { title: "Gate Probe", markdownSource: "body" });

  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await signUpAndVerify(p, p.request); // verified, NO chooseUsername
    await p.goto(url);
    const slot = p.locator("[data-comment-form-slot]");
    await expect(slot.locator("a", { hasText: "Choose your handle" })).toBeVisible();
    await expect(slot.locator("form")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 2: Run.** `docker compose up -d db` then `pnpm --filter @thinkersjournal/api run migrate` (dev DB needs 0004!) then `pnpm run test:e2e`. Expected: 15/15 (13 baseline + 2 new). Run TWICE clean (the M2.1 flake bar).
- [ ] **Step 3: Reconcile any baseline-spec fallout** the way Task 16 of web-theming did (scope selectors, never weaken assertions) — none is expected: this milestone adds below `</article>` and touches no nav/footer/profile surface.
- [ ] **Step 4: Commit.**
```bash
git add e2e/engagement.spec.ts
git commit -m "test(m2.2): e2e engagement spine — comment/reply/edit/react/moderate + onboarding gate"
```

---

## Milestone-end (controller, not a task)

Green sweep: `pnpm typecheck` · `pnpm -r test` (against a fresh `pnpm --filter @thinkersjournal/web build`) · `pnpm run check:workerd` · `pnpm run test:e2e` ×2 · docker healthy. Then the whole-branch adversarial review per the SDD methodology (lenses: cache-leak, draft-leak, XSS-sink inventory, purge-quota, gate-bypass, keyset correctness), fix wave, CI-gated PR.

## Self-review notes (already applied)

- **Spec coverage:** §4 → Task 1; §5 rows map: POST/PATCH/DELETE comments → 3/4, reactions writes → 6, three reads → 5/7; §6 → 9–12 (+8 for `/api/me`); §7 woven through (gate matrices, parity cases, sink inventory, purge pins); §8's list → the per-task tests + Task 13. Spec's "verified-email + username_chosen on ALL writes" relaxed for by-construction-onboarded paths — documented deviation 1.
- **Type consistency:** island reads `data-author-id` ↔ page writes `c.author.userId`; proxy merge shape ↔ island `ReactionsResponse`; `CommentsPage.nextCursor` is a `path`, consumed only as an opaque cursor; `Me.userId` flows Task 8 → 11.
- **Placeholder scan:** clean — every step carries code or an exact command.


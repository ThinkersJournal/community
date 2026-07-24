# M2.3a — Notification core (poll-delivered) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app notifications for comments, replies, reactions, and follows — a `notifications` source-of-record table with idempotent writes, a single `notify()` seam wired into the existing engagement handlers, a read/unread/mark-read API, a nav bell island, and a `/notifications` page. Poll-delivered; zero new infrastructure. Per the approved spec `docs/superpowers/specs/2026-07-23-m2-3a-notification-core-design.md`.

**Architecture:** api gains a `notifications` table (migration 0005) and one write function `notify(client, event)` called from `handleCreateComment` / `handleAddReaction` / `handleFollow` after each primary write commits, on the same connection; three read routes; web gets three `markPrivate` proxies, a bell island in the nav, a shared read-time collapsing helper, and a `/notifications` page mirroring `/feed`.

**Tech Stack:** existing only — TS 6.0.3, zod, pg over Hyperdrive, Astro 7 + `@astrojs/cloudflare`, Playwright. No new dependencies, no new bindings, no Queue, no DO, no WebSocket.

**Branch:** `m2-3a-notification-core` off `main`.

## Global Constraints

- Baseline that must never regress (main @ `3b8f0b6` + spec commit `f11e3ab`): typecheck 0 · shared 34 · markdown 93 · api 550 · web 509/6skip · `check:workerd` clean · e2e 15/15. Docker Postgres must be up (`docker compose up -d db`).
- **Vitest split (api):** workerd pool = `test/**/*.test.ts` EXCLUDING `*.db.test.ts` / `*.node.test.ts`; node project = those suffixes (direct pg). A test needing a Cloudflare binding must NOT use those suffixes.
- `withClient(hd, ctx, fn)` is 3-arg; `pg.Client`, never Pool. `HYPERDRIVE_FRESH` for everything in this milestone. `HYPERDRIVE_CACHED` stays EXACTLY ONE live use (`handlePublicRecent`) — the hyperdrive-binding-inventory guard fails on a second.
- **Route table rule:** every new route goes in `apps/api/src/routes.ts`'s `ROUTES`; route-protection holds mutating routes to default-deny automatically; every new GET route needs an explicit `CASES` entry in `apps/api/test/error-envelope.test.ts`. Errors are ALWAYS `errorResponse(code, status)` — never a bare Response.
- **`notify()` never throws.** Its own `try/catch` swallows+logs any failure, exactly like `purgeTags` — a notification problem must never fail or roll back the engagement write that triggered it. It is called AFTER the primary write, on the same `client`.
- **Cache discipline (web):** Cookie is NOT in the Workers Cache key. The nav renders on **edge-cached** pages, so the unread badge is **island-fetched `no-store`, never SSR'd** — the exact nav-auth rule. Every `src/pages` file calls exactly ONE cache helper (page-cache-inventory SWEEP A auto-enumerates new files). Islands build DOM via `createElement`/`textContent` ONLY.
- **Island rule:** bundled `<script>import { fn } from "<rel>/scripts/<mod>"; fn()</script>` — never inline logic (CSP `script-src 'self'`; `assetsInlineLimit: 0` forces externalization). Use `appendChild` not `append`, block-body arrows if wrangler's ambient `Element` types fight (see `nav-auth.ts:46-50`).
- **Web redirect rule:** never `Astro.redirect` on a path that may carry cookies — manual 302 + `applyCookies` (the `/feed` idiom; tripwires exist).
- **Web test style:** source/structure tests (`readFileSync` + `stripComments` + regex) + built-manifest greps (`it.skipIf(!existsSync("dist/server/entry.mjs"))`); no in-vitest render. Every negative assertion preceded by a positive one (anti-vacuity).
- **IDOR is the load-bearing security property:** every notification read and the mark-read write must scope to `recipient_id = session.userId` INSIDE the SQL. Never trust a client-supplied recipient.
- Notification kinds are exactly `post_comment | comment_reply | post_reaction | comment_reaction | follow`, everywhere (DB CHECK, zod/TS union, copy).

**Documented deviations from the spec letter** (justify-once, carry through):
1. `POST /notifications/read` runs the mutating pipeline WITHOUT `requireVerifiedEmail` — an unverified user must still clear their own bell (precedent: logout, resend-verification).
2. The bell island detects logged-in state via the `/api/notifications-count` response itself (200 → show bell; 401 → stay hidden), rather than an extra `/api/me` call — one fewer hop.

---

## File Structure

**Create**
- `apps/api/migrations/0005_notifications.sql`
- `apps/api/src/notifications/create.ts` — the `notify()` seam
- `apps/api/src/routes/notifications.ts` — the three read/mark handlers
- `apps/api/test/notifications-schema.db.test.ts`, `test/notify-seam.node.test.ts`, `test/notifications.test.ts`
- `packages/shared/src/notifications.ts` — DTOs, kind union, `collapseNotifications()`
- `packages/shared/test/notifications.test.ts`
- `apps/web/src/pages/api/{notifications,notifications-count,notifications-read}.ts` — proxies
- `apps/web/src/pages/notifications.astro` — the full page
- `apps/web/src/scripts/notify-bell.ts` — the bell island
- `apps/web/test/{notify-proxies,notifications-page,notify-bell}.test.ts`
- `e2e/notifications.spec.ts`

**Modify**
- `apps/api/src/routes/comments.ts` (notify wiring + recipient SELECTs), `src/routes/reactions.ts` (notify wiring + recipient SELECTs), `src/routes/follows.ts` (notify wiring), `src/routes.ts` (+3 routes)
- `apps/api/test/{comments,reactions,follows}.test.ts` (notify assertions), `test/error-envelope.test.ts` (+2 GET CASES)
- `packages/shared/src/index.ts` (export notifications)
- `apps/web/src/components/Nav.astro` (bell placeholder + mount)
- `apps/web/test/nav.test.ts` (bell placeholder assertion)

---

### Task 1: Migration 0005 — notifications table

**Files:**
- Create: `apps/api/migrations/0005_notifications.sql`, `apps/api/test/notifications-schema.db.test.ts`

**Interfaces:**
- Consumes: `users`, `posts`, `comments` (0001/0002/0004); `uuidv7()`.
- Produces: the `notifications` table + named constraints `notifications_no_self`, `notifications_event_unique`, and indexes `notifications_recipient_id_desc_idx`, `notifications_unread_idx` — every later task depends on these names.

- [ ] **Step 1: Write the failing schema test.** `apps/api/test/notifications-schema.db.test.ts` (node project — direct pg, mirrors `engagement-schema.db.test.ts`):

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let alice: string;
let bob: string;
let postId: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`notif-${crypto.randomUUID()}@example.com`],
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
function insertNotif(cols: Record<string, unknown>): Promise<unknown> {
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 1}`);
  return client.query(
    `INSERT INTO notifications (${keys.join(",")}) VALUES (${vals.join(",")})`,
    Object.values(cols),
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  alice = await makeUser();
  bob = await makeUser();
  postId = await makePost(alice);
});
afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
  await client.end();
});

describe("notifications schema", () => {
  it("assigns a uuidv7 id and defaults read_at null", async () => {
    const { rows } = await client.query<{ id: string; read_at: string | null }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind, post_id, comment_id)
       VALUES ($1,$2,'post_comment',$3,NULL) RETURNING id, read_at`,
      [alice, bob, postId],
    );
    expect(rows[0]!.id[14]).toBe("7");
    expect(rows[0]!.read_at).toBeNull();
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("rejects a self-notification (CHECK 23514)", async () => {
    await expect(
      insertNotif({ recipient_id: alice, actor_id: alice, kind: "follow" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unknown kind (CHECK 23514)", async () => {
    await expect(
      insertNotif({ recipient_id: alice, actor_id: bob, kind: "mention" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("dedupes on the natural key incl. NULLs (unique 23505)", async () => {
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "follow" });
    // A second identical event — NULL post/comment/reaction — must collide, which
    // requires NULLS NOT DISTINCT; without it every NULL-bearing row is distinct.
    await expect(
      insertNotif({ recipient_id: alice, actor_id: bob, kind: "follow" }),
    ).rejects.toMatchObject({ code: "23505" });
    // A different reaction_kind on the same post IS a distinct event.
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "post_reaction", post_id: postId, reaction_kind: "insightful" });
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "post_reaction", post_id: postId, reaction_kind: "agree" });
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("cascade-deletes when the recipient, actor, or post is removed", async () => {
    const tmpPost = await makePost(alice);
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "post_comment", post_id: tmpPost });
    await client.query("DELETE FROM posts WHERE id=$1", [tmpPost]);
    const { rows } = await client.query("SELECT 1 FROM notifications WHERE post_id=$1", [tmpPost]);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @thinkersjournal/api test notifications-schema` — `relation "notifications" does not exist`.

- [ ] **Step 3: Write the migration.** `apps/api/migrations/0005_notifications.sql`:

```sql
-- Up Migration

-- IN-APP NOTIFICATIONS — the source of record (architecture §9). One row per
-- event; collapsing is a read-time display concern (no aggregate rows here).
-- The unique natural key makes writes idempotent AND anti-spam: each
-- (recipient, actor, kind, target, tone) notifies at most once ever, so a
-- react/unreact or follow/unfollow loop cannot spam a bell, and an at-least-once
-- delivery path (M2.3b) can retry safely.
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient_id  uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  actor_id      uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN
                  ('post_comment','comment_reply','post_reaction','comment_reaction','follow')),
  post_id       uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id    uuid REFERENCES comments(id) ON DELETE CASCADE,
  -- Display metadata copied from reactions.kind (which owns the tone CHECK); not
  -- re-constrained here to avoid a second place to edit when a tone is added.
  reaction_kind text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CONSTRAINT notifications_no_self CHECK (recipient_id <> actor_id),
  CONSTRAINT notifications_event_unique
    UNIQUE NULLS NOT DISTINCT (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind)
);

-- The keyset list: "my notifications, newest first".
CREATE INDEX notifications_recipient_id_desc_idx ON notifications (recipient_id, id DESC);
-- The polled badge: partial index keeps unread COUNT(*) cheap.
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS notifications;
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test notifications-schema migrations`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/migrations/0005_notifications.sql apps/api/test/notifications-schema.db.test.ts
git commit -m "feat(m2.3a): migration 0005 — notifications table (idempotent natural key)"
```

---

### Task 2: Shared notification DTOs + the collapsing helper

**Files:**
- Create: `packages/shared/src/notifications.ts`, `packages/shared/test/notifications.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces (imported everywhere later): `NOTIFICATION_KINDS`, `NotificationKind`, `NotificationItem`, `NotificationsPage`, `MarkReadInput`, `CollapsedNotification`, `collapseNotifications(items): CollapsedNotification[]`.

- [ ] **Step 1: Write the failing test.** `packages/shared/test/notifications.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { collapseNotifications, MarkReadInput, NOTIFICATION_KINDS } from "../src";
import type { NotificationItem } from "../src";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: crypto.randomUUID(), kind: "post_reaction",
    actor: { username: "u", displayName: null },
    postId: "p1", postTitle: "T", postSlug: "t", commentId: null,
    reactionKind: "insightful", createdAt: "2026-07-24T00:00:00Z", read: false,
    ...over,
  };
}

describe("NOTIFICATION_KINDS", () => {
  it("is the exact five-kind set", () => {
    expect(NOTIFICATION_KINDS).toEqual([
      "post_comment", "comment_reply", "post_reaction", "comment_reaction", "follow",
    ]);
  });
});

describe("MarkReadInput", () => {
  it("accepts {all:true} or a non-empty ids array, rejects both/neither", () => {
    expect(MarkReadInput.safeParse({ all: true }).success).toBe(true);
    expect(MarkReadInput.safeParse({ ids: [crypto.randomUUID()] }).success).toBe(true);
    expect(MarkReadInput.safeParse({}).success).toBe(false);
    expect(MarkReadInput.safeParse({ all: true, ids: [crypto.randomUUID()] }).success).toBe(false);
    expect(MarkReadInput.safeParse({ ids: [] }).success).toBe(false);
    expect(MarkReadInput.safeParse({ ids: ["nope"] }).success).toBe(false);
  });
});

describe("collapseNotifications", () => {
  it("groups same (kind, target) across actors and counts DISTINCT actors", () => {
    const rows = [
      item({ actor: { username: "a", displayName: null } }),
      item({ actor: { username: "b", displayName: null } }),
      item({ actor: { username: "c", displayName: null } }),
    ];
    const [g] = collapseNotifications(rows);
    expect(g!.actorCount).toBe(3);
    expect(g!.leadActor.username).toBe("a"); // first occurrence leads
    expect(g!.reactionKind).toBeNull(); // tone dropped once collapsed
  });

  it("keeps the tone only for a singleton, and counts one actor's multiple tones as ONE", () => {
    const single = collapseNotifications([item({ reactionKind: "agree" })]);
    expect(single[0]!.actorCount).toBe(1);
    expect(single[0]!.reactionKind).toBe("agree");
    // one actor, two tones on the same post → one display group, actorCount 1
    const multi = collapseNotifications([
      item({ actor: { username: "a", displayName: null }, reactionKind: "insightful" }),
      item({ actor: { username: "a", displayName: null }, reactionKind: "agree" }),
    ]);
    expect(multi).toHaveLength(1);
    expect(multi[0]!.actorCount).toBe(1);
    expect(multi[0]!.reactionKind).toBeNull(); // >1 row → tone dropped
  });

  it("does NOT merge different targets or different kinds", () => {
    const rows = [
      item({ postId: "p1" }), item({ postId: "p2" }),
      item({ kind: "post_comment", reactionKind: null }),
    ];
    expect(collapseNotifications(rows)).toHaveLength(3);
  });

  it("carries read=false if ANY row in the group is unread", () => {
    const g = collapseNotifications([
      item({ read: true, actor: { username: "a", displayName: null } }),
      item({ read: false, actor: { username: "b", displayName: null } }),
    ]);
    expect(g[0]!.read).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.** `packages/shared/src/notifications.ts`:

```ts
/**
 * NOTIFICATION WIRE TYPES (M2.3a) + the read-time collapsing helper, shared by
 * both Workers. `NotificationItem`/`NotificationsPage` are viewer-scoped (the
 * recipient's own rows) and never edge-cached.
 */
import { z } from "zod";

export const NOTIFICATION_KINDS = [
  "post_comment", "comment_reply", "post_reaction", "comment_reaction", "follow",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationActor {
  username: string;
  displayName: string | null;
}

/** One enriched notification row as served to its recipient. */
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actor: NotificationActor;
  postId: string | null;
  postTitle: string | null;
  postSlug: string | null;
  commentId: string | null;
  reactionKind: string | null;
  createdAt: string;
  read: boolean;
}

/** `GET /notifications` — keyset page of the viewer's notifications. */
export interface NotificationsPage {
  notifications: NotificationItem[];
  nextCursor: string | null;
}

/** `POST /notifications/read` — mark a set read, or all. Exactly one branch. */
export const MarkReadInput = z
  .object({
    ids: z.array(z.string().uuid()).min(1).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.all === true) !== (b.ids !== undefined), {
    message: "exactly one of ids / all",
  });
export type MarkReadValue = z.infer<typeof MarkReadInput>;

/** A collapsed display group. `actorCount` counts DISTINCT actors. */
export interface CollapsedNotification {
  key: string;
  kind: NotificationKind;
  leadActor: NotificationActor;
  actorCount: number;
  postId: string | null;
  postTitle: string | null;
  postSlug: string | null;
  commentId: string | null;
  /** The tone — present ONLY for a singleton group (one row). */
  reactionKind: string | null;
  createdAt: string; // the newest (first) row's timestamp
  ids: string[]; // every underlying row id (for mark-read of the group)
  read: boolean; // false if ANY underlying row is unread
}

/**
 * Group a page's rows by (kind, postId, commentId), preserving first-occurrence
 * order, counting DISTINCT actors. A pure function over the page — no query.
 * Tone survives only for a singleton (see the spec's double-count note).
 */
export function collapseNotifications(items: NotificationItem[]): CollapsedNotification[] {
  const groups = new Map<string, CollapsedNotification & { actors: Set<string> }>();
  const order: string[] = [];
  for (const it of items) {
    const key = `${it.kind}|${it.postId ?? ""}|${it.commentId ?? ""}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key, kind: it.kind, leadActor: it.actor, actorCount: 0,
        postId: it.postId, postTitle: it.postTitle, postSlug: it.postSlug,
        commentId: it.commentId, reactionKind: it.reactionKind,
        createdAt: it.createdAt, ids: [], read: true, actors: new Set<string>(),
      };
      groups.set(key, g);
      order.push(key);
    }
    g.ids.push(it.id);
    g.actors.add(it.actor.username);
    if (!it.read) g.read = false;
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    const actorCount = g.actors.size;
    return {
      key: g.key, kind: g.kind, leadActor: g.leadActor, actorCount,
      postId: g.postId, postTitle: g.postTitle, postSlug: g.postSlug,
      commentId: g.commentId,
      reactionKind: g.ids.length === 1 ? g.reactionKind : null,
      createdAt: g.createdAt, ids: g.ids, read: g.read,
    };
  });
}
```

Add `export * from "./notifications";` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/shared test` (all) + `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/notifications.ts packages/shared/src/index.ts packages/shared/test/notifications.test.ts
git commit -m "feat(m2.3a): shared notification DTOs + read-time collapsing helper"
```

---

### Task 3: The `notify()` write seam

**Files:**
- Create: `apps/api/src/notifications/create.ts`, `apps/api/test/notify-seam.node.test.ts`

**Interfaces:**
- Consumes: `NotificationKind` (Task 2), a minimal client `{ query(sql, params): Promise<unknown> }` (so a stub can prove never-throws).
- Produces: `notify(client, event): Promise<void>` where `event = { recipientId, actorId, kind, postId?, commentId?, reactionKind? }`. Self-suppresses (`recipientId === actorId` → no-op), inserts `ON CONFLICT … DO NOTHING`, and **never throws**.

- [ ] **Step 1: Write the failing test.** `apps/api/test/notify-seam.node.test.ts` (node project — uses direct pg AND a stub client):

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notify } from "../src/notifications/create";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

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
    await notify(client, { recipientId: alice, actorId: bob, kind: "follow" });
    expect(await count(alice)).toBe(1);
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("self-suppresses (recipient === actor) with no insert", async () => {
    await notify(client, { recipientId: alice, actorId: alice, kind: "follow" });
    expect(await count(alice)).toBe(0);
  });

  it("is idempotent — a duplicate event does not add a second row", async () => {
    const ev = { recipientId: alice, actorId: bob, kind: "follow" as const };
    await notify(client, ev);
    await notify(client, ev);
    expect(await count(alice)).toBe(1);
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("NEVER throws — a failing client is swallowed", async () => {
    const boom = { query: async () => { throw new Error("db down"); } };
    await expect(
      notify(boom as never, { recipientId: alice, actorId: bob, kind: "follow" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.** `apps/api/src/notifications/create.ts`:

```ts
/**
 * THE NOTIFICATION WRITE SEAM (M2.3a). The ONLY place a notification row is
 * born — the hook M2.3b's realtime push will attach to. Called AFTER the
 * triggering write commits, on the SAME client (one connection, autocommit).
 *
 * ⚠️ NEVER THROWS — same rule as cache/purge.ts: a notification failure must not
 * fail or roll back the comment/reaction/follow that triggered it. Self-events
 * are suppressed here and forbidden by the DB CHECK (defense in depth).
 */
import type { NotificationKind } from "@thinkersjournal/shared";

interface NotifyClient {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

export interface NotifyEvent {
  recipientId: string;
  actorId: string;
  kind: NotificationKind;
  postId?: string;
  commentId?: string;
  reactionKind?: string;
}

export async function notify(client: NotifyClient, ev: NotifyEvent): Promise<void> {
  if (ev.recipientId === ev.actorId) return; // no self-notification
  try {
    await client.query(
      `INSERT INTO notifications
         (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT notifications_event_unique DO NOTHING`,
      [ev.recipientId, ev.actorId, ev.kind, ev.postId ?? null, ev.commentId ?? null, ev.reactionKind ?? null],
    );
  } catch (err) {
    console.error("notify failed", { kind: ev.kind, err });
  }
}
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test notify-seam`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/notifications/create.ts apps/api/test/notify-seam.node.test.ts
git commit -m "feat(m2.3a): notify() write seam — self-suppress, idempotent, never-throws"
```

---

### Task 4: Wire notify into comments (post_comment + comment_reply)

**Files:**
- Modify: `apps/api/src/routes/comments.ts`, `apps/api/test/comments.test.ts`

**Interfaces:**
- Consumes: `notify()` (Task 3), the existing `handleCreateComment`.
- Produces: after a top-level comment commits, a `post_comment` notification to the post's author; after a reply commits, a `comment_reply` notification to the **parent comment's** author. Both with `commentId` = the new comment's id. No behavior change to the comment write itself.

- [ ] **Step 1: Write failing tests** (append to `apps/api/test/comments.test.ts`; a fresh actor pair to stay within COMMENT_LIMITER budget — see the M2.2 ledger note). Add a helper to read notifications directly:

```ts
import { notify } from "../src/notifications/create"; // not used directly; ensures build coupling
// … within the file, add:

async function notifsFor(recipientId: string): Promise<Array<{ kind: string; actorId: string; commentId: string | null }>> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ kind: string; actor_id: string; comment_id: string | null }>(
      "SELECT kind, actor_id, comment_id FROM notifications WHERE recipient_id=$1 ORDER BY id",
      [recipientId],
    );
    return rows;
  });
  await waitOnExecutionContext(ctx);
  return rows.map((r) => ({ kind: r.kind, actorId: r.actor_id, commentId: r.comment_id }));
}

describe("comment notifications (M2.3a)", () => {
  it("a top-level comment notifies the POST author with the new comment id", async () => {
    const poster = await onboardedActor();
    const commenter = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const r = await createComment(commenter, { postId: p, markdownSource: "hi" });
    const newId = ((await r.json()) as { id: string }).id;
    expect(await notifsFor(poster.userId)).toEqual([
      { kind: "post_comment", actorId: commenter.userId, commentId: newId },
    ]);
  });

  it("a self-comment on your own post notifies no one", async () => {
    const poster = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    await createComment(poster, { postId: p, markdownSource: "mine" });
    expect(await notifsFor(poster.userId)).toEqual([]);
  });

  it("a reply notifies the PARENT commenter (not the post author), with the reply id", async () => {
    const poster = await onboardedActor();
    const parentAuthor = await onboardedActor();
    const replier = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const top = await createComment(parentAuthor, { postId: p, markdownSource: "top" });
    const parentId = ((await top.json()) as { id: string }).id;
    const reply = await createComment(replier, { postId: p, parentId, markdownSource: "re" });
    const replyId = ((await reply.json()) as { id: string }).id;
    // parentAuthor gets the reply notification…
    expect(await notifsFor(parentAuthor.userId)).toEqual([
      { kind: "comment_reply", actorId: replier.userId, commentId: replyId },
    ]);
    // …and the post author gets ONLY the top-level comment, not the deep reply.
    expect(await notifsFor(poster.userId)).toEqual([
      { kind: "post_comment", actorId: parentAuthor.userId, commentId: parentId },
    ]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (no notifications table rows created yet). `pnpm --filter @thinkersjournal/api test comments`

- [ ] **Step 3: Implement.** In `apps/api/src/routes/comments.ts`, add `import { notify } from "../notifications/create";`. Extend the two SELECTs and add the notify call inside the `withClient` block, after the comment INSERT, before `return { id }`:

```ts
      // top-level: recipient = post author; reply: recipient = parent author.
      const post = await c.query<{ status: string; authorId: string }>(
        `SELECT status, author_id AS "authorId" FROM posts WHERE id = $1`,
        [postId],
      );
      if (post.rows[0]?.status !== "published") {
        return { error: errorResponse("NOT_FOUND", 404) };
      }
      const postAuthorId = post.rows[0].authorId;

      let parentPath: string | null = null;
      let depth = 0;
      let parentAuthorId: string | null = null;
      if (parentId !== undefined) {
        const parent = await c.query<{ path: string; depth: number; deleted: boolean; authorId: string }>(
          `SELECT path, depth, (deleted_at IS NOT NULL) AS deleted, author_id AS "authorId"
             FROM comments WHERE id = $1 AND post_id = $2`,
          [parentId, postId],
        );
        const row = parent.rows[0];
        if (row === undefined) return { error: errorResponse("COMMENT_NOT_FOUND", 404) };
        if (row.deleted) return { error: errorResponse("COMMENT_DELETED", 409) };
        if (row.depth >= MAX_DEPTH) return { error: errorResponse("COMMENT_DEPTH_EXCEEDED", 409) };
        parentPath = row.path;
        depth = row.depth + 1;
        parentAuthorId = row.authorId;
      }

      const { rows } = await c.query<{ id: string }>(
        /* … unchanged INSERT … */
      );
      const newId = rows[0]!.id;

      // Notify AFTER the comment is committed, on the same connection. Reply →
      // parent commenter; top-level → post author. notify() self-suppresses and
      // never throws, so this cannot affect the 201 the commenter gets.
      if (parentId !== undefined && parentAuthorId !== null) {
        await notify(c, { recipientId: parentAuthorId, actorId: userId, kind: "comment_reply", postId, commentId: newId });
      } else {
        await notify(c, { recipientId: postAuthorId, actorId: userId, kind: "post_comment", postId, commentId: newId });
      }
      return { id: newId };
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test comments purge-wiring` (purge-wiring must stay green — the notify insert is on the same connection but changes nothing the purge tests observe).

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/comments.ts apps/api/test/comments.test.ts
git commit -m "feat(m2.3a): comment/reply notifications wired into handleCreateComment"
```

---

### Task 5: Wire notify into reactions (post_reaction + comment_reaction)

**Files:**
- Modify: `apps/api/src/routes/reactions.ts`, `apps/api/test/reactions.test.ts`

**Interfaces:**
- Consumes: `notify()`, the existing `handleAddReaction`.
- Produces: after a post reaction, a `post_reaction` notification to the post author (`reactionKind` set); after a comment reaction, a `comment_reaction` to the comment author (`postId` + `commentId` + `reactionKind`). Re-reacting the same tone creates no second notification (dedup); a different tone does.

- [ ] **Step 1: Write failing tests** (append to `apps/api/test/reactions.test.ts`; reuse the file's helpers, add a `notifsFor` reader like Task 4's):

```ts
describe("reaction notifications (M2.3a)", () => {
  it("a post reaction notifies the post author with the tone; re-reacting same tone does not duplicate", async () => {
    const posterActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    await react(reader, { postId: p, kind: "insightful" });
    await react(reader, { postId: p, kind: "insightful" }); // idempotent
    const n = await notifsFor(posterActor.userId);
    expect(n).toEqual([{ kind: "post_reaction", actorId: reader.userId, reactionKind: "insightful" }]);
    // a different tone from the same actor IS a new notification
    await react(reader, { postId: p, kind: "agree" });
    expect((await notifsFor(posterActor.userId)).length).toBe(2);
  });

  it("a comment reaction notifies the comment author", async () => {
    const commentAuthor = await onboardedActor();
    const p = await insertPost(commentAuthor.userId, "published");
    const c = await insertComment(p, commentAuthor.userId);
    await react(reader, { commentId: c.id, kind: "curious" });
    expect(await notifsFor(commentAuthor.userId)).toEqual([
      { kind: "comment_reaction", actorId: reader.userId, reactionKind: "curious" },
    ]);
  });

  it("reacting to your OWN post/comment notifies no one", async () => {
    const p = await insertPost(reader.userId, "published");
    await react(reader, { postId: p, kind: "agree" });
    expect(await notifsFor(reader.userId)).toEqual([]);
  });
});
```

(`notifsFor` here selects `kind, actor_id, reaction_kind`.)

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.** In `apps/api/src/routes/reactions.ts`, add `import { notify } from "../notifications/create";`, extend the target SELECTs to fetch the author, and call notify after the reaction INSERT inside the `withClient` block:

```ts
      let recipientId: string | null = null;
      let notifPostId: string | undefined;
      let notifCommentId: string | undefined;
      if (postId !== undefined) {
        const post = await c.query<{ status: string; authorId: string }>(
          `SELECT status, author_id AS "authorId" FROM posts WHERE id = $1`, [postId],
        );
        if (post.rows[0]?.status !== "published") return errorResponse("NOT_FOUND", 404);
        recipientId = post.rows[0].authorId; notifPostId = postId;
      } else {
        const comment = await c.query<{ deleted: boolean; authorId: string; postId: string }>(
          `SELECT (c.deleted_at IS NOT NULL) AS deleted, c.author_id AS "authorId", c.post_id AS "postId"
             FROM comments c JOIN posts p ON p.id = c.post_id AND p.status = 'published'
            WHERE c.id = $1`, [commentId],
        );
        const row = comment.rows[0];
        if (row === undefined) return errorResponse("COMMENT_NOT_FOUND", 404);
        if (row.deleted) return errorResponse("COMMENT_DELETED", 409);
        recipientId = row.authorId; notifPostId = row.postId; notifCommentId = commentId;
      }

      await c.query(/* … unchanged reactions INSERT … */);

      // Notify the target's author. Dedup on the notification natural key means a
      // repeat same-tone reaction adds nothing; a different tone is a new event.
      if (recipientId !== null) {
        await notify(c, {
          recipientId, actorId: userId,
          kind: postId !== undefined ? "post_reaction" : "comment_reaction",
          postId: notifPostId, commentId: notifCommentId, reactionKind: kind,
        });
      }
      return null;
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test reactions purge-wiring`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/reactions.ts apps/api/test/reactions.test.ts
git commit -m "feat(m2.3a): post/comment reaction notifications wired into handleAddReaction"
```

---

### Task 6: Wire notify into follows (follow)

**Files:**
- Modify: `apps/api/src/routes/follows.ts`, `apps/api/test/follows.test.ts`

**Interfaces:**
- Consumes: `notify()`, the existing `handleFollow`.
- Produces: after a follow edge commits, a `follow` notification to the followee. Re-follow after unfollow does not re-notify (dedup). Self-follow already blocked upstream.

- [ ] **Step 1: Write failing tests** (append to `apps/api/test/follows.test.ts`, with a `notifsFor` reading `kind, actor_id`):

```ts
describe("follow notifications (M2.3a)", () => {
  it("following notifies the followee once, and re-follow after unfollow does not duplicate", async () => {
    const follower = await onboardedActor();
    const followee = await onboardedActor();
    await follow(follower, followee.userId);
    await unfollow(follower, followee.userId);
    await follow(follower, followee.userId); // re-follow
    expect(await notifsFor(followee.userId)).toEqual([
      { kind: "follow", actorId: follower.userId },
    ]);
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.** In `apps/api/src/routes/follows.ts` add `import { notify } from "../notifications/create";` and call notify inside the follow `withClient` block after the `INSERT … ON CONFLICT`:

```ts
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      await c.query(
        `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
           ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [userId, followeeId],
      );
      // Notify the followee. Dedup means a follow/unfollow/re-follow loop cannot
      // spam their bell (anti-harassment). self-follow is already rejected above.
      await notify(c, { recipientId: followeeId, actorId: userId, kind: "follow" });
    });
```

(The existing `handleFollow` wraps this in a try/catch for FK/CHECK violations — keep that; notify is inside the same block and never throws.)

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test follows`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/follows.ts apps/api/test/follows.test.ts
git commit -m "feat(m2.3a): follow notifications wired into handleFollow"
```

### Task 7: Read API — list, unread-count, mark-read

**Files:**
- Create: `apps/api/src/routes/notifications.ts`, `apps/api/test/notifications.test.ts`
- Modify: `apps/api/src/routes.ts`, `apps/api/test/error-envelope.test.ts`

**Interfaces:**
- Consumes: `NotificationsPage`, `NotificationItem`, `MarkReadInput` (Task 2), `readCurrentSession`, `runMutatingPipeline`, `withClient`, `errorResponse`.
- Produces: `handleListNotifications` (`GET /notifications?cursor=`), `handleUnreadCount` (`GET /notifications/unread-count`), `handleMarkRead` (`POST /notifications/read`). All scope to `recipient_id = session.userId` in the query. List page size 30, keyset `id DESC`. `no-store` on both GETs.

- [ ] **Step 1: Write the failing tests.** `apps/api/test/notifications.test.ts` (workerd pool; local helpers per house style). Key cases — keyset, count, mark-read (ids + all), and the **IDOR** test:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";
import type { Actor } from "./actor";
import type { NotificationsPage } from "@thinkersjournal/shared";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
async function onboardedActor(): Promise<Actor> {
  const a = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen=true WHERE user_id=$1", [a.userId]));
  await waitOnExecutionContext(ctx);
  return a;
}
/** Seed a follow-notification from actorId to recipientId, returns the row id. */
async function seedNotif(recipientId: string, actorId: string): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind) VALUES ($1,$2,'follow') RETURNING id`,
      [recipientId, actorId]);
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}
function listReq(actor: Actor, cursor?: string): Request {
  const q = cursor ? `?cursor=${cursor}` : "";
  return new Request(`https://api.test/notifications${q}`, { headers: { Cookie: actor.cookie } });
}
function countReq(actor: Actor): Request {
  return new Request("https://api.test/notifications/unread-count", { headers: { Cookie: actor.cookie } });
}
function markReq(actor: Actor, body: unknown): Request {
  return new Request("https://api.test/notifications/read", {
    method: "POST",
    headers: { Origin: "http://localhost:8787", Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let alice: Actor;
let bob: Actor;
beforeAll(async () => { alice = await onboardedActor(); bob = await onboardedActor(); });
afterAll(deleteCreatedUsers);

describe("GET /notifications", () => {
  it("lists the viewer's own rows newest-first, keyset-paginated", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) ids.push(await seedNotif(alice.userId, bob.userId + "")); // distinct actors below
    // (use distinct actor ids so the unique key does not collapse them)
  });

  it("401s LOGIN_REQUIRED with no session", async () => {
    const r = await fetchWorker(new Request("https://api.test/notifications"));
    expect(r.status).toBe(401);
  });
});

describe("GET /notifications/unread-count", () => {
  it("counts only the viewer's unread rows", async () => {
    const carol = await onboardedActor();
    await seedNotif(carol.userId, alice.userId);
    await seedNotif(carol.userId, bob.userId);
    const r = await fetchWorker(countReq(carol));
    expect(((await r.json()) as { count: number }).count).toBe(2);
  });
});

describe("POST /notifications/read", () => {
  it("marks specific ids read, then all", async () => {
    const dave = await onboardedActor();
    const id1 = await seedNotif(dave.userId, alice.userId);
    await seedNotif(dave.userId, bob.userId);
    expect((await (await fetchWorker(markReq(dave, { ids: [id1] }))).status)).toBe(200);
    expect(((await (await fetchWorker(countReq(dave))).json()) as { count: number }).count).toBe(1);
    await fetchWorker(markReq(dave, { all: true }));
    expect(((await (await fetchWorker(countReq(dave))).json()) as { count: number }).count).toBe(0);
  });

  it("400s when neither/both of ids/all are given", async () => {
    expect((await fetchWorker(markReq(alice, {}))).status).toBe(400);
    expect((await fetchWorker(markReq(alice, { all: true, ids: [crypto.randomUUID()] }))).status).toBe(400);
  });

  it("IDOR: B cannot read or mark-read A's notifications", async () => {
    const victim = await onboardedActor();
    const attacker = await onboardedActor();
    const victimNotif = await seedNotif(victim.userId, alice.userId);
    // read: attacker's list never contains the victim's row
    const list = (await (await fetchWorker(listReq(attacker))).json()) as NotificationsPage;
    expect(list.notifications.find((n) => n.id === victimNotif)).toBeUndefined();
    // mark-read: attacker marking the victim's id is a no-op — the victim still has it unread
    await fetchWorker(markReq(attacker, { ids: [victimNotif] }));
    const c = (await (await fetchWorker(countReq(victim))).json()) as { count: number };
    expect(c.count).toBe(1);
  });
});
```

(Fill in the keyset list test body to seed 31 rows from 31 **distinct** actor ids — create them via lightweight `INSERT INTO users` in a local helper, or reuse `seedNotif` with fresh actor rows — then assert page 1 = 30 newest, `nextCursor` set, page 2 = 1, disjoint+complete, and enrichment fields present. Keep each recipient's rows within one describe to avoid cross-test bleed.)

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.** `apps/api/src/routes/notifications.ts`:

```ts
/**
 * IN-APP NOTIFICATION READS (M2.3a). Every query scopes to
 * recipient_id = session.userId — that is the IDOR boundary and it lives in the
 * SQL, never in a client-supplied field. Viewer-scoped, no-store, never cached.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import { MarkReadInput, MAX_CURSOR } from "@thinkersjournal/shared";
import type { NotificationItem, NotificationsPage } from "@thinkersjournal/shared";

const PAGE_SIZE = 30;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface DbRow {
  id: string; kind: NotificationItem["kind"];
  username: string; displayName: string | null;
  postId: string | null; postTitle: string | null; postSlug: string | null;
  commentId: string | null; reactionKind: string | null;
  createdAt: string; read: boolean;
}

export async function handleListNotifications(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;
  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<DbRow>(
      `SELECT n.id, n.kind,
              ap.username, ap.display_name AS "displayName",
              n.post_id AS "postId", p.title AS "postTitle", p.slug AS "postSlug",
              n.comment_id AS "commentId", n.reaction_kind AS "reactionKind",
              n.created_at AS "createdAt", (n.read_at IS NOT NULL) AS read
         FROM notifications n
         JOIN profiles ap ON ap.user_id = n.actor_id
         LEFT JOIN posts p ON p.id = n.post_id
        WHERE n.recipient_id = $1 AND n.id < $2
        ORDER BY n.id DESC
        LIMIT ${PAGE_SIZE + 1}`,
      [session.userId, cursor]);
    const hasMore = rows.length > PAGE_SIZE;
    const slice = rows.slice(0, PAGE_SIZE);
    const notifications: NotificationItem[] = slice.map((r) => ({
      id: r.id, kind: r.kind, actor: { username: r.username, displayName: r.displayName },
      postId: r.postId, postTitle: r.postTitle, postSlug: r.postSlug,
      commentId: r.commentId, reactionKind: r.reactionKind, createdAt: r.createdAt, read: r.read,
    }));
    return { notifications, nextCursor: hasMore ? slice[slice.length - 1]!.id : null } satisfies NotificationsPage;
  });
  return json(page);
}

export async function handleUnreadCount(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;
  const count = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "SELECT count(*) n FROM notifications WHERE recipient_id=$1 AND read_at IS NULL", [session.userId]);
    return Number(rows[0]!.n);
  });
  return json({ count });
}

export async function handleMarkRead(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // No requireVerifiedEmail — an unverified user must still clear their own bell
  // (deviation 1; precedent: logout). Still full origin+CSRF+epoch.
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: false });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let body: unknown;
  try { body = await request.json(); } catch { return errorResponse("INVALID_JSON", 400); }
  const parsed = MarkReadInput.safeParse(body);
  if (!parsed.success) return errorResponse("INVALID_INPUT", 400, { fields: ["ids", "all"] });

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    parsed.data.all === true
      ? c.query("UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL", [userId])
      : c.query(
          "UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL AND id = ANY($2::uuid[])",
          [userId, parsed.data.ids]));
  return json({});
}
```

Register in `apps/api/src/routes.ts`:
```ts
  // In-app notifications (M2.3a). List + count are session-read GETs; read is a
  // mutating POST (no verified-email gate — clearing your own bell). All scope
  // to recipient_id = session.userId in-query (IDOR boundary).
  { method: "GET", pattern: "/notifications", handler: handleListNotifications },
  { method: "GET", pattern: "/notifications/unread-count", handler: handleUnreadCount },
  { method: "POST", pattern: "/notifications/read", handler: handleMarkRead },
```
⚠️ Register `/notifications/unread-count` BEFORE `/notifications` is not required (different full literals, first-match-wins on exact path), but keep the `unread-count` literal present — there is no `/notifications/:id` dynamic route to shadow it. Add the two GET `CASES` entries to `error-envelope.test.ts`:
```ts
  { name: "401 notifications list no session", route: "GET /notifications",
    build: () => new Request("https://api.test/notifications") },
  { name: "401 notifications unread-count no session", route: "GET /notifications/unread-count",
    build: () => new Request("https://api.test/notifications/unread-count") },
```

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/api test notifications error-envelope route-protection hyperdrive-binding-inventory` then the FULL api suite `pnpm --filter @thinkersjournal/api test` and `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/notifications.ts apps/api/src/routes.ts apps/api/test/notifications.test.ts apps/api/test/error-envelope.test.ts
git commit -m "feat(m2.3a): notification read API — list, unread-count, mark-read (IDOR-scoped)"
```

---

### Task 8: Web proxies — notifications

**Files:**
- Create: `apps/web/src/pages/api/notifications.ts`, `notifications-count.ts`, `notifications-read.ts`
- Test: `apps/web/test/notify-proxies.test.ts`

**Interfaces:**
- Consumes: `apiFetch`/`applyCookies`, `markPrivate`, Task 7's routes.
- Produces (island/page contracts): `GET /api/notifications?cursor=` (authed → api `GET /notifications`), `GET /api/notifications-count` (authed → api `GET /notifications/unread-count`), `POST /api/notifications-read` (authed → api `POST /notifications/read`). Each `markPrivate`, forwards cookie; the two authed writes/reads forward Origin+CSRF where the api needs them (the read GET forwards the cookie only).

- [ ] **Step 1: Write failing source-structure tests** (mirror `nav-auth-proxies.test.ts` / `social-proxies.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("notification proxies", () => {
  it("notifications.ts (GET) markPrivate + forwards cookie to /notifications", () => {
    const c = strip(readFileSync(join(DIR, "notifications.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain('"/notifications'); // list path
    expect(c).toContain("request: context.request");
  });
  it("notifications-count.ts (GET) markPrivate + /notifications/unread-count", () => {
    const c = strip(readFileSync(join(DIR, "notifications-count.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notifications/unread-count");
    expect(c).toContain("request: context.request");
  });
  it("notifications-read.ts (POST) markPrivate + forwards CSRF + applyCookies", () => {
    const c = strip(readFileSync(join(DIR, "notifications-read.ts"), "utf8"));
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notifications/read");
    expect(c).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(c).toContain("applyCookies(");
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement** the three proxies (each mirrors `api/social.ts` / `api/follow.ts`). `notifications.ts`:
```ts
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";
import type { APIRoute } from "astro";
export const prerender = false;
export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });
  const cursor = new URL(context.request.url).searchParams.get("cursor");
  const path = cursor === null ? "/notifications" : `/notifications?cursor=${encodeURIComponent(cursor)}`;
  const resp = await apiFetch<unknown>(path, { request: context.request });
  return new Response(resp.text, { status: resp.status, headers });
};
```
`notifications-count.ts` — same shape, path `/notifications/unread-count`. `notifications-read.ts` — POST, parse body, forward Origin+CSRF+`applyCookies` (the `api/follow.ts` idiom), api path `/notifications/read`.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test notify-proxies page-cache-inventory` (the inventory auto-enumerates the three new `src/pages/api/*` files — each must call exactly `markPrivate`).

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/pages/api/notifications.ts apps/web/src/pages/api/notifications-count.ts apps/web/src/pages/api/notifications-read.ts apps/web/test/notify-proxies.test.ts
git commit -m "feat(m2.3a): web proxies — notifications list, count, mark-read"
```

---

### Task 9: `/notifications` page

**Files:**
- Create: `apps/web/src/pages/notifications.astro`, `apps/web/test/notifications-page.test.ts`

**Interfaces:**
- Consumes: `apiFetch`/`applyCookies`, `markPrivate`, `setPublicPageCsp`, `collapseNotifications` + `NotificationsPage` (Task 2), the api `/notifications` route.
- Produces: an authed, `markPrivate`, SSR keyset list page mirroring `/feed` exactly (manual-302 cookie-carrying redirect on 401; `?cursor=` older link). Renders collapsed items via `collapseNotifications`.

- [ ] **Step 1: Write failing tests** (source-structure, mirror `home-feed-page.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(__dirname, "..", "src", "pages", "notifications.astro"), "utf8");
describe("/notifications page", () => {
  it("is markPrivate (one cache helper) and fetches with the cookie", () => {
    expect(src).toContain("markPrivate(Astro)");
    expect(src).toContain("request: Astro.request");
    expect(src).toContain("/notifications");
  });
  it("uses the safe manual-302 redirect on 401, NOT Astro.redirect", () => {
    expect(src).toContain("status: 302");
    expect(src).toContain("applyCookies(");
    expect(src).not.toContain("Astro.redirect");
  });
  it("collapses rows for display", () => {
    expect(src).toContain("collapseNotifications(");
  });
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement** `apps/web/src/pages/notifications.astro` — copy `/feed`'s frontmatter structure verbatim (markPrivate + setPublicPageCsp + apiFetch with `request` + the 401 manual-302 + applyCookies), swapping `Feed` → `NotificationsPage`, `/feed` → `/notifications`, and rendering `collapseNotifications(page.notifications)` into a list. Each collapsed item's label comes from a small local `label(group)` helper implementing the §7 copy (e.g. `follow` → "«lead» followed you"; reactions → "«lead» and N others reacted to «Title»"; etc.), links to the post (`/@…/slug#comment-<id>`) or actor profile. `markPrivate` is the sole cache helper. Empty state: "No notifications yet." Older link: `/notifications?cursor=…`.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test notifications-page page-cache-inventory feed-pages` then `pnpm --filter @thinkersjournal/web build` + full web suite + `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/pages/notifications.astro apps/web/test/notifications-page.test.ts
git commit -m "feat(m2.3a): /notifications page — SSR keyset list, collapsed, safe redirect"
```

---

### Task 10: Nav bell island

**Files:**
- Create: `apps/web/src/scripts/notify-bell.ts`, `apps/web/test/notify-bell.test.ts`
- Modify: `apps/web/src/components/Nav.astro`, `apps/web/test/nav.test.ts`

**Interfaces:**
- Consumes: `/api/notifications-count`, `/api/notifications`, `/api/notifications-read` (Task 8), `collapseNotifications` (Task 2 — imported into the island).
- Produces: `initNotifyBell()`. Nav ships a hidden `[data-notify-bell]` placeholder (anonymous default = no bell, cache-safe); the island reveals + populates it when `/api/notifications-count` returns 200.

- [ ] **Step 1: Write failing tests.** `apps/web/test/notify-bell.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const code = readFileSync(join(__dirname, "..", "src", "scripts", "notify-bell.ts"), "utf8");
describe("notify bell island", () => {
  it("detects logged-in via the count endpoint, staying hidden on 401 (deviation 2)", () => {
    expect(code).toContain("/api/notifications-count");
    expect(code).toContain(".status"); // branches on it (200 → show, 401 → hide)
  });
  it("builds DOM safely — textContent/createElement only", () => {
    expect(code).toContain("createElement"); // positive anchor
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
  it("opens a dropdown, loads items, and marks all read with CSRF", () => {
    expect(code).toContain("/api/notifications");
    expect(code).toContain("/api/notifications-read");
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("polls on visibility + interval", () => {
    expect(code).toContain("visibilitychange");
  });
});
```
Add to `apps/web/test/nav.test.ts` (additive — the nav must carry the hidden placeholder + mount the island):
```ts
it("carries a hidden notify-bell placeholder and mounts the bell island", () => {
  const nav = readFileSync(join(__dirname, "..", "src", "components", "Nav.astro"), "utf8");
  expect(nav).toContain("data-notify-bell"); // placeholder present
  expect(nav).toContain("initNotifyBell"); // island mounted
});
```

- [ ] **Step 2: Run → FAIL,** then **Step 3: implement.**
  - `Nav.astro`: add a hidden bell placeholder inside `.links`, before `[data-auth-slot]`:
    ```astro
    <span class="notify" data-notify-bell hidden>
      <button type="button" class="bell" data-notify-toggle aria-label="Notifications">🔔<span class="badge" data-notify-badge hidden></span></button>
      <div class="notify-panel" data-notify-panel hidden></div>
    </span>
    ```
    and mount it in the existing `<script>` block: `import { initNotifyBell } from "../scripts/notify-bell"; … initNotifyBell();`. Add minimal `.notify`/`.badge`/`.notify-panel` CSS to the nav `<style>`.
  - `notify-bell.ts`: on `initNotifyBell()`, `fetch("/api/notifications-count")`; if `!resp.ok` (401/anon) leave the placeholder hidden and return; else unhide `[data-notify-bell]`, set the badge (hidden when 0; text `count > 9 ? "9+" : String(count)`). Wire `[data-notify-toggle]` click → fetch `/api/notifications`, `collapseNotifications`, render items into `[data-notify-panel]` with `createElement`/`textContent` only, show the panel, then POST `/api/notifications-read {all:true}` with the CSRF token (obtained from `/api/me` or returned by the count/list proxy — simplest: reuse the `/api/me` csrfToken like nav-auth; add a tiny `me()` fetch, cached in a module var) and clear the badge. Re-poll `refreshCount()` on load, on `document.addEventListener("visibilitychange", …)` when visible, and `setInterval(…, 60000)`. Use `appendChild` + block-body arrows (ambient-types quirk).
  > CSRF note: mark-read needs a token. Match nav-auth's approach — one `/api/me` fetch yields `{csrfToken}`; store it and send it as `X-CSRF-Token`. If null (logged-out/degraded), skip the mark-read POST (the panel still renders read-optimistically). Keep this the single `/api/me` call for the bell.

- [ ] **Step 4: Run → PASS.** `pnpm --filter @thinkersjournal/web test notify-bell nav page-cache-inventory` then `pnpm --filter @thinkersjournal/web build` (island must externalize) + full web suite + `pnpm typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/scripts/notify-bell.ts apps/web/src/components/Nav.astro apps/web/test/notify-bell.test.ts apps/web/test/nav.test.ts
git commit -m "feat(m2.3a): nav bell island — count badge, dropdown, mark-all-read; cache-safe placeholder"
```

---

### Task 11: E2E — the notification spine

**Files:**
- Create: `e2e/notifications.spec.ts`

**Interfaces:**
- Consumes: `signUpAndVerify`, `chooseUsername`, `uniqueHandle`, `publishPost` from `e2e/helpers.ts`; both Workers + real Postgres.
- Produces: the whole-loop browser proof.

- [ ] **Step 1: Write the spec.** `e2e/notifications.spec.ts`:
```ts
/**
 * THE NOTIFICATION SPINE — a real browser drives an engagement on one user's
 * content and asserts the OTHER user's nav bell reflects it, across both Workers
 * and real Postgres. Poll-delivered: the bell fetches /api/notifications-count,
 * so "the badge shows 1" here is the DB-backed count (no realtime yet — that is
 * M2.3b). No Workers Cache is involved (these are all no-store/markPrivate).
 */
import { expect, test } from "@playwright/test";
import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("comment → author's bell shows 1 → open → read → clears; follow bumps it again", async ({ page, browser }) => {
  // Author A publishes.
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, { title: "Notify Me", markdownSource: "body" });

  // Reader B comments on A's post.
  const bCtx = await browser.newContext();
  try {
    const b = await bCtx.newPage();
    await signUpAndVerify(b, b.request);
    await chooseUsername(b, uniqueHandle("reader"));
    await b.goto(url);
    const form = b.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill("great post");
    await form.locator("button[type=submit]").click();
    await expect(b.locator(".comment-body").first()).toContainText("great post");

    // A reloads any page; the bell (in the nav) shows an unread badge.
    await page.goto("/feed");
    const bell = page.locator("[data-notify-bell]");
    await expect(bell).toBeVisible();
    await expect(page.locator("[data-notify-badge]")).toHaveText("1");

    // A opens the dropdown → sees the comment notification → badge clears.
    await page.locator("[data-notify-toggle]").click();
    await expect(page.locator("[data-notify-panel]")).toContainText("commented");
    await expect(page.locator("[data-notify-badge]")).toBeHidden();

    // A reloads → still cleared (server persisted the read).
    await page.reload();
    await expect(page.locator("[data-notify-badge]")).toBeHidden();

    // B follows A → the badge returns.
    await b.goto(`/@${(await page.evaluate(() => location.pathname)).replace(/^\/@?/, "").split("/")[0] ?? ""}`).catch(() => {});
    // (simpler: navigate B to A's profile via the post byline)
    await b.goto(url);
    await b.locator("a.link", { hasText: "@" }).first().click(); // to A's profile
    await b.locator("[data-follow-btn]").click();
    await page.reload();
    await expect(page.locator("[data-notify-badge]")).toHaveText("1");
  } finally {
    await bCtx.close();
  }
});
```
> Adjust the "navigate B to A's profile + follow" steps to the real profile/follow markup (`[data-follow-btn]` from M2.1). If the byline-click selector is brittle, derive A's handle from `publishPost`'s return (extend the helper call to capture `username`) and `b.goto(\`/@\${username}\`)` directly — prefer that.

- [ ] **Step 2: Run.** `docker compose up -d db` → `pnpm --filter @thinkersjournal/api run migrate` (dev DB needs 0005!) → `pnpm run test:e2e`. Target 16/16 (15 baseline + 1). Run TWICE clean. Use Playwright auto-waiting `expect(locator)`, no fixed sleeps.
- [ ] **Step 3: Reconcile** any baseline collision by scoping selectors, never weakening.
- [ ] **Step 4: Commit.**
```bash
git add e2e/notifications.spec.ts
git commit -m "test(m2.3a): e2e notification spine — comment/follow → bell badge → read clears"
```

---

## Milestone-end (controller, not a task)

Green sweep (controller runs it): `pnpm typecheck` · fresh `pnpm --filter @thinkersjournal/web build` then `pnpm -r test` · `pnpm --filter @thinkersjournal/markdown run check:workerd` · `pnpm run test:e2e` ×2 · docker healthy. Then the whole-branch adversarial review (lenses: IDOR/authorization, notification-spam/idempotency, cache-leak on the nav badge, notify-never-throws + no-transaction-rollback, keyset correctness, XSS in the panel/page), fix wave, CI-gated PR.

## Self-review notes (already applied)

- **Spec coverage:** §4 → Task 1; §5 seam → Task 3, wired in 4/5/6; §6 API → Task 7; §7 web → 8/9/10; §8 security woven (IDOR test in 7, self-suppress in 3/4/5, anti-spam dedup in 4/5/6); §9 tests per-task + Task 11 e2e.
- **Type consistency:** `NotificationItem` fields flow shared → api list SELECT aliases → page/island; `collapseNotifications` consumes `NotificationItem`, produces `CollapsedNotification`; `commentId` always the new row in comment kinds (Task 4) matches the spec §5 ⚠️.
- **Ambiguities resolved in spec self-review** (badge counts events vs collapsed groups; tone only on singletons; distinct-actor count) are carried into the Task 2 helper + tests.
- **Placeholder scan:** the Task 7 keyset list test body is described, not stubbed — the implementer must seed 31 distinct-actor rows and assert disjoint+complete pages (called out explicitly so it isn't left as an empty `it`).


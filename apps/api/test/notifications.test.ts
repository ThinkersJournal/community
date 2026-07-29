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

/** Insert a PUBLISHED post for `authorId` directly via SQL, returns its id. */
async function seedPost(authorId: string): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, 'b', 'published', now()) RETURNING id`,
      [authorId, `s-${crypto.randomUUID()}`],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

/** Seed a `post_comment` notification (recipient's post, commented on by actorId), returns the row id. */
async function seedPostNotif(recipientId: string, actorId: string, postId: string): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind, post_id) VALUES ($1,$2,'post_comment',$3) RETURNING id`,
      [recipientId, actorId, postId]);
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
// Copied from test/actor.ts's own fixture constant: these bare actors need no
// session, only a `users`+`profiles` row to be a notification's `actor_id`.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/**
 * ⚠️ WHY THIS EXISTS AND WHY 31 DISTINCT ROWS ARE REQUIRED: the keyset test
 * below needs 31 notification rows for ONE recipient to exercise a two-page
 * list. `notifications_event_unique` is `UNIQUE NULLS NOT DISTINCT (recipient_id,
 * actor_id, kind, post_id, comment_id, reaction_kind)` — 31 follow-notifications
 * from the SAME actor to the same recipient would collapse to ONE row (every
 * target column is NULL for a follow), making the keyset test vacuous. Each row
 * here gets its OWN bare actor (a lightweight `users`+`profiles` insert, no
 * session) so the 31 natural keys are genuinely distinct.
 *
 * Tracked in its own array (not test/actor.ts's `createdUserIds`, which only
 * tracks ids inserted via ITS `insertUser`) and cleaned up by this file's own
 * `afterAll` — `ON DELETE CASCADE` on `notifications.actor_id` would leave these
 * dangling in `users` otherwise (deleting the RECIPIENT cascades the
 * notification rows, not the actor rows).
 */
const bareActorIds: string[] = [];

/**
 * Batched seed: `n` distinct bare actors + one follow-notification each, in ONE
 * connection (three multi-row inserts) rather than ~3n single-row inserts across
 * ~2n `withClient` acquisitions. The per-call connection churn flaked under
 * parallel-suite DB contention (a keyset-test timeout); the seeded rows and
 * their natural-key distinctness are identical. Returns the notification ids;
 * records the actor ids in `bareActorIds` for `afterAll` cleanup.
 */
async function seedKeysetNotifs(recipientId: string, n: number): Promise<string[]> {
  const ctx = createExecutionContext();
  const notifIds = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const users = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       SELECT 'bare_' || gen_random_uuid() || '@example.com', $2, now()
         FROM generate_series(1, $1::int)
       RETURNING id`,
      [n, PASSWORD_HASH]);
    const actorIds = users.rows.map((r) => r.id);
    bareActorIds.push(...actorIds);
    await c.query(
      `INSERT INTO profiles (user_id, username)
       SELECT id, 'b' || substr(replace(id::text, '-', ''), 1, 20)
         FROM unnest($1::uuid[]) AS t(id)`,
      [actorIds]);
    const notifs = await c.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind)
       SELECT $1, id, 'follow' FROM unnest($2::uuid[]) AS t(id)
       RETURNING id`,
      [recipientId, actorIds]);
    return notifs.rows.map((r) => r.id);
  });
  await waitOnExecutionContext(ctx);
  return notifIds;
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
    headers: {
      Origin: "http://localhost:8787",
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

let alice: Actor;
let bob: Actor;
beforeAll(async () => {
  alice = await onboardedActor();
  bob = await onboardedActor();
});
afterAll(deleteCreatedUsers);
afterAll(async () => {
  if (bareActorIds.length === 0) return;
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [bareActorIds]));
  await waitOnExecutionContext(ctx);
  bareActorIds.length = 0;
});

describe("GET /notifications", () => {
  it("lists the viewer's own rows newest-first, keyset-paginated", async () => {
    const recipient = await onboardedActor();

    // 31 DISTINCT actors -> 31 distinct natural keys (recipient, actor, 'follow',
    // NULL, NULL, NULL differs only by actor_id) -> no unique-key collapse.
    const seededIds = await seedKeysetNotifs(recipient.userId, 31);
    expect(new Set(seededIds).size).toBe(31); // sanity: the seed itself didn't collapse

    // uuidv7 ids sort lexically the same way Postgres orders them — sort the
    // ACTUAL returned ids rather than assume insertion order, since two inserts
    // in the same millisecond are not guaranteed strictly monotonic.
    const newestFirst = [...seededIds].sort().reverse();

    const page1Res = await fetchWorker(listReq(recipient));
    expect(page1Res.status).toBe(200);
    expect(page1Res.headers.get("cache-control")).toBe("no-store");
    const page1 = (await page1Res.json()) as NotificationsPage;

    expect(page1.notifications).toHaveLength(30);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.notifications.map((n) => n.id)).toEqual(newestFirst.slice(0, 30));
    // Descending order, explicitly.
    for (let i = 1; i < page1.notifications.length; i++) {
      expect(page1.notifications[i]!.id < page1.notifications[i - 1]!.id).toBe(true);
    }
    // Enrichment fields present (actor handle joined in).
    for (const n of page1.notifications) {
      expect(n.kind).toBe("follow");
      expect(n.actor.username.startsWith("b")).toBe(true);
      expect(n.read).toBe(false);
    }

    const page2 = (await (await fetchWorker(listReq(recipient, page1.nextCursor!))).json()) as NotificationsPage;
    expect(page2.notifications).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(page2.notifications[0]!.id).toBe(newestFirst[30]);

    // Disjoint + complete across both pages.
    const allIds = [...page1.notifications.map((n) => n.id), ...page2.notifications.map((n) => n.id)];
    expect(new Set(allIds).size).toBe(31);
    expect([...allIds].sort()).toEqual([...seededIds].sort());
  });

  it("enriches with postAuthorUsername for a post-targeted notification, null for a follow (no post)", async () => {
    const author = await onboardedActor();
    const commenter = await onboardedActor();
    const postId = await seedPost(author.userId);
    const postNotifId = await seedPostNotif(author.userId, commenter.userId, postId);
    const followNotifId = await seedNotif(author.userId, commenter.userId);

    const page = (await (await fetchWorker(listReq(author))).json()) as NotificationsPage;
    const postNotif = page.notifications.find((n) => n.id === postNotifId);
    const followNotif = page.notifications.find((n) => n.id === followNotifId);
    expect(postNotif?.postAuthorUsername).toBe(author.username);
    expect(followNotif?.postAuthorUsername).toBeNull();
  });

  it("401s LOGIN_REQUIRED with no session", async () => {
    const r = await fetchWorker(new Request("https://api.test/notifications"));
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: string }).code).toBe("LOGIN_REQUIRED");
  });

  it("400s INVALID_INPUT for a malformed (non-uuid) cursor", async () => {
    const r = await fetchWorker(
      new Request("https://api.test/notifications?cursor=not-a-uuid", { headers: { Cookie: alice.cookie } }),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });
});

describe("GET /notifications/unread-count", () => {
  it("counts only the viewer's unread rows", async () => {
    const carol = await onboardedActor();
    await seedNotif(carol.userId, alice.userId);
    await seedNotif(carol.userId, bob.userId);
    const r = await fetchWorker(countReq(carol));
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as { count: number }).count).toBe(2);
  });

  it("401s LOGIN_REQUIRED with no session", async () => {
    const r = await fetchWorker(new Request("https://api.test/notifications/unread-count"));
    expect(r.status).toBe(401);
  });
});

describe("POST /notifications/read", () => {
  it("marks specific ids read, then all", async () => {
    const dave = await onboardedActor();
    const id1 = await seedNotif(dave.userId, alice.userId);
    await seedNotif(dave.userId, bob.userId);

    expect((await fetchWorker(markReq(dave, { ids: [id1] }))).status).toBe(200);
    expect(((await (await fetchWorker(countReq(dave))).json()) as { count: number }).count).toBe(1);

    expect((await fetchWorker(markReq(dave, { all: true }))).status).toBe(200);
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

    // read: attacker's list never contains the victim's row — the query scopes
    // recipient_id = attacker.userId in SQL, not merely filters the response.
    const list = (await (await fetchWorker(listReq(attacker))).json()) as NotificationsPage;
    expect(list.notifications.find((n) => n.id === victimNotif)).toBeUndefined();

    // mark-read: attacker marking the victim's id is a no-op — the victim
    // still has it unread afterward.
    const markStatus = (await fetchWorker(markReq(attacker, { ids: [victimNotif] }))).status;
    expect(markStatus).toBe(200); // idempotent 200 even though the UPDATE matched 0 rows
    const c = (await (await fetchWorker(countReq(victim))).json()) as { count: number };
    expect(c.count).toBe(1);
  });
});

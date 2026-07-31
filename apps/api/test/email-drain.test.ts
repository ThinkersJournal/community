import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { withClient } from "../src/db/client";
import { runEmailDrain } from "../src/notifications/email-drain";

import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterAll(deleteCreatedUsers);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Capture Postmark sends; default success (ErrorCode 0). `postmarkSend`
 * (src/auth/postmark.ts) treats a 2xx with ErrorCode 0 as a confirmed send and
 * ANY non-zero ErrorCode as a failure, so `ok = false` here is a rejected send
 * that must leave `emailed_at` NULL.
 */
function stubPostmark(ok = true): { to: string; body: string }[] {
  const sends: { to: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_i: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body)) as { To: string };
      sends.push({ to: b.To, body: String(init!.body) });
      return new Response(JSON.stringify({ ErrorCode: ok ? 0 : 10 }), {
        status: 200,
      });
    }),
  );
  return sends;
}

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function seedNotif(
  recipientId: string,
  actorId: string,
  kind: string,
): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind) VALUES ($1,$2,$3) RETURNING id`,
      [recipientId, actorId, kind],
    );
    return rows[0]!.id;
  });
}

async function emailedAt(id: string): Promise<string | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ e: string | null }>(
      `SELECT emailed_at e FROM notifications WHERE id=$1`,
      [id],
    );
    return rows[0]!.e;
  });
}

/**
 * The recipient's stored email — the key every send-count assertion filters on.
 *
 * ⚠️ WHY: the drain is GLOBAL. It selects every eligible row in the shared test
 * DB, so unrelated verified users left pending by other suites (running in
 * parallel in this pool) can also produce Postmark sends. A raw `sends.length`
 * would therefore be brittle. Each `createVerifiedActor()` email is unique, so
 * filtering `sends` by THIS recipient's address makes the count deterministic
 * regardless of cross-suite traffic.
 */
async function emailOf(userId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ email: string }>(
      `SELECT email FROM users WHERE id=$1`,
      [userId],
    );
    return rows[0]!.email;
  });
}

async function drain(disposition: "instant" | "digest"): Promise<void> {
  const ctx = createExecutionContext();
  await runEmailDrain(env, ctx, disposition);
  await waitOnExecutionContext(ctx);
}

/** The lease is the single-flight gate; reset it between drain invocations. */
async function resetLock(): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE email_drain_lock SET leased_until = NULL`));
}

describe("runEmailDrain", () => {
  it("instant pass emails a direct-kind notification once and stamps emailed_at", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment"); // direct default = instant
    const myEmail = await emailOf(me.userId);
    const sends = stubPostmark();
    await drain("instant");
    // Robust to other suites' pending eligible rows: count only sends to ME.
    expect(sends.filter((s) => s.to === myEmail)).toHaveLength(1);
    expect(await emailedAt(id)).not.toBeNull();
  });

  it("digest-default kinds are NOT sent on the instant pass", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "follow"); // follows default = digest
    const myEmail = await emailOf(me.userId);
    const sends = stubPostmark();
    await drain("instant");
    expect(sends.filter((s) => s.to === myEmail)).toHaveLength(0);
    expect(await emailedAt(id)).toBeNull();
    // ...but the digest pass sends it.
    await resetLock();
    await drain("digest");
    expect(await emailedAt(id)).not.toBeNull();
  });

  it("does NOT stamp emailed_at when the send fails (retry next pass)", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment");
    stubPostmark(false); // ErrorCode != 0
    await drain("instant");
    expect(await emailedAt(id)).toBeNull();
  });

  it("coalesces a burst to one recipient into a single email", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const a1 = await createVerifiedActor();
    const a2 = await createVerifiedActor();
    const id1 = await seedNotif(me.userId, a1.userId, "post_comment");
    const id2 = await seedNotif(me.userId, a2.userId, "comment_reply");
    const myEmail = await emailOf(me.userId);
    const sends = stubPostmark();
    await drain("instant");
    // One email to ME even though two events fired (both direct → instant).
    expect(sends.filter((s) => s.to === myEmail)).toHaveLength(1);
    // ...and both events were carried by that single send (both rows stamped).
    expect(await emailedAt(id1)).not.toBeNull();
    expect(await emailedAt(id2)).not.toBeNull();
  });

  it("suppresses an already-read notification", async () => {
    await resetLock();
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment");
    await ctxRun((c) =>
      c.query(`UPDATE notifications SET read_at = now() WHERE id=$1`, [id]),
    );
    const myEmail = await emailOf(me.userId);
    const sends = stubPostmark();
    await drain("instant");
    expect(sends.filter((s) => s.to === myEmail)).toHaveLength(0);
    expect(await emailedAt(id)).toBeNull();
  });

  it("skips when the lease is already held (single-flight)", async () => {
    await ctxRun((c) =>
      c.query(
        `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds' WHERE pass='instant'`,
      ),
    );
    const me = await createVerifiedActor();
    const actor = await createVerifiedActor();
    const id = await seedNotif(me.userId, actor.userId, "post_comment");
    const myEmail = await emailOf(me.userId);
    const sends = stubPostmark();
    await drain("instant");
    expect(sends.filter((s) => s.to === myEmail)).toHaveLength(0); // lease held → no work
    expect(await emailedAt(id)).toBeNull();
    await resetLock();
  });
});

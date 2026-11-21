// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * THE NOTIFICATION WRITE SEAM (M2.3a) + REALTIME PUSH (M2.3b). The ONLY place a
 * notification row is born. Called AFTER the triggering write commits, on the
 * SAME client (one connection, autocommit).
 *
 * Once a NEW row is committed, this ALSO fires a content-free "you have a
 * notification" nudge at the recipient's NotifyDO.
 *
 * ⚠️ WHY `ctx.waitUntil`, NOT FIRE-AND-FORGET. `NOTIFY.getByName(...).push()` is
 * a Durable Object RPC — it resolves across a real network round trip, not
 * synchronously. If it's simply called without `await`/`waitUntil`, `notify()`
 * returns before that round trip finishes, its caller's Response goes out, and
 * Cloudflare is free to cancel any async work not tracked via `ctx.waitUntil()`
 * once the response has been sent — the push can be silently dropped in
 * production even though every test (which drains microtasks instead of
 * actually racing a Response) stays green. `ctx.waitUntil` keeps the push alive
 * past the response without holding it up: the push is scheduled, not awaited,
 * before `notify()` returns, and any failure is caught INSIDE the waited
 * promise so it can never surface as an unhandled rejection.
 *
 * ⚠️ NEVER THROWS — same rule as cache/purge.ts: neither the INSERT failing nor
 * the push failing may fail or roll back the write that triggered it. Self-events
 * are suppressed here (return before the insert — no row, no push) and forbidden
 * by the DB CHECK (defense in depth). A BLOCK between recipient and actor, in
 * EITHER direction, is suppressed the same way (M4 Task 6 / design doc §7) —
 * the `isBlockedBy` check runs inside the same try as the insert, so a client
 * that fails on that query is swallowed exactly like an insert failure.
 *
 * ⚠️ NO PUSH ON A FAILED INSERT, AND NONE ON A NO-OP INSERT EITHER. If the row
 * never persisted there is nothing to notify about (a phantom nudge). And the
 * insert is `ON CONFLICT ... DO NOTHING` for exactly the anti-harassment reason
 * M2.3a documents at the call sites (re-follow after unfollow, repeat
 * same-tone reaction): those DO NOT add a new DB row. That guarantee only
 * holds end-to-end if it also holds for the live channel — so the push is
 * gated on `rowCount`, not just "the query didn't throw". A duplicate event
 * succeeds as a no-op (`rowCount` 0) and pushes nothing; only a genuinely NEW
 * row (`rowCount` 1) pushes.
 *
 * M3.9: `notifyReferenceChange` (below) is the sibling for the one actor-less
 * event, a refreshed reference that went away or changed. Same discipline: never
 * throws, no push unless a row was born. It SKIPS the block check (there is no
 * actor to block) and enforces the per-author daily cap in the INSERT itself.
 */
import { isBlockedEitherWay } from "../moderation/is-blocked";

import type { NotificationKind } from "@thinkersjournal/shared";
import type { Client } from "pg";

interface NotifyClient {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

// Structural, NOT the ambient `Env` — deliberately. `test/tsconfig.node.json`
// (the plain-Node project for *.node.test.ts, incl. notify-seam.node.test.ts,
// which imports this module) extends tsconfig.base.json directly and does NOT
// include src/worker-configuration.d.ts, so the global `Env` type is not in
// scope there. This minimal shape typechecks in BOTH projects, and the real
// `Env` (whose NOTIFY is DurableObjectNamespace<NotifyDO>) is assignable to it.
export interface NotifyEnv {
  NOTIFY: { getByName(id: string): { push(kind: "notification" | "read"): void } };
}

// Structural stand-in for `ExecutionContext`, for the same reason `NotifyEnv`
// is structural: it must typecheck against BOTH the real (ambient) `Env`'s
// `ExecutionContext` and `cloudflare:test`'s `createExecutionContext()` return
// value. Both satisfy this shape.
export interface NotifyCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface NotifyEvent {
  recipientId: string;
  actorId: string;
  kind: NotificationKind;
  postId?: string;
  commentId?: string;
  reactionKind?: string;
}

export async function notify(
  client: NotifyClient,
  env: NotifyEnv,
  ctx: NotifyCtx,
  ev: NotifyEvent,
): Promise<void> {
  if (ev.recipientId === ev.actorId) return; // no self-notification
  let rowCount: number | null;
  try {
    // Block suppression (M4 Task 6 / design doc §7): a block between the two
    // parties, in EITHER direction, suppresses the notification entirely — no
    // row, no push. `isBlockedEitherWay` checks both directions in ONE query
    // (vs. two sequential directional `isBlockedBy` calls), on the SAME client
    // passed in. Runs inside this try so a check against a broken client (e.g. a
    // mock that only implements `query` and always throws) is swallowed by the
    // same "never throws" discipline as the insert below.
    const pgClient = client as unknown as Client;
    if (await isBlockedEitherWay(pgClient, ev.recipientId, ev.actorId)) {
      return;
    }

    ({ rowCount } = await client.query(
      `INSERT INTO notifications
         (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT notifications_event_unique DO NOTHING`,
      [ev.recipientId, ev.actorId, ev.kind, ev.postId ?? null, ev.commentId ?? null, ev.reactionKind ?? null],
    ));
  } catch (err) {
    console.error("notify failed", { kind: ev.kind, err });
    return; // the row didn't persist — don't push a phantom nudge
  }
  if (!rowCount) return; // ON CONFLICT no-op (duplicate event) — nothing new to push

  pushNudge(env, ctx, ev.recipientId, ev.kind);
}

function pushNudge(env: NotifyEnv, ctx: NotifyCtx, recipientId: string, kind: NotificationKind): void {
  ctx.waitUntil(
    (async () => {
      try {
        await env.NOTIFY.getByName(recipientId).push("notification");
      } catch (err) {
        console.error("notify push failed", { kind, err });
      }
    })(),
  );
}

/** The most reference notifications one author is sent per rolling day; the rest are dropped, not queued (M3.9 ruling 5). */
export const REFERENCE_NOTIFICATIONS_PER_DAY = 20;

export interface ReferenceChangeEvent {
  recipientId: string;
  postId: string;
  referenceId: string;
  /** `gone`, or `changed:<content_hash>`: the dedupe key, so one state notifies once ever. */
  referenceEvent: string;
}

/**
 * Write one `reference_changed` notification (M3.9). Actor-less; NO snapshot text is ever stored or pushed. The cap is a
 * guard inside the INSERT (count of this recipient's reference rows in the last day), so a duplicate that hits ON CONFLICT
 * is a no-op and does not eat budget, and an author already at the cap gets rowCount 0 and no push.
 */
export async function notifyReferenceChange(
  client: NotifyClient,
  env: NotifyEnv,
  ctx: NotifyCtx,
  ev: ReferenceChangeEvent,
): Promise<void> {
  let rowCount: number | null;
  try {
    ({ rowCount } = await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, kind, post_id, reference_id, reference_event)
       SELECT $1::uuid, NULL, 'reference_changed', $2::uuid, $3::uuid, $4::text
        WHERE (SELECT count(*) FROM notifications
                WHERE recipient_id = $1::uuid AND kind = 'reference_changed'
                  AND created_at > now() - interval '1 day') < $5::int
       ON CONFLICT ON CONSTRAINT notifications_event_unique DO NOTHING`,
      [ev.recipientId, ev.postId, ev.referenceId, ev.referenceEvent, REFERENCE_NOTIFICATIONS_PER_DAY],
    ));
  } catch (err) {
    console.error("notify failed", { kind: "reference_changed", err });
    return;
  }
  if (!rowCount) return;
  pushNudge(env, ctx, ev.recipientId, "reference_changed");
}

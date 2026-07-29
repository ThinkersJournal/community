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
 * by the DB CHECK (defense in depth).
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
 */
import type { NotificationKind } from "@thinkersjournal/shared";

interface NotifyClient {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

// Structural, NOT the ambient `Env` — deliberately. `test/tsconfig.node.json`
// (the plain-Node project for *.node.test.ts, incl. notify-seam.node.test.ts,
// which imports this module) extends tsconfig.base.json directly and does NOT
// include src/worker-configuration.d.ts, so the global `Env` type is not in
// scope there. This minimal shape typechecks in BOTH projects, and the real
// `Env` (whose NOTIFY is DurableObjectNamespace<NotifyDO>) is assignable to it.
interface NotifyEnv {
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

  ctx.waitUntil(
    (async () => {
      try {
        await env.NOTIFY.getByName(ev.recipientId).push("notification");
      } catch (err) {
        console.error("notify push failed", { kind: ev.kind, err });
      }
    })(),
  );
}

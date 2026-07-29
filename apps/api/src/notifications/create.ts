/**
 * THE NOTIFICATION WRITE SEAM (M2.3a) + REALTIME PUSH (M2.3b). The ONLY place a
 * notification row is born. Called AFTER the triggering write commits, on the
 * SAME client (one connection, autocommit).
 *
 * Once the row is committed, this ALSO fires a content-free "you have a
 * notification" nudge at the recipient's NotifyDO — fire-and-forget, in its own
 * try/catch, so a DO outage can never affect the comment/reaction/follow that
 * triggered it.
 *
 * ⚠️ NEVER THROWS — same rule as cache/purge.ts: neither the INSERT failing nor
 * the push failing may fail or roll back the write that triggered it. Self-events
 * are suppressed here (return before the insert — no row, no push) and forbidden
 * by the DB CHECK (defense in depth).
 *
 * ⚠️ NO PUSH ON A FAILED INSERT. If the row never persisted there is nothing to
 * notify about — pushing anyway would nudge the recipient's bell for a
 * notification that does not exist (a phantom nudge).
 */
import type { NotificationKind } from "@thinkersjournal/shared";

interface NotifyClient {
  query(sql: string, params: unknown[]): Promise<unknown>;
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

export interface NotifyEvent {
  recipientId: string;
  actorId: string;
  kind: NotificationKind;
  postId?: string;
  commentId?: string;
  reactionKind?: string;
}

export async function notify(client: NotifyClient, env: NotifyEnv, ev: NotifyEvent): Promise<void> {
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
    return; // the row didn't persist — don't push a phantom nudge
  }

  try {
    env.NOTIFY.getByName(ev.recipientId).push("notification");
  } catch (err) {
    console.error("notify push failed", { kind: ev.kind, err });
  }
}

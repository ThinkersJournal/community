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

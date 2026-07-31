/**
 * The email OUTBOX drain (M2.3c). One pass per disposition ('instant' every 2 min,
 * 'digest' daily). Single-flight via the email_drain_lock lease row (NOT a session
 * advisory lock — unreliable through Hyperdrive's transaction-mode pooling; see
 * db/client.ts). Selects eligible rows (unsent, unread, verified recipient, master
 * on, category channel = this disposition), coalesces per recipient into ONE email
 * (shared collapse/label copy), and stamps emailed_at ONLY on a confirmed send so a
 * failure retries next pass.
 */
import { CANONICAL_ORIGIN, sendNotificationEmail } from "../auth/email-verify";
import { withClient } from "../db/client";
import { buildNotificationEmail } from "./email-content";
import { mintUnsubToken } from "./unsub-token";

import type { Client } from "pg";
import type { NotificationItem } from "@thinkersjournal/shared";

interface DrainRow {
  id: string; recipientId: string; email: string;
  kind: NotificationItem["kind"];
  username: string; displayName: string | null;
  postId: string | null; postTitle: string | null; postSlug: string | null; postAuthorUsername: string | null;
  commentId: string | null; reactionKind: string | null; createdAt: string;
}

// Category channel per row = CASE on kind → the matching prefs column, COALESCE'd
// to the spec default for an absent prefs row. Compared to $1 (the disposition).
const SELECT_ELIGIBLE = `
  SELECT n.id, n.recipient_id AS "recipientId", u.email,
         n.kind,
         ap.username, ap.display_name AS "displayName",
         n.post_id AS "postId", p.title AS "postTitle", p.slug AS "postSlug",
         pp.username AS "postAuthorUsername",
         n.comment_id AS "commentId", n.reaction_kind AS "reactionKind",
         n.created_at AS "createdAt"
    FROM notifications n
    JOIN users u ON u.id = n.recipient_id
    JOIN profiles ap ON ap.user_id = n.actor_id
    LEFT JOIN notification_prefs np ON np.user_id = n.recipient_id
    LEFT JOIN posts p ON p.id = n.post_id
    LEFT JOIN profiles pp ON pp.user_id = p.author_id
   WHERE n.emailed_at IS NULL
     AND n.read_at IS NULL
     AND u.email_verified_at IS NOT NULL
     AND COALESCE(np.master_enabled, true) = true
     AND CASE
           WHEN n.kind IN ('post_comment','comment_reply')   THEN COALESCE(np.direct, 'instant')
           WHEN n.kind IN ('post_reaction','comment_reaction') THEN COALESCE(np.reactions, 'digest')
           WHEN n.kind = 'follow'                             THEN COALESCE(np.follows, 'digest')
         END = $1::notification_channel
   ORDER BY n.recipient_id, n.created_at`;

function toItem(r: DrainRow): NotificationItem {
  return {
    id: r.id, kind: r.kind,
    actor: { username: r.username, displayName: r.displayName },
    postId: r.postId, postTitle: r.postTitle, postSlug: r.postSlug,
    postAuthorUsername: r.postAuthorUsername,
    commentId: r.commentId, reactionKind: r.reactionKind,
    createdAt: r.createdAt, read: false,
  };
}

export async function runEmailDrain(
  env: Env, ctx: ExecutionContext, disposition: "instant" | "digest",
): Promise<void> {
  // Phase A: acquire the lease and read the work in one connection, then release it.
  const claim = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
    const lock = await c.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds'
        WHERE pass = $1 AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
      [disposition],
    );
    if ((lock.rowCount ?? 0) === 0) return null; // another pass holds the lease
    const { rows } = await c.query<DrainRow>(SELECT_ELIGIBLE, [disposition]);
    return rows;
  });
  if (claim === null) return;

  try {
    // Phase B: group by recipient, send one email each, collect stamped ids.
    const byRecipient = new Map<string, DrainRow[]>();
    for (const r of claim) {
      const list = byRecipient.get(r.recipientId);
      if (list === undefined) byRecipient.set(r.recipientId, [r]);
      else list.push(r);
    }
    const sentIds: string[] = [];
    for (const [recipientId, rows] of byRecipient) {
      const token = await mintUnsubToken(env, recipientId);
      // ONE unsub URL per recipient: the body's unsubscribe link (via
      // buildNotificationEmail) and the RFC 8058 List-Unsubscribe header (via
      // sendNotificationEmail) MUST be the same URL, so build it once here.
      const unsubUrl = `${CANONICAL_ORIGIN}/unsub?token=${encodeURIComponent(token)}`;
      const email = buildNotificationEmail(rows.map(toItem), { unsubUrl, disposition });
      const ok = await sendNotificationEmail(env, { to: rows[0]!.email, unsubUrl, ...email });
      if (ok) for (const r of rows) sentIds.push(r.id);
    }
    // Phase C: stamp only the confirmed sends.
    if (sentIds.length > 0) {
      await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        c.query(`UPDATE notifications SET emailed_at = now() WHERE id = ANY($1::uuid[]) AND emailed_at IS NULL`, [sentIds]),
      );
    }
  } finally {
    // Release the lease (a crash instead auto-expires it after 90s).
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(`UPDATE email_drain_lock SET leased_until = NULL WHERE pass = $1`, [disposition]),
    );
  }
}

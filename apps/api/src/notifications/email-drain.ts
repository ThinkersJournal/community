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
  // ⚠️ MUST NOT THROW — this runs inside scheduled()/ctx.waitUntil, where a
  // rejection surfaces as an unhandled rejection and silently skips the pass.
  // So the WHOLE body (including Phase A's lease-acquire + SELECT) is wrapped:
  // if the SELECT threw AFTER the lease UPDATE committed, an unguarded Phase A
  // would leave the lease held-and-unreleased AND reject out of waitUntil.
  //
  // An OPAQUE per-pass owner token fences the release: only the pass that still
  // owns the lease may clear it (see the finally). An opaque token — NOT the
  // leased_until timestamp — because a timestamp fence has JS Date ms-truncation
  // and cross-connection timezone-rendering footguns.
  let acquired = false;
  const leaseToken = crypto.randomUUID();
  try {
    // Phase A: acquire the lease and read the work in one connection.
    //
    // ⚠️ LEASE TTL (300s) MUST EXCEED THE 120s INSTANT CRON INTERVAL
    // (wrangler.jsonc `*/2 * * * *`). With the old 90s TTL, a normal-duration
    // pass that is still sending (a slow/hung Postmark request, or many
    // recipients sent sequentially) could lose its lease BEFORE the next tick;
    // the next cron pass would then acquire, re-run SELECT_ELIGIBLE, see the
    // SAME still-unstamped rows (Phase C hasn't stamped yet), and send DUPLICATE
    // emails. 300s clears the interval with headroom while bounding
    // crash-recovery to a couple of ticks. (The digest lock shares this TTL but
    // fires daily, so overlap can't arise there.)
    const claim = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c: Client) => {
      const lock = await c.query(
        `UPDATE email_drain_lock SET leased_until = now() + interval '300 seconds', leased_by = $2
          WHERE pass = $1 AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
        [disposition, leaseToken],
      );
      if ((lock.rowCount ?? 0) === 0) return null; // another pass holds the lease
      acquired = true; // set right after a confirmed acquire — NO await between
      const { rows } = await c.query<DrainRow>(SELECT_ELIGIBLE, [disposition]);
      return rows;
    });
    if (claim === null) return; // lease held elsewhere (acquired stayed false)

    // Phase B: group by recipient, send one email each, collect stamped ids.
    const byRecipient = new Map<string, DrainRow[]>();
    for (const r of claim) {
      const list = byRecipient.get(r.recipientId);
      if (list === undefined) byRecipient.set(r.recipientId, [r]);
      else list.push(r);
    }
    const sentIds: string[] = [];
    for (const rows of byRecipient.values()) {
      const token = await mintUnsubToken(env, rows[0]!.recipientId);
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
  } catch (err) {
    console.error("email drain failed", { disposition, err });
  } finally {
    // Release the lease ONLY if THIS call acquired it AND still owns it. The
    // `leased_by = $2` fence is the fix for the release footgun: a pass whose
    // lease already expired and was re-acquired by a successor (a DIFFERENT
    // leased_by) clears 0 rows here instead of wiping the successor's LIVE
    // lease. A crash before release instead auto-expires the lease after its
    // TTL. The release is itself try/caught so a release failure can't throw out
    // of finally and replace the root cause.
    if (acquired) {
      try {
        await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
          c.query(
            `UPDATE email_drain_lock SET leased_until = NULL, leased_by = NULL WHERE pass = $1 AND leased_by = $2`,
            [disposition, leaseToken],
          ),
        );
      } catch (err) {
        console.error("email drain lease release failed", { disposition, err });
      }
    }
  }
}

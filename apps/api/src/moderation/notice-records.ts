/**
 * #57 Q9 — keep what a moderation notice actually said, for a bounded period.
 *
 * Writes are BEST-EFFORT: `recordNotice` never throws and logs the action id
 * only (the body carries the moderator's reason and a content title, so no body,
 * title or address ever reaches a log line). The purge follows
 * `reapUnconfirmedDsaNotices`: a bounded batch, idempotent, count logged.
 */
import { withClient } from "../db/client";
import { MODERATION_NOTICE_RETENTION_DAYS } from "@thinkersjournal/shared";
import type { RenderedNotice } from "./notify-author";

/** Caps one run's DELETE (same reasoning as DSA_REAP_BATCH / REAP_BATCH). */
export const NOTICE_RECORD_PURGE_BATCH = 500;

export async function recordNotice(
  env: Env,
  ctx: ExecutionContext,
  actionId: string,
  kind: "author" | "account",
  rendered: RenderedNotice,
): Promise<void> {
  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // retain_until counts from the DECISION's created_at. The fallback to
      // now() is only for an action row that cannot be read (never expected).
      await c.query(
        `INSERT INTO moderation_notice_records (action_id, kind, subject, body_text, body_html, retain_until)
         VALUES ($1, $2, $3, $4, $5,
                 COALESCE((SELECT created_at FROM moderation_actions WHERE id = $1), now())
                   + make_interval(days => $6::int))
         ON CONFLICT (action_id) DO NOTHING`,
        [actionId, kind, rendered.subject, rendered.textBody, rendered.htmlBody, MODERATION_NOTICE_RETENTION_DAYS],
      );
    });
  } catch {
    console.error("moderation notice record not stored", { actionId });
  }
}

/** Delete records past `retain_until`. Run daily from scheduled() on "30 3 * * *". Returns the count. */
export async function purgeExpiredNoticeRecords(env: Env, ctx: ExecutionContext): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM moderation_notice_records WHERE id IN (
         SELECT id FROM moderation_notice_records
          WHERE retain_until < now()
          ORDER BY retain_until
          LIMIT $1
       )`,
      [NOTICE_RECORD_PURGE_BATCH],
    );
    return rowCount ?? 0;
  });
  if (n > 0) {
    console.log(`purge-moderation-notice-records: deleted ${n} record(s)`);
  }
  return n;
}

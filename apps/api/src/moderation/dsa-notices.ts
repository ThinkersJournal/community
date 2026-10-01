/**
 * DSA notices (spec §3.3, §8). ⚠️ AC-1: NOTHING here touches `reports`,
 * `hidden_at` or `maybeAutoHide`. A notice is queue input for a human only.
 *
 * `listOpenDsaNotices` below DELIBERATELY READS HIDDEN ROWS, same reasoning as
 * `queue.ts`'s header: a notice may name content auto-hide (or a prior
 * decision) has since hidden, and an admin still needs to see it to resolve
 * the notice. It carries no `hidden_at IS NULL` predicate on purpose. This
 * module lives outside `src/routes/`, which is the only tree
 * `test/hidden-at-read-guard.node.test.ts` scans — the property that makes
 * that safe is NOT its directory, it is that `listOpenDsaNotices` is reachable
 * only through `requireAdmin` (routes/admin.ts's `handleListDsaNotices`).
 */
import type { Client } from "pg";

import { base64urlEncode, sha256Hex } from "../auth/encoding";
import { withClient } from "../db/client";

import type { DsaNoticeInputT } from "@thinkersjournal/shared";

/**
 * Insert a notice ONLY if its target is publicly visible. `null` = not (the
 * caller 404s).
 *
 * ⚠️ Addendum (PM ruling, 2026-10-01): `target_kind` and `target_label` are
 * filled HERE, inside the SAME `INSERT … SELECT` as the visibility check —
 * not backfilled afterward — so the zero-row "not visible" path stays the
 * one atomic statement it already was. `target_label` is the live title/body
 * excerpt taken AT THIS MOMENT, which is what makes it survive the target
 * later going to NULL under the FK's `ON DELETE SET NULL` (migration 0020).
 */
export async function createDsaNotice(
  c: Client,
  input: Omit<DsaNoticeInputT, "turnstileToken" | "goodFaith">,
): Promise<{ id: string; token: string } | null> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  // ⚠️ The visibility predicate is INSIDE the INSERT … SELECT, so "is it
  // public" and "write the row" are one statement — no check-then-act gap.
  const { rows } =
    input.postId !== undefined
      ? await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, target_kind, target_label, post_id, reason, statement)
           SELECT $1, $2, true, $3, 'post', p.title, p.id, $5, $6 FROM posts p
            WHERE p.id = $4 AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.postId, input.reason, input.statement],
        )
      : await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, target_kind, target_label, comment_id, reason, statement)
           SELECT $1, $2, true, $3, 'comment', left(cm.body_markdown, 120), cm.id, $5, $6 FROM comments cm JOIN posts p ON p.id = cm.post_id
            WHERE cm.id = $4 AND cm.hidden_at IS NULL AND cm.deleted_at IS NULL
              AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.commentId, input.reason, input.statement],
        );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, token };
}

/** Confirmation links stop working, and unconfirmed notices are reaped, after this. */
export const DSA_CONFIRM_WINDOW_DAYS = 7;

/**
 * The fixed KV key under which the most recently issued RAW DSA confirmation
 * token is stashed for `GET /__test/last-dsa-token` (src/routes/__test.ts) to
 * hand back to the E2E suite — the SAME test-seam shape
 * `TEST_LAST_RESET_TOKEN_KEY` (src/auth/password-reset.ts) uses for
 * password-reset tokens, for the identical reason: E2E's Postmark is
 * configured with a dummy token so the real send fails by design, and this
 * stash stands in for reading the inbox. The stash itself lives in KV even
 * though the token's REAL storage is `dsa_notices.verify_token_hash`
 * (Postgres) — this is test scaffolding only, not a second source of truth.
 *
 * Written ONLY when `env.TEST_ROUTES === "1"` — see routes/dsa-notice.ts's
 * `handleDsaNotice`, which is the sole writer.
 */
export const TEST_LAST_DSA_TOKEN_KEY = "__test:last-dsa-token";

/**
 * M1 (final-review fix): a hash inside the window is a valid PEEK whether or
 * not it has already been confirmed — NOT `email_verified_at IS NULL` — so a
 * mail client prefetching the link, or a reporter re-opening/refreshing it
 * AFTER a successful confirm, still sees "valid" instead of the misleading
 * `INVALID_TOKEN` this used to return. A hash that doesn't exist, or is past
 * `DSA_CONFIRM_WINDOW_DAYS`, still fails either way.
 */
export async function peekDsaToken(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM dsa_notices
      WHERE verify_token_hash = $1
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DSA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * ⚠️ Confirms ONLY. AC-1: it does not count, report, or hide anything.
 *
 * M1 (final-review fix): IDEMPOTENT — a hash already confirmed, still inside
 * the window, matches this UPDATE too (no `email_verified_at IS NULL` guard),
 * so a double submit/refresh/re-opened link after a successful confirm
 * returns `true` again instead of failing. `COALESCE(email_verified_at,
 * now())` is what makes it idempotent: it sets the timestamp the FIRST time
 * and leaves an already-set one untouched on every call after, so repeating
 * this never moves the stamp. A hash that doesn't exist, or is outside the
 * window, still fails.
 */
export async function confirmDsaNotice(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE dsa_notices SET email_verified_at = COALESCE(email_verified_at, now())
      WHERE verify_token_hash = $1
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DSA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Caps one run's DELETE so a pathological backlog cannot turn a routine cron
 * into an unbounded statement — same shape and same reasoning as
 * `auth/reap-unverified.ts`'s `REAP_BATCH`.
 */
const DSA_REAP_BATCH = 500;

/**
 * Hard-delete unconfirmed DSA notices older than `DSA_CONFIRM_WINDOW_DAYS`.
 * Run daily by src/index.ts's `scheduled` on cron `"30 3 * * *"`, next to
 * `reapUnverifiedAccounts`.
 *
 * ⚠️ `email_verified_at IS NULL` is the whole guard: a CONFIRMED notice is
 * never reaped, no matter its age — see Review Focus 5 / dsa-notice-confirm.test.ts.
 *
 * Returns the number of notices reaped, for the caller to log/observe.
 */
export async function reapUnconfirmedDsaNotices(
  env: Env,
  ctx: ExecutionContext,
): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM dsa_notices WHERE id IN (
         SELECT id FROM dsa_notices
          WHERE email_verified_at IS NULL
            AND created_at < now() - make_interval(days => $1::int)
          ORDER BY created_at
          LIMIT $2
       )`,
      [DSA_CONFIRM_WINDOW_DAYS, DSA_REAP_BATCH],
    );
    return rowCount ?? 0;
  });
  if (n > 0) {
    console.log(`reap-unconfirmed-dsa-notices: deleted ${n} notice(s)`);
  }
  return n;
}

/** A row in `GET /admin/dsa-notices` (before the JSON round-trip). */
export interface OpenDsaNotice {
  readonly id: string;
  readonly kind: "post" | "comment";
  /**
   * Addendum (PM ruling, 2026-10-01): `null` once the target has been deleted
   * by its author — `post_id`/`comment_id` go to NULL under the FK's
   * `ON DELETE SET NULL` (migration 0020). `contentDeleted` is the explicit
   * flag; this being `null` is what makes that true, never inferred from it.
   */
  readonly targetId: string | null;
  /**
   * Post title, or the first 120 characters of a comment, if the target is
   * still live — mirrors queue.ts's excerpt. Falls back to `target_label`
   * (the snapshot taken at intake) once the target is gone, so a deleted
   * notice still names what it was about.
   */
  readonly excerpt: string;
  /** Addendum: true once `targetId` is `null` — the content was deleted by its author. */
  readonly contentDeleted: boolean;
  readonly reason: string;
  readonly statement: string;
  readonly reporterName: string;
  readonly reporterEmail: string;
  readonly createdAt: Date;
}

/**
 * Every CONFIRMED, unresolved notice, oldest first — `GET /admin/dsa-notices`'s
 * data source. "Confirmed" is `email_verified_at IS NOT NULL`; "unresolved" is
 * `resolved_at IS NULL` — the same two predicates `decide.ts`'s resolution
 * UPDATE uses, so a row this lists is exactly a row that UPDATE can still
 * reach (an orphaned row is the one exception — see `closeOrphanedDsaNotice`,
 * the only way to resolve one). See this module's header for why it reads
 * hidden rows on purpose.
 *
 * ⚠️ Addendum (PM ruling, 2026-10-01): LEFT JOIN, not JOIN — a notice whose
 * target has since been deleted by its author must still appear (it is still
 * open input for a human), so `target_kind` (never `post_id IS NOT NULL`,
 * which is no longer reliable once the FK can SET NULL) selects which half of
 * the UNION a row belongs to.
 */
export async function listOpenDsaNotices(c: Client): Promise<OpenDsaNotice[]> {
  const { rows } = await c.query<{
    id: string;
    kind: "post" | "comment";
    target_id: string | null;
    excerpt: string;
    content_deleted: boolean;
    reason: string;
    statement: string;
    reporter_name: string;
    reporter_email: string;
    created_at: Date;
  }>(
    `SELECT n.id, 'post' AS kind, p.id AS target_id, COALESCE(p.title, n.target_label) AS excerpt,
            (p.id IS NULL) AS content_deleted,
            n.reason, n.statement, n.reporter_name, n.reporter_email, n.created_at
       FROM dsa_notices n LEFT JOIN posts p ON p.id = n.post_id
      WHERE n.target_kind = 'post' AND n.email_verified_at IS NOT NULL AND n.resolved_at IS NULL
     UNION ALL
     SELECT n.id, 'comment' AS kind, c.id AS target_id, COALESCE(left(c.body_markdown, 120), n.target_label) AS excerpt,
            (c.id IS NULL) AS content_deleted,
            n.reason, n.statement, n.reporter_name, n.reporter_email, n.created_at
       FROM dsa_notices n LEFT JOIN comments c ON c.id = n.comment_id
      WHERE n.target_kind = 'comment' AND n.email_verified_at IS NOT NULL AND n.resolved_at IS NULL
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    targetId: r.target_id,
    excerpt: r.excerpt,
    contentDeleted: r.content_deleted,
    reason: r.reason,
    statement: r.statement,
    reporterName: r.reporter_name,
    reporterEmail: r.reporter_email,
    createdAt: r.created_at,
  }));
}

/**
 * Addendum (PM ruling, 2026-10-01): the ONLY way to close a notice whose
 * target has been deleted by its author. `decide.ts`'s ordinary resolution
 * path resolves by `post_id`/`comment_id`, which are NULL on an orphaned row
 * by construction — it can never reach one.
 *
 * Returns the reporter's email, the notice's kind, and its `target_label` (to
 * compose the outcome email) on success. "Eligible" means the row EXISTS, its
 * own target column (`target_kind`-selected) is NULL, and it is not already
 * resolved — any failure of those three is a 404 (no such notice) or a 409
 * (not an orphan / already resolved) at the route, which tells them apart
 * with its own read.
 */
export interface OrphanedDsaNoticeCandidate {
  readonly exists: boolean;
  readonly eligible: boolean;
}

export async function closeOrphanedDsaNotice(
  c: Client,
  noticeId: string,
): Promise<{ reporterEmail: string; kind: "post" | "comment"; targetLabel: string } | null> {
  // The UPDATE's own WHERE is the real guard (atomic: a row this UPDATE
  // touches is, by construction, exactly a row eligible to close) — the
  // caller re-reads on a zero-row result only to pick a status code.
  const { rows } = await c.query<{ reporter_email: string; target_kind: "post" | "comment"; target_label: string }>(
    `UPDATE dsa_notices
        SET resolved_at = now()
      WHERE id = $1
        AND resolved_at IS NULL
        AND ((target_kind = 'post' AND post_id IS NULL) OR (target_kind = 'comment' AND comment_id IS NULL))
      RETURNING reporter_email, target_kind, target_label`,
    [noticeId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { reporterEmail: row.reporter_email, kind: row.target_kind, targetLabel: row.target_label };
}

/** Does `noticeId` exist at all, and is it eligible to close (see `closeOrphanedDsaNotice`)?
 * Used ONLY to pick 404 vs 409 after that UPDATE affects zero rows — never to gate the
 * mutation itself (that would reintroduce a check-then-act gap the UPDATE's own WHERE avoids). */
export async function orphanedDsaNoticeCandidate(
  c: Client,
  noticeId: string,
): Promise<OrphanedDsaNoticeCandidate> {
  const { rows } = await c.query<{ eligible: boolean }>(
    `SELECT (resolved_at IS NULL
             AND ((target_kind = 'post' AND post_id IS NULL) OR (target_kind = 'comment' AND comment_id IS NULL))
            ) AS eligible
       FROM dsa_notices WHERE id = $1`,
    [noticeId],
  );
  const row = rows[0];
  return row === undefined ? { exists: false, eligible: false } : { exists: true, eligible: row.eligible };
}

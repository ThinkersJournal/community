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

/** Insert a notice ONLY if its target is publicly visible. `null` = not (the caller 404s). */
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
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, post_id, reason, statement)
           SELECT $1, $2, true, $3, p.id, $5, $6 FROM posts p
            WHERE p.id = $4 AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.postId, input.reason, input.statement],
        )
      : await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, comment_id, reason, statement)
           SELECT $1, $2, true, $3, cm.id, $5, $6 FROM comments cm JOIN posts p ON p.id = cm.post_id
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
  readonly targetId: string;
  /** Post title, or the first 120 characters of a comment — mirrors queue.ts's excerpt. */
  readonly excerpt: string;
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
 * reach. See this module's header for why it reads hidden rows on purpose.
 */
export async function listOpenDsaNotices(c: Client): Promise<OpenDsaNotice[]> {
  const { rows } = await c.query<{
    id: string;
    kind: "post" | "comment";
    target_id: string;
    excerpt: string;
    reason: string;
    statement: string;
    reporter_name: string;
    reporter_email: string;
    created_at: Date;
  }>(
    `SELECT n.id, 'post' AS kind, p.id AS target_id, p.title AS excerpt,
            n.reason, n.statement, n.reporter_name, n.reporter_email, n.created_at
       FROM dsa_notices n JOIN posts p ON p.id = n.post_id
      WHERE n.post_id IS NOT NULL AND n.email_verified_at IS NOT NULL AND n.resolved_at IS NULL
     UNION ALL
     SELECT n.id, 'comment' AS kind, c.id AS target_id, left(c.body_markdown, 120) AS excerpt,
            n.reason, n.statement, n.reporter_name, n.reporter_email, n.created_at
       FROM dsa_notices n JOIN comments c ON c.id = n.comment_id
      WHERE n.comment_id IS NOT NULL AND n.email_verified_at IS NOT NULL AND n.resolved_at IS NULL
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    targetId: r.target_id,
    excerpt: r.excerpt,
    reason: r.reason,
    statement: r.statement,
    reporterName: r.reporter_name,
    reporterEmail: r.reporter_email,
    createdAt: r.created_at,
  }));
}

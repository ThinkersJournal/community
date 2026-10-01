/**
 * DSA notices (spec §3.3, §8). ⚠️ AC-1: NOTHING here touches `reports`,
 * `hidden_at` or `maybeAutoHide`. A notice is queue input for a human only.
 */
import type { Client } from "pg";

import { base64urlEncode, sha256Hex } from "../auth/encoding";

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

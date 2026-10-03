/**
 * Per-purpose, single-use links carried by a moderation notice (#113 plan B).
 *
 * ⚠️ PER PURPOSE (PM ruling on #50 Q4): an `appeal` token can never act as a
 * `delete_request` token, or the reverse. Every read and the consuming write
 * match on purpose, so a token presented for the other purpose is
 * indistinguishable from an unknown one.
 *
 * ⚠️ PEEK NEVER CONSUMES. Mail scanners (e.g. Outlook Safe Links) GET every
 * link in a message. A page load may only peek; only an explicit POST consumes.
 *
 * ⚠️ NO PATH REACHES A DELETED ACCOUNT (account-legal-hold spec §4a, PM ruling
 * B; pre-flight ruling B3). The anonymise scrub deletes an account's tokens,
 * and, as defence in depth, mint, peek and consume each refuse an anonymised
 * account in the SAME statement. Mint and consume take `FOR KEY SHARE` on the
 * users row, exactly as createResetToken (auth/password-reset.ts) does: it
 * waits for an in-flight scrub's `FOR UPDATE` and, in READ COMMITTED,
 * re-evaluates `anonymised_at IS NULL` against the committed row. Consume's
 * lock is held to the caller's COMMIT, so a scrub cannot commit between the
 * consume and the write that follows it (fileAppeal, the delete request).
 *
 * Same shape as auth/password-reset.ts: 32 CSPRNG bytes, base64url, stored as
 * SHA-256 hex, consumed by one atomic compare-and-set UPDATE.
 */
import type { Client } from "pg";

import { base64urlEncode, sha256Hex } from "../auth/encoding";

export type ActionTokenPurpose = "appeal" | "delete_request";

export interface ActionTokenContext {
  readonly actionId: string;
  readonly userId: string;
}

/**
 * Mint one token. Returns the RAW token (the only copy), or `null`, inserting
 * nothing, when the account is anonymised or does not exist.
 */
export async function mintActionToken(
  c: Client,
  input: { readonly actionId: string; readonly userId: string; readonly purpose: ActionTokenPurpose; readonly ttlMs: number },
): Promise<string | null> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const { rowCount } = await c.query(
    `INSERT INTO moderation_action_tokens (action_id, user_id, purpose, token_hash, expires_at)
     SELECT $1::uuid, u.id, $3::text, $4::text, now() + make_interval(secs => $5::double precision / 1000)
       FROM users u WHERE u.id = $2 AND u.anonymised_at IS NULL
        FOR KEY SHARE`,
    [input.actionId, input.userId, input.purpose, await sha256Hex(token), input.ttlMs],
  );
  return (rowCount ?? 0) === 1 ? token : null;
}

export async function peekActionToken(c: Client, token: string, purpose: ActionTokenPurpose): Promise<ActionTokenContext | null> {
  const { rows } = await c.query<{ action_id: string; user_id: string }>(
    `SELECT t.action_id, t.user_id FROM moderation_action_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now()
        AND u.anonymised_at IS NULL`,
    [await sha256Hex(token), purpose],
  );
  const r = rows[0];
  return r === undefined ? null : { actionId: r.action_id, userId: r.user_id };
}

/**
 * Atomically redeem a token. `null` for an unknown, expired, spent or
 * wrong-purpose token, and for an anonymised account: one generic outcome.
 * ⚠️ Call it inside the caller's transaction: the users-row lock it takes is
 * what keeps the scrub out until the caller commits.
 */
export async function consumeActionToken(c: Client, token: string, purpose: ActionTokenPurpose): Promise<ActionTokenContext | null> {
  const { rows } = await c.query<{ action_id: string; user_id: string }>(
    `WITH live AS (
       SELECT u.id FROM users u
        WHERE u.id = (SELECT t0.user_id FROM moderation_action_tokens t0 WHERE t0.token_hash = $1)
          AND u.anonymised_at IS NULL
          FOR KEY SHARE
     )
     UPDATE moderation_action_tokens t SET used_at = now()
       FROM live
      WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now()
        AND t.user_id = live.id
     RETURNING t.action_id, t.user_id`,
    [await sha256Hex(token), purpose],
  );
  const r = rows[0];
  return r === undefined ? null : { actionId: r.action_id, userId: r.user_id };
}

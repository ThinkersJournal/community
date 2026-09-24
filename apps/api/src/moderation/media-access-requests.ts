/**
 * The two-person grant for fetching legally-held media (#61 / CireSnave's
 * ruling on #26: "should likely require multiple hands authorizing access").
 *
 * ⚠️ `approve` REFUSES A SELF-APPROVAL AT THE QUERY, not just at the read
 * side in `routes/media-restricted.ts` — belt-and-braces: even if that read
 * check were ever weakened, the row itself can never end up both requested
 * and approved by the same identity.
 */
import type { Client } from "pg";

/** How long an approved grant remains usable. */
export const GRANT_WINDOW_MINUTES = 15;

export async function requestMediaAccess(
  c: Client,
  input: { readonly r2Key: string; readonly requestedBy: string; readonly reason: string },
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO media_access_requests (r2_key, requested_by, reason) VALUES ($1, $2, $3) RETURNING id`,
    [input.r2Key, input.requestedBy, input.reason],
  );
  return rows[0]!.id;
}

/**
 * @returns true if approved, false if the request doesn't exist or is a
 *   self-approval.
 *
 * ⚠️ `lower(trim(...))` ON BOTH SIDES, NOT `<>` — Access emails are not
 * case-normalized upstream, so "Alice@x" approving "alice@x" is the SAME
 * hand. The 0016 CHECK constraint enforces this same rule at the row level
 * (belt-and-braces: even a future caller that skips this function cannot
 * write a self-approved row), and `routes/media-restricted.ts`'s read-side
 * check re-normalizes the same way — all three must agree.
 */
export async function approveMediaAccess(
  c: Client,
  requestId: string,
  approvedBy: string,
): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE media_access_requests
        SET approved_by = $2, approved_at = now(), expires_at = now() + interval '${GRANT_WINDOW_MINUTES} minutes'
      WHERE id = $1 AND approved_by IS NULL AND lower(trim(requested_by)) <> lower(trim($2))`,
    [requestId, approvedBy],
  );
  return (rowCount ?? 0) > 0;
}

export interface PendingMediaAccessRequest {
  readonly id: string;
  readonly r2Key: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly createdAt: Date;
}

/**
 * Every UNAPPROVED request, oldest first — the admin UI's whole reason for
 * existing (endpoint/UI audit, 2026-09-24): before this there was no way to
 * SEE a pending request except a raw HTTP call. `approved_by IS NULL` is the
 * same predicate `approveMediaAccess`'s own `WHERE` clause requires to
 * succeed, so a row that disappears from this list is exactly a row that can
 * no longer be approved (already approved, by construction — there is no
 * delete/expiry path on this table).
 */
export async function listPendingMediaAccessRequests(c: Client): Promise<PendingMediaAccessRequest[]> {
  const { rows } = await c.query<{
    id: string;
    r2_key: string;
    requested_by: string;
    reason: string;
    created_at: Date;
  }>(
    `SELECT id, r2_key, requested_by, reason, created_at
       FROM media_access_requests
      WHERE approved_by IS NULL
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    r2Key: r.r2_key,
    requestedBy: r.requested_by,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

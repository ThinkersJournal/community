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

/** @returns true if approved, false if the request doesn't exist or is a self-approval. */
export async function approveMediaAccess(
  c: Client,
  requestId: string,
  approvedBy: string,
): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE media_access_requests
        SET approved_by = $2, approved_at = now(), expires_at = now() + interval '${GRANT_WINDOW_MINUTES} minutes'
      WHERE id = $1 AND approved_by IS NULL AND requested_by <> $2`,
    [requestId, approvedBy],
  );
  return (rowCount ?? 0) > 0;
}

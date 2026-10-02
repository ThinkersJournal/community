/**
 * A banned account's email reservation (account-legal-hold spec §4a; PM ruling B, 2026-10-01).
 *
 * At deletion every account's email is replaced by the undeliverable sentinel
 * (anonymise-accounts.ts). For an account that is BANNED at that moment, the
 * reaper also stores `users.reserved_email_sha256` = the sha256 hex of the
 * normalised email, and signup refuses any address whose hash matches. The
 * real address is no longer on the account row, which is all any mail or
 * authentication path reads (the moderation log's subject_label keeps the
 * email recorded at a content decision, but nothing mails from it).
 * The reservation ends when the ban does (`releaseReservedEmail`, called by
 * plan B's ban-lift path).
 */
import { normalizeEmail } from "@thinkersjournal/shared";
import type { Client } from "pg";

import { sha256Hex } from "./encoding";

/** Lowercase-hex sha256 of signup's own normalisation (`normalizeEmail`, packages/shared/src/schemas.ts). */
export function reservedEmailSha256(email: string): Promise<string> {
  return sha256Hex(normalizeEmail(email));
}

/** True if a deleted, banned account still reserves this address. */
export async function isEmailReserved(c: Client, email: string): Promise<boolean> {
  const { rowCount } = await c.query(
    "SELECT 1 FROM users WHERE reserved_email_sha256 = $1 LIMIT 1",
    [await reservedEmailSha256(email)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Ends the reservation once the account is no longer banned. A no-op (false)
 * while `disabled_at` is still set, or when nothing is reserved. Call it in the
 * same transaction that clears `disabled_at`, after that UPDATE.
 */
export async function releaseReservedEmail(c: Client, userId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE users SET reserved_email_sha256 = NULL
      WHERE id = $1 AND disabled_at IS NULL AND reserved_email_sha256 IS NOT NULL`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

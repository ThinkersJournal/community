/**
 * A banned account's email reservation (account-legal-hold spec §4a; PM ruling B, 2026-10-01;
 * keyed by migration 0023, 2026-10-02).
 *
 * At deletion every account's email is replaced by the undeliverable sentinel
 * (anonymise-accounts.ts). For an account that is BANNED at that moment, the
 * reaper also stores `users.reserved_email_hmac` = the lowercase-hex
 * HMAC-SHA-256 of the normalised email, keyed by the `RESERVED_EMAIL_KEY`
 * Workers secret, and signup refuses any address whose fingerprint matches.
 * The real address is no longer on the account row, which is all any mail or
 * authentication path reads (the moderation log's subject_label keeps the
 * email recorded at a content decision, but nothing mails from it).
 * The reservation ends when the ban does (`releaseReservedEmail`, called by
 * plan B's ban-lift path).
 *
 * ⚠️ WHY KEYED. 0022 stored an UNSALTED SHA-256 (`reserved_email_sha256`).
 * Anyone holding that column could recover the address by hashing candidate
 * addresses and comparing. Without the key, an HMAC can't be tested that way.
 * The legacy column is still READ by `isEmailReserved` and CLEARED by
 * `releaseReservedEmail`, so a row 0022's reaper wrote stays reserved; nothing
 * writes it any more. A later migration drops it once production shows 0 rows.
 *
 * ⚠️ ROTATING THE KEY RELEASES EVERY HMAC RESERVATION: an old fingerprint never
 * matches a new key's. See docs/runbooks/deploy.md.
 *
 * ⚠️ FAIL CLOSED. A missing or empty key throws `ReservedEmailKeyMissingError`
 * from every function that needs it, never "not reserved": signup answers 503
 * and the reaper leaves a banned row unscrubbed (and retries it).
 */
import { normalizeEmail } from "@thinkersjournal/shared";
import type { Client } from "pg";

import { sha256Hex } from "./encoding";

/** Thrown when `RESERVED_EMAIL_KEY` is missing or empty. Never caught as "not reserved". */
export class ReservedEmailKeyMissingError extends Error {
  constructor() {
    super("RESERVED_EMAIL_KEY is missing or empty: refusing to reserve or check a banned account's address without it");
    this.name = "ReservedEmailKeyMissingError";
  }
}

type KeyEnv = Pick<Env, "RESERVED_EMAIL_KEY">;

/** True when the key is a non-empty string. */
export function hasReservedEmailKey(env: KeyEnv): boolean {
  const key: unknown = env.RESERVED_EMAIL_KEY;
  return typeof key === "string" && key.length > 0;
}

/**
 * Lowercase-hex HMAC-SHA-256 of signup's own normalisation (`normalizeEmail`,
 * packages/shared/src/schemas.ts), keyed by the UTF-8 bytes of
 * `RESERVED_EMAIL_KEY`. Throws `ReservedEmailKeyMissingError` without a key.
 */
export async function reservedEmailHmac(env: KeyEnv, email: string): Promise<string> {
  if (!hasReservedEmailKey(env)) throw new ReservedEmailKeyMissingError();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.RESERVED_EMAIL_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(normalizeEmail(email)));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * LEGACY, READ-ONLY: the unsalted digest 0022's reaper stored. Used only to
 * find those rows; never written.
 */
export function reservedEmailSha256(email: string): Promise<string> {
  return sha256Hex(normalizeEmail(email));
}

/**
 * True if a deleted, banned account still reserves this address, by either
 * column. Throws `ReservedEmailKeyMissingError` without a key (fail closed).
 */
export async function isEmailReserved(c: Client, env: KeyEnv, email: string): Promise<boolean> {
  const hmac = await reservedEmailHmac(env, email);
  const { rowCount } = await c.query(
    `SELECT 1 FROM users
      WHERE reserved_email_hmac = $1 OR reserved_email_sha256 = $2
      LIMIT 1`,
    [hmac, await reservedEmailSha256(email)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Ends the reservation once the account is no longer banned, clearing BOTH
 * columns. A no-op (false) while `disabled_at` is still set, or when nothing
 * is reserved. Call it in the same transaction that clears `disabled_at`,
 * after that UPDATE. Needs no key.
 */
export async function releaseReservedEmail(c: Client, userId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE users SET reserved_email_hmac = NULL, reserved_email_sha256 = NULL
      WHERE id = $1 AND disabled_at IS NULL
        AND (reserved_email_hmac IS NOT NULL OR reserved_email_sha256 IS NOT NULL)`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Per-OBJECT legal holds (issue #61 / CireSnave's ruling on #26): "a post
 * hidden or removed for legal reasons must not be fetchable by anyone other
 * than site administrators and those involved with the legal mitigation ...
 * even then, those should likely require multiple hands."
 *
 * ⚠️ KEYED ON r2_key, NOT ON A POST. Content-addressing means the identical
 * bytes can appear in another, still-visible post — a hold must restrict the
 * OBJECT everywhere it appears, so it is never released by
 * `isKeyPubliclyReachable` finding a visible sibling. A held key is pulled
 * from the public bucket unconditionally and STAYS there until an explicit
 * release (not built here — CSAM holds are never released by this app at
 * all; see the CSAM/NCMEC compliance plan).
 */
import type { Client } from "pg";

export type LegalHoldCategory = "csam" | "dmca" | "other";

export async function imposeLegalHold(
  c: Client,
  input: {
    readonly r2Key: string;
    readonly imposedBy: string;
    readonly category: LegalHoldCategory;
    readonly moderationActionId: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO media_legal_holds (r2_key, imposed_by, category, moderation_action_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (r2_key) DO NOTHING`, // already held (e.g. a second post using the same image) — first hold wins
    [input.r2Key, input.imposedBy, input.category, input.moderationActionId],
  );
}

export async function isKeyLegallyHeld(c: Client, r2Key: string): Promise<boolean> {
  const { rowCount } = await c.query(`SELECT 1 FROM media_legal_holds WHERE r2_key = $1`, [r2Key]);
  return (rowCount ?? 0) > 0;
}

/** Every currently-held key — used by the restricted route's fast-path check. */
export async function legallyHeldKeys(c: Client, r2Keys: readonly string[]): Promise<Set<string>> {
  if (r2Keys.length === 0) return new Set();
  const { rows } = await c.query<{ r2_key: string }>(
    `SELECT r2_key FROM media_legal_holds WHERE r2_key = ANY($1::text[])`,
    [r2Keys],
  );
  return new Set(rows.map((r) => r.r2_key));
}

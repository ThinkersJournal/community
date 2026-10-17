import { HELD_ROW_CAP, type SignalClass } from "@thinkersjournal/shared";

/**
 * `/admin/security`'s pure helpers (security-alerting spec §2.6 N6), kept out
 * of the .astro file so they have a plain-Node test. A ref is 16 CSPRNG bytes as
 * 32 lowercase hex characters (apps/api/src/security/ledger-store.ts `newRef`).
 */
const REF_RE = /^[0-9a-f]{32}$/;

/** A well-formed ref (trimmed, lowercased), or null: a malformed one never reaches the api. */
export function parseRef(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return REF_RE.test(trimmed) ? trimmed : null;
}

/**
 * The classes the ledger holds rows for: the api accepts exactly these
 * (routes/admin-security.ts `isHeldClass`: a positive `HELD_ROW_CAP`). A summary
 * class holds nothing, so listing it would only earn a 400.
 */
export const HELD_CLASSES: readonly SignalClass[] = (Object.keys(HELD_ROW_CAP) as SignalClass[]).filter(
  (c) => HELD_ROW_CAP[c] > 0,
);

const HELD_CLASS_SET: ReadonlySet<string> = new Set<string>(HELD_CLASSES);

/**
 * The `class` query parameter: absent or empty is the first class; a held class
 * is itself; anything else is null, and is never forwarded to the api.
 */
export function parseHeldClass(value: string | null): SignalClass | null {
  if (value === null || value === "") return "account";
  return HELD_CLASS_SET.has(value) ? (value as SignalClass) : null;
}

/**
 * The api answers `400 INVALID_INPUT` with `fields: ["after"]` (and not `class`)
 * when a cursor's account ref has expired between pages: the walk cannot be
 * resumed and the admin restarts the class from its first page.
 */
export function isExpiredCursor(resp: { status: number; data: unknown }): boolean {
  if (resp.status !== 400 || typeof resp.data !== "object" || resp.data === null) return false;
  const { code, fields } = resp.data as { code?: unknown; fields?: unknown };
  return code === "INVALID_INPUT" && Array.isArray(fields) && fields.length === 1 && fields[0] === "after";
}

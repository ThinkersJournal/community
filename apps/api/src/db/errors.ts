/**
 * Postgres SQLSTATE predicates — the errors this Worker treats as CLIENT errors
 * rather than crashes.
 *
 * ⚠️ SQLSTATE, NEVER MESSAGE TEXT. A message is localized, version-dependent
 * prose; the five-character code is the contract.
 */

/** Postgres SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether `err` is a Postgres unique-constraint violation.
 *
 * Shared because the transaction-mode pooler makes "INSERT and handle 23505" the
 * ONLY correct way to place a unique value (src/routes/signup.ts's username,
 * src/routes/posts.ts's slug) — a SELECT-then-INSERT check is a race by
 * construction. One definition so the two cannot drift.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** Postgres SQLSTATE for `invalid_text_representation` (e.g. a bad uuid cast). */
const INVALID_TEXT_REPRESENTATION = "22P02";

/**
 * Whether `err` is Postgres refusing to cast a value — which for us always means
 * a malformed client-supplied id/cursor reached a query. That is a 400 or a 404,
 * never a 500: `WHERE id < 'not-a-uuid'` throws before it can match nothing.
 */
export function isInvalidTextRepresentation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === INVALID_TEXT_REPRESENTATION
  );
}

/** Postgres SQLSTATE for `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Whether `err` is a Postgres foreign-key-constraint violation — for us, always
 * a client-supplied id that references a row that does not exist (e.g. `POST
 * /follows` naming a nonexistent `followeeId`). That is a 404, never a 500.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === FOREIGN_KEY_VIOLATION
  );
}

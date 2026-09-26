/** Handles that would let an account impersonate the platform or a role. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "support", "help", "official", "staff", "team",
  "moderator", "mod", "root", "system", "security", "abuse", "billing",
  "thinkersjournal", "thinkers_journal", "tj", "api", "www", "mail",
  "about", "login", "logout", "signup", "settings", "me", "feed", "authors",
]);

/**
 * The exact prefix src/auth/anonymise-accounts.ts's `scrubbedUsername` mints
 * (`deleted-user-<user_id>`) for an anonymised account. A new signup must
 * never be able to claim one of these strings: `username` is `citext UNIQUE
 * NOT NULL` (0001_users_and_profiles.sql), so a collision would be a
 * database-level failure at the least recoverable point in the flow, and —
 * worse — a claimable "deleted-user-..." handle would let a new account sit
 * under what looks like a tombstoned author's old identity.
 */
export const DELETED_USER_PREFIX = "deleted-user-";

/** True if `username` (already lowercased) is unavailable at signup. */
export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username) || username.startsWith(DELETED_USER_PREFIX);
}

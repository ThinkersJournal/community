/** Handles that would let an account impersonate the platform or a role. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "support", "help", "official", "staff", "team",
  "moderator", "mod", "root", "system", "security", "abuse", "billing",
  "thinkersjournal", "thinkers_journal", "tj", "api", "www", "mail",
  "about", "login", "logout", "signup", "settings", "me", "feed", "authors",
]);

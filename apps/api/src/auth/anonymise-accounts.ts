/**
 * The daily account-anonymisation reaper (board item 59 = Option C).
 *
 * ⚠️ AN IN-PLACE `UPDATE`, NEVER A `DELETE FROM users` — see
 * migrations/0019_account_deletion.sql's header for why (every content
 * table cascades off `users(id)`, and CireSnave ruled "keep posts").
 *
 * Run daily by src/index.ts's `scheduled`, its own branch, same shape as
 * reap-unverified.ts/reap-orphan-media.ts.
 *
 * ⚠️ EXCLUDES `disabled_at`/`suspended_until` accounts, same as
 * reap-unverified.ts's own DELETE — a barred account is never reaped, even
 * once its 30-day window has passed, because scrubbing `email` would destroy
 * an identifying detail a live moderation/legal hold (CSAM/NCMEC
 * preservation) may still need. This means a barred user's deletion request
 * never matures while the bar is in effect; that is intentional, not a bug.
 */
import { withClient } from "../db/client";

const REAP_BATCH = 500;

/**
 * `email` is `citext UNIQUE NOT NULL` (0001_users_and_profiles.sql) — cannot
 * go to NULL. Derived from `id`, which is already unique, so this can never
 * collide across two anonymised rows; the domain is never registered, so
 * nothing is ever deliverable to it.
 */
function scrubbedEmail(userId: string): string {
  return `deleted-${userId}@invalid.thinkersjournal.local`;
}

/**
 * `password_hash` is `text NOT NULL` — cannot go to NULL either. Chosen to
 * structurally fail `password.ts`'s PHC_PATTERN (`/^\$argon2id\$v=19\$.../`):
 * `parsePhc` returns `null` for anything that doesn't match, and the login
 * path never runs a compare against a `null` parse. This is not "an invalid
 * hash of some password" (which a resourceful attacker with a captured
 * database dump might have to work to rule out) — it is a string argon2id
 * could never emit, since real output always starts `$argon2id$v=19$`.
 */
const SCRUBBED_PASSWORD_HASH = "!anonymised!";

/**
 * `username` is `citext UNIQUE NOT NULL` — cannot go to NULL, and this is the
 * value that gets "released" at the 30-day mark (board item 59 = Option C):
 * the OLD handle is freed for a new signup to claim, so it must not remain
 * on this row. Derived from `id` (already unique) rather than a random
 * short id, so a collision across two anonymised rows is structurally
 * impossible rather than merely unlikely. Reserved at signup
 * (RESERVED_USERNAMES' `startsWith` check, src/routes/signup.ts) so a new
 * signup can never claim this exact string out from under a still-resolving
 * old permalink.
 */
function scrubbedUsername(userId: string): string {
  return `deleted-user-${userId}`;
}

/**
 * Scrub accounts whose 30-day grace period has passed with no cancel.
 * Returns the number anonymised, for the caller to log/observe.
 */
export async function anonymiseExpiredAccounts(env: Env, ctx: ExecutionContext): Promise<number> {
  const ids = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM users
        WHERE deletion_requested_at < now() - interval '30 days'
          AND anonymised_at IS NULL
          AND disabled_at IS NULL
          AND suspended_until IS NULL
        ORDER BY deletion_requested_at
        LIMIT $1`,
      [REAP_BATCH],
    );
    return rows.map((r) => r.id);
  });
  if (ids.length === 0) return 0;

  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    for (const id of ids) {
      await c.query(
        `UPDATE users
            SET email = $2, password_hash = $3, anonymised_at = now()
          WHERE id = $1`,
        [id, scrubbedEmail(id), SCRUBBED_PASSWORD_HASH],
      );
      await c.query(
        `UPDATE profiles
            SET username = $2, display_name = NULL, bio = NULL
          WHERE user_id = $1`,
        [id, scrubbedUsername(id)],
      );
      await c.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [id]);
    }
  });

  // Kill every live session for each scrubbed account — the scrub makes
  // password_hash unable to authenticate a FUTURE login, but does nothing
  // about a session issued before it. Same mechanism as logout-all
  // (src/routes/logout.ts): bumping security_epoch revokes existing sessions.
  for (const id of ids) {
    ctx.waitUntil(env.USER_SECURITY.getByName(id).bumpEpoch());
  }

  console.log(`anonymise-accounts: anonymised ${ids.length} account(s)`);
  return ids.length;
}

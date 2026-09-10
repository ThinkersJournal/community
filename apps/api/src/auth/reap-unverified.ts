/**
 * The daily "reaper" (handle-at-signup Task 8). Because a handle is now claimed
 * at signup, BEFORE email verification (see src/routes/signup.ts), an
 * unverified/bot account squats both its handle and its email address for as
 * long as it exists. This hard-deletes any account that never verified within
 * a 7-day grace window, freeing both back up.
 *
 * `profiles` / `media` / `posts` (and everything chained off them —
 * `follows`, `comments`, `reactions`, `notifications`, `notification_prefs`)
 * all carry `ON DELETE CASCADE` back to `users` (see the migrations under
 * apps/api/migrations/), so deleting the `users` row is the whole cleanup.
 *
 * Run daily by src/index.ts's `scheduled` on cron `"30 3 * * *"` — its own
 * branch, BEFORE the email-drain dispatch (every other cron pattern there is
 * the drain; this one is not).
 */
import { withClient } from "../db/client";

/**
 * Caps one run's DELETE so a pathological backlog cannot turn a routine cron
 * into an unbounded statement. Comfortably above any batch this project's
 * traffic could plausibly produce in a day; a backlog beyond it simply gets
 * finished on the NEXT run (created_at ASC means the oldest — most clearly
 * abandoned — squats go first).
 */
const REAP_BATCH = 500;

/**
 * Hard-delete accounts that never verified within the grace window.
 *
 * ⚠️ KEYED ON `created_at`, NEVER "last activity" — an account has no activity
 * to measure until it verifies, so the only honest age signal is how long ago
 * it was created. This is also what makes the reap safe: a real user mid
 * verification (they signed up 10 minutes ago, have not yet clicked the
 * email) is nowhere near the 7-day boundary, no matter how long the CLICK
 * itself takes.
 *
 * Returns the number of accounts reaped, for the caller to log/observe.
 */
export async function reapUnverifiedAccounts(
  env: Env,
  ctx: ExecutionContext,
): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    // ⚠️ A BARRED ACCOUNT IS NEVER REAPED, even unverified and stale. A ban
    // whose subject was never verified would otherwise be deleted after 7
    // days -- taking the user AND THE EVIDENCE with it. See issue #35 and
    // AC-3; test/reap-unverified.test.ts pins it against this function.
    const { rowCount } = await c.query(
      `DELETE FROM users
        WHERE id IN (
          SELECT id FROM users
           WHERE email_verified_at IS NULL
             AND created_at < now() - interval '7 days'
             AND disabled_at IS NULL
             AND suspended_until IS NULL
           ORDER BY created_at
           LIMIT $1
        )`,
      [REAP_BATCH],
    );
    return rowCount ?? 0;
  });
  if (n > 0) {
    console.log(`reap-unverified: deleted ${n} account(s)`);
  }
  return n;
}

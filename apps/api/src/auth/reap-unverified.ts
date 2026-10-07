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
 *
 * ⚠️ AN ACTIVE ACCOUNT LEGAL HOLD IS THE ONLY THING THAT SPARES A STALE
 * UNVERIFIED ACCOUNT (account-legal-hold spec §0/§4; AC-3 as reworded there:
 * "A legally held unverified account survives `reapUnverifiedAccounts`").
 * CireSnave ruled that a legal hold, not a suspension, blocks deletion, and the
 * PM applied the same principle to this reaper. `disabled_at`/`suspended_until`
 * are access control only, so a banned or suspended unverified account with no
 * hold is deleted like any other (spec §4a accepts that for an account that
 * never verified, and so could never post). It deletes in ONE statement, and
 * its inner SELECT takes `FOR UPDATE SKIP LOCKED`: every hold imposer locks the
 * `users` row before inserting its hold, so a row locked by an imposer (or by
 * anything else) is skipped, never deleted out from under it, and the next
 * nightly run reconsiders it.
 */
import { withClient } from "../db/client";
import { forgetAll } from "../security/forget";

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
  const ids = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    // ⚠️ A HELD ACCOUNT IS NEVER REAPED, even unverified and stale: deleting
    // it would take the user AND THE EVIDENCE the hold preserves. A ban or
    // suspension alone does not spare it (see the file header). AC-3 (as
    // reworded by the account-legal-hold spec); test/reap-unverified.test.ts
    // pins it against this function.
    const { rows } = await c.query<{ id: string }>(
      `DELETE FROM users
        WHERE id IN (
          SELECT id FROM users
           WHERE email_verified_at IS NULL
             AND created_at < now() - interval '7 days'
             AND NOT EXISTS (SELECT 1 FROM account_legal_holds h
                              WHERE h.user_id = users.id AND h.released_at IS NULL)
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING id`,
      [REAP_BATCH],
    );
    return rows.map((r) => r.id);
  });
  // security-alerting §2.6 N7, §4.5: the same clean-up as the anonymise reaper,
  // per deleted id, AWAITED after `withClient` returned (the lock is released).
  // The nightly sweep (R2-1, src/security/forget-sweep.ts) re-forgets whatever a failure left.
  await forgetAll(env, ids, "reap-unverified");
  const n = ids.length;
  if (n > 0) {
    console.log(`reap-unverified: deleted ${n} account(s)`);
  }
  return n;
}

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
 * ⚠️ AN ACTIVE ACCOUNT LEGAL HOLD IS THE GATE, NOT A BAN (account-legal-hold
 * spec §0/§4). CireSnave, verbatim: "A legal hold should block deletion. A
 * legal hold is not the same as a simple suspension. Do we need to separate
 * the two?" The PM answered yes, and ruled that `disabled_at`/`suspended_until`
 * are pure access control. So an account with an active row in
 * `account_legal_holds` is never scrubbed (its deletion request stays
 * recorded, and the first run after the hold is released proceeds), and a
 * banned or suspended account with NO hold is scrubbed like any other. Both
 * SQL statements below carry the same NOT EXISTS clause; the only
 * `disabled_at` read left in this file is the `CASE` that decides the hash.
 *
 * ⚠️ A BANNED ACCOUNT'S ADDRESS IS RESERVED BY HASH (spec §4a). PM ruling B,
 * verbatim: "Approve B … B structurally can't mail a deleted user because the
 * real address no longer exists anywhere to send to. It's also a real
 * data-minimization win … Go with the SHA256-of-normalized-email approach for
 * barred-re-entry matching." Every account's email is replaced by the
 * sentinel; one that is banned at the moment of its scrub also gets
 * `reserved_email_sha256`, which signup refuses (src/auth/reserved-email.ts).
 *
 * ⚠️ EACH SCRUB LOCKS ITS ROW AND RE-CHECKS (spec §4). The batch SELECT may be
 * stale by the time a row is written: a hold imposed, a ban imposed or lifted,
 * or the request cancelled. Each row gets its own transaction, which takes
 * `FOR UPDATE` and then re-checks everything in the scrubbing `UPDATE`.
 *
 * ⚠️ REVOKED PER ROW, AND ONE ROW NEVER STOPS THE BATCH (spec §4, re-audit B1).
 * Each row's security epoch is bumped BEFORE its scrub (a failed bump skips the
 * row, unscrubbed) and again right after its COMMIT. A row whose scrub fails (a
 * lock timeout, any error) is logged, skipped and retried by the next run. The
 * run logs `anonymised S, skipped (re-check) K, failed F of N`, and throws when
 * some row failed and none was scrubbed. `main`'s reaper bumped epochs only after the whole
 * loop, so an error mid-batch left every already-scrubbed account's sessions
 * live; this closes that.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX, withClient } from "../db/client";

import { reservedEmailSha256 } from "./reserved-email";

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
 * Scrub accounts whose 30-day grace period has passed with no cancel and no
 * active legal hold. Returns the number anonymised, for the caller to
 * log/observe. Throws when some candidate failed and none was scrubbed.
 */
export async function anonymiseExpiredAccounts(env: Env, ctx: ExecutionContext): Promise<number> {
  const candidates = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; email: string }>(
      `SELECT id, email FROM users
        WHERE deletion_requested_at < now() - interval '30 days'
          AND anonymised_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM account_legal_holds h
                           WHERE h.user_id = users.id AND h.released_at IS NULL)
        ORDER BY deletion_requested_at
        LIMIT $1`,
      [REAP_BATCH],
    );
    return rows;
  });
  if (candidates.length === 0) return 0;

  let scrubbed = 0;
  let skipped = 0; // the re-check said no (a hold, a cancel, a changed row)
  let failed = 0; // a bump or the scrub threw; the row is retried next run
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    for (const { id, email } of candidates) {
      // ⚠️ REVOKE BEFORE THE SCRUB, AND AGAIN AFTER ITS COMMIT (spec §4).
      // GET routes (readCurrentSession) check only the epoch, never the row,
      // so the epoch is the only thing that stops a deleted account's session
      // from reading. Bump #1 runs FIRST: if it fails, skip the row — nothing
      // is scrubbed, so this fails closed, and the next nightly run retries
      // it. If the scrub then fails or re-checks false, the user has merely
      // been logged out (they asked for deletion 30+ days ago, or a hold has
      // just landed). Bump #2 closes the window for a login that lands
      // between bump #1 and the COMMIT.
      // A connection lost mid-batch logs out every remaining candidate without
      // scrubbing it. Intended: each asked for deletion 30+ days ago.
      try {
        await env.USER_SECURITY.getByName(id).bumpEpoch();
      } catch (err) {
        console.error(`anonymise-accounts: skipped ${id}: pre-scrub epoch bump failed (retried next run)`, err);
        failed += 1;
        continue;
      }
      // ⚠️ ONE ROW'S FAILURE NEVER STOPS THE BATCH. A lock timeout
      // (BEGIN_BOUNDED_TX's 5s) or any other error leaves THAT row unscrubbed,
      // which is safe, and the next nightly run retries it. Rethrowing would
      // strand every row already committed in this run: main's reaper had
      // exactly that shape (it bumped only after the loop).
      let changed: boolean;
      try {
        changed = await scrubOne(c, id, email);
      } catch (err) {
        console.error(`anonymise-accounts: skipped ${id} (retried next run)`, err);
        failed += 1;
        continue;
      }
      if (!changed) {
        skipped += 1;
        continue;
      }
      scrubbed += 1;
      // Bump #2. If it fails, mutating routes still refuse the session
      // (auth/pipeline.ts step 5a); the residual is spec §4's accepted one.
      try {
        await env.USER_SECURITY.getByName(id).bumpEpoch();
      } catch (err) {
        console.error(`anonymise-accounts: post-scrub epoch bump failed for ${id}; step 5a still refuses writes`, err);
      }
    }
  });

  const n = candidates.length;
  const summary = `anonymise-accounts: anonymised ${scrubbed}, skipped (re-check) ${skipped}, failed ${failed} of ${n}`;
  if (failed > 0) console.error(summary);
  else console.log(summary);
  // ⚠️ FAILURES WITH NOTHING SCRUBBED are not "a bad row": they are a dead
  // connection or a down DO. Fail the cron visibly. Keyed on `scrubbed === 0`,
  // not `failed === n`, so rows the re-check merely skipped (held, cancelled)
  // can't mask a dead connection. A partial failure, with at least one row
  // scrubbed, does not throw: those rows are done, and the rest retry tomorrow.
  if (failed > 0 && scrubbed === 0) {
    throw new Error(
      `anonymise-accounts: no candidate was anonymised and ${failed} of ${n} failed; see the per-row errors above`,
    );
  }
  return scrubbed;
}

/**
 * One account, one transaction. Returns whether the row was scrubbed (false:
 * a re-check failed — a hold, a cancelled request, or an already-anonymised
 * or changed row). Throws on a DB error, after rolling back.
 */
async function scrubOne(c: Client, id: string, email: string): Promise<boolean> {
  // Computed for every candidate; the UPDATE's CASE decides whether to store it.
  const emailSha256 = await reservedEmailSha256(email);
  await c.query(BEGIN_BOUNDED_TX);
  try {
    // ⚠️ LOCK, THEN RE-CHECK (spec §4). The batch SELECT may be minutes old
    // by now: a hold may have been imposed (T1/T2/T3), a ban imposed or lifted
    // (plan A/B), or the request cancelled. Every hold imposer locks this row
    // first (imposeAccountHoldInTx), so after this lock the UPDATE below — a
    // NEW statement, hence a NEW snapshot — sees any hold that committed while
    // we waited. A NOT EXISTS evaluated inside a blocked UPDATE alone would
    // not: READ COMMITTED's re-check re-reads the target row, not the subquery.
    await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [id]);
    const { rowCount } = await c.query(
      `UPDATE users
          SET email = $2, password_hash = $3, anonymised_at = now(),
              -- PM ruling B (spec §4a): a BANNED account's address is
              -- reserved by hash; the address itself is replaced, as for
              -- every account.
              reserved_email_sha256 = CASE WHEN disabled_at IS NOT NULL THEN $4 ELSE NULL END
        WHERE id = $1
          AND email = $5
          AND anonymised_at IS NULL
          AND deletion_requested_at < now() - interval '30 days'
          AND NOT EXISTS (SELECT 1 FROM account_legal_holds h
                           WHERE h.user_id = users.id AND h.released_at IS NULL)`,
      [id, scrubbedEmail(id), SCRUBBED_PASSWORD_HASH, emailSha256, email],
    );
    const changed = (rowCount ?? 0) === 1;
    if (changed) {
      await c.query(
        `UPDATE profiles
            SET username = $2, display_name = NULL, bio = NULL
          WHERE user_id = $1`,
        [id, scrubbedUsername(id)],
      );
      await c.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [id]);
    }
    await c.query("COMMIT");
    return changed;
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // A failed ROLLBACK must not replace the root error (decide.ts).
    }
    throw err;
  }
}

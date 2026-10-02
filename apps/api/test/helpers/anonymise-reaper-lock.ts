import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import { withClient } from "../../src/db/client";

/**
 * Serialises every TEST-side run of `anonymiseExpiredAccounts` across test files.
 *
 * ⚠️ WHY. Several files (this helper's callers: anonymise-accounts, barred-reentry,
 * forgot-password) run the real reaper against the SHARED test DB, in parallel
 * workers. The reaper takes the oldest 500 eligible rows, so a run in one file
 * can scrub another file's fixture. For an end-state assertion that is harmless;
 * for an assertion about WHAT ONE RUN DID it is not. Observed (2026-10-01, full
 * parallel run): RF7's run held X (locked) and Y in its batch, waited its 5 s
 * lock_timeout on X, and meanwhile barred-reentry's concurrent run scrubbed Y.
 * RF7's run then re-checked Y as already anonymised (skipped), so it scrubbed 0
 * with 1 failure and threw, exactly as production intends
 * ("anonymised 0, skipped (re-check) 2, failed 1 of 3"). A probe that started a
 * rival run before X became eligible reproduced it deterministically.
 *
 * Holding this lock around a run means no other test-side run overlaps it, so a
 * test's fixtures are processed by the run it asserts about.
 *
 * A TRANSACTION-level advisory lock (`pg_advisory_xact_lock`) on its own client,
 * held from BEGIN to COMMIT: it is released on COMMIT, ROLLBACK, or the client's
 * disconnect, so a failed test can never strand it. Production takes no advisory
 * lock (see src/notifications/email-drain.ts on why), so this cannot interact
 * with the code under test. Acquire it BEFORE making a fixture eligible when the
 * test also locks that fixture, so no other file's run can select it meanwhile.
 */
export async function withAnonymiseReaperLock<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  try {
    return await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT pg_advisory_xact_lock(hashtext('test:anonymise-accounts-reaper'))");
        const result = await fn();
        await c.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await c.query("ROLLBACK");
        } catch {
          // keep the root error
        }
        throw err;
      }
    });
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

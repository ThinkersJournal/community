// SPDX-License-Identifier: MIT OR Apache-2.0
/** Daily media-owner sweep (Worker side; the SQL and the hold rule are in ./owner-clearing.ts). */
import { withClient } from "../db/client";

import { SWEEP_BATCH, clearMediaOwnersOfAnonymisedUsers } from "./owner-clearing";

/**
 * The daily sweep, wired into the account-anonymisation cron branch
 * (src/index.ts, "40 4 * * *"). NEVER THROWS: a failure is logged and retried
 * by the next run, so it can neither fail the cron callback nor mask the
 * anonymisation run it rides with. Returns the number of rows cleared.
 */
export async function sweepMediaOwners(env: Env, ctx: ExecutionContext): Promise<number> {
  try {
    const cleared = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => clearMediaOwnersOfAnonymisedUsers(c));
    console.log(`media-owner-sweep: cleared ${cleared} (batch cap ${SWEEP_BATCH})`);
    return cleared;
  } catch (err) {
    // The message only: an error object can echo statement parameters.
    console.error(
      "media-owner-sweep: failed (retried next run)",
      err instanceof Error ? err.message : "unknown error",
    );
    return 0;
  }
}

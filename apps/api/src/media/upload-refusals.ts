// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The durable record of a refused upload (issue #148, item 3). A refusal of
 * restricted bytes is evidence, and a `console.warn` does not outlive Workers
 * log retention, so the row is the record and the log line is only a courtesy.
 *
 * ⚠️ NEVER CHANGES THE CLIENT'S ANSWER. If the INSERT fails the upload is still
 * refused (nothing was stored), and the failure is logged loudly rather than
 * turning a generic 415 into a 500 that would tell the uploader something.
 */
import { withClient } from "../db/client";

export type UploadRefusalReason = "legal_hold" | "hold_imposed_in_flight" | "restricted_unreachable";

export async function recordUploadRefusal(
  env: Env,
  ctx: ExecutionContext,
  input: { readonly r2Key: string; readonly uploaderId: string; readonly reason: UploadRefusalReason },
): Promise<void> {
  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(`INSERT INTO media_upload_refusals (r2_key, uploader_id, reason) VALUES ($1, $2, $3)`, [
        input.r2Key,
        input.uploaderId,
        input.reason,
      ]),
    );
  } catch (err) {
    console.error("media upload refusal NOT recorded", {
      ...input,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { maybeAutoHide, AUTO_HIDE_REPORTER_THRESHOLD } from "../src/moderation/auto-hide";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

/**
 * ⚠️ AC-1 — BINDING MERGE CONDITION (spec §8, §12): "A DSA notice NEVER counts
 * toward the auto-hide threshold." Three throwaway addresses must not be able
 * to hide any post on the site.
 *
 * This test is only evidence if it is shown to FAIL against an implementation
 * that counts notices — see Step 3's mutation, which the PR must report.
 */
async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  await deleteCreatedUsers();
});

async function confirmedNotices(postId: string, n: number): Promise<void> {
  await ctxRun(async (c) => {
    for (let i = 0; i < n; i++) {
      // target_kind/target_label are NOT NULL as of migration 0020's
      // round-1 addendum (SET NULL ruling) — this helper predates that
      // schema change and was missed until a round-2 full-suite run
      // surfaced it (23502 not-null violation).
      await c.query(
        `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, email_verified_at, verify_token_hash, target_kind, target_label, post_id, reason, statement)
         VALUES ($1, 'Throwaway', true, now(), $2, 'post', 'a target label', $3, 'sexual', 'illegal')`,
        [`throwaway${i}-${crypto.randomUUID()}@example.test`, crypto.randomUUID(), postId],
      );
    }
  });
}

async function memberReports(postId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const reporter = await createVerifiedActor();
    await ctxRun((c) => c.query(`INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1, $2, 'spam')`, [postId, reporter.userId]));
  }
}

async function hiddenAt(postId: string): Promise<Date | null> {
  return ctxRun(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [postId])).rows[0]!.h);
}

describe("⚠️ AC-1 — DSA notices never count toward auto-hide", () => {
  it("THREE confirmed DSA notices alone do not hide a post", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await confirmedNotices(postId, AUTO_HIDE_REPORTER_THRESHOLD);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    expect(await hiddenAt(postId)).toBeNull();
  });

  it("threshold−1 member reports + three confirmed DSA notices still do not hide it", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await memberReports(postId, AUTO_HIDE_REPORTER_THRESHOLD - 1);
    await confirmedNotices(postId, 3);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    expect(await hiddenAt(postId)).toBeNull();
  });

  it("CONTROL: threshold member reports DO hide it (proves this harness can observe a hide)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await memberReports(postId, AUTO_HIDE_REPORTER_THRESHOLD);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).not.toBeNull();
    expect(await hiddenAt(postId)).not.toBeNull();
  });
});

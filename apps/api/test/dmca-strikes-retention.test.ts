// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { eraseClosedDmcaCases, ERASED_MARKER } from "../src/moderation/dmca-retention";
import { loadDmcaStrikes, strikesFrom } from "../src/moderation/dmca-strikes";

/**
 * The repeat-infringer record and the three-year erasure (ROADMAP R9, PR 4;
 * CireSnave decision 298 A). Rows are seeded directly: the lifecycle that creates
 * them is covered by dmca-decisions.test.ts and dmca-counter.test.ts.
 */

let noticeIds: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  await ctxRun((c) => c.query(`DELETE FROM dmca_notices WHERE id = ANY($1::uuid[])`, [noticeIds]));
  noticeIds = [];
});

interface Seed {
  state: string;
  /** Age of `decided_at`, as a Postgres interval, e.g. '4 years'. */
  decidedAgo?: string;
  restoredAgo?: string;
  subject?: string;
  confirmed?: boolean;
  email?: string;
}

async function seed(o: Seed): Promise<string> {
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dmca_notices
         (complainant_email, complainant_name, complainant_address, complainant_phone, signature, work_description,
          statement_good_faith, statement_accuracy, verify_token_hash, target_kind, target_label, state,
          email_verified_at, decided_at, restored_at, subject_user_id)
       VALUES ($1, 'Jane Owner', '1 Example Street', '+1 555 0100', 'Jane Owner', 'My essay', true, true, $2,
               'post', 'a label', $3, ${o.confirmed === false ? "NULL" : "now()"},
               ${o.decidedAgo === undefined ? "NULL" : `now() - interval '${o.decidedAgo}'`},
               ${o.restoredAgo === undefined ? "NULL" : `now() - interval '${o.restoredAgo}'`}, $4)
       RETURNING id`,
      [o.email ?? `owner-${crypto.randomUUID()}@example.test`, `hash-${crypto.randomUUID()}`, o.state, o.subject ?? null],
    );
    return rows[0]!.id;
  });
  noticeIds.push(id);
  return id;
}

describe("the repeat-infringer record", () => {
  it("strikesFrom flags at the threshold, not below", () => {
    expect(strikesFrom(2)).toMatchObject({ standing: 2, threshold: 3, windowMonths: 12, flagged: false });
    expect(strikesFrom(3).flagged).toBe(true);
    expect(strikesFrom(7).flagged).toBe(true);
  });

  it("counts standing takedowns inside twelve months, and nothing else", async () => {
    const author = crypto.randomUUID();
    const other = crypto.randomUUID();
    await seed({ state: "taken_down", decidedAgo: "1 month", subject: author });
    await seed({ state: "counter_received", decidedAgo: "6 months", subject: author });
    // Do not count: restored, withdrawn and rejected notices; a takedown older than the window; another author's.
    await seed({ state: "restored", decidedAgo: "2 months", subject: author });
    await seed({ state: "withdrawn", decidedAgo: "2 months", subject: author });
    await seed({ state: "rejected", decidedAgo: "2 months", subject: author });
    await seed({ state: "taken_down", decidedAgo: "13 months", subject: author });
    await seed({ state: "taken_down", decidedAgo: "1 month", subject: other });

    const strikes = await ctxRun((c) => loadDmcaStrikes(c, author));
    expect(strikes.standing).toBe(2);
    expect(strikes.flagged).toBe(false);

    await seed({ state: "taken_down", decidedAgo: "2 days", subject: author });
    const flagged = await ctxRun((c) => loadDmcaStrikes(c, author));
    expect(flagged.standing).toBe(3);
    expect(flagged.flagged).toBe(true);
  });
});

describe("eraseClosedDmcaCases", () => {
  async function erase(): Promise<number> {
    const ctx = createExecutionContext();
    const n = await eraseClosedDmcaCases(env, ctx);
    await waitOnExecutionContext(ctx);
    return n;
  }

  const row = (id: string) =>
    ctxRun(async (c) =>
      (await c.query<{ complainant_email: string; complainant_name: string; signature: string; work_description: string; state: string; subject_user_id: string | null }>(
        `SELECT complainant_email, complainant_name, signature, work_description, state, subject_user_id FROM dmca_notices WHERE id = $1`,
        [id],
      )).rows[0]!,
    );

  it("erases cases closed more than three years ago, keeps the rest, and keeps the outcome of the erased", async () => {
    const author = crypto.randomUUID();
    const rejectedOld = await seed({ state: "rejected", decidedAgo: "4 years", subject: author });
    const restoredOld = await seed({ state: "restored", decidedAgo: "5 years", restoredAgo: "4 years", subject: author });
    const takenDownOld = await seed({ state: "taken_down", decidedAgo: "3 years 100 days", subject: author });
    // Open or recent: kept.
    const rejectedRecent = await seed({ state: "rejected", decidedAgo: "2 years" });
    const takenDownInWindow = await seed({ state: "taken_down", decidedAgo: "3 years 10 days" });
    const counterWaiting = await seed({ state: "counter_received", decidedAgo: "4 years" });
    const pending = await seed({ state: "pending" });

    // The restored case also has a counter-notice with the author's details.
    await ctxRun((c) =>
      c.query(
        `INSERT INTO dmca_counter_notices (notice_id, author_name, author_address, author_phone, signature, statement_mistake, consent_jurisdiction)
         VALUES ($1, 'A. Author', '2 Example Road', '+1 555 0101', 'A. Author', true, true)`,
        [restoredOld],
      ),
    );

    expect(await erase()).toBeGreaterThanOrEqual(3);

    for (const id of [rejectedOld, restoredOld, takenDownOld]) {
      const r = await row(id);
      expect(r.complainant_email).toBe(ERASED_MARKER);
      expect(r.complainant_name).toBe(ERASED_MARKER);
      expect(r.signature).toBe(ERASED_MARKER);
      expect(r.work_description).toBe(ERASED_MARKER);
      // The outcome and the strike key stay.
      expect(r.subject_user_id).toBe(author);
    }
    expect((await row(rejectedOld)).state).toBe("rejected");
    expect((await row(restoredOld)).state).toBe("restored");
    expect((await row(takenDownOld)).state).toBe("taken_down");
    const counter = await ctxRun(async (c) =>
      (await c.query<{ author_name: string; author_address: string; author_phone: string }>(
        `SELECT author_name, author_address, author_phone FROM dmca_counter_notices WHERE notice_id = $1`, [restoredOld],
      )).rows[0]!,
    );
    expect(counter).toEqual({ author_name: ERASED_MARKER, author_address: ERASED_MARKER, author_phone: ERASED_MARKER });

    for (const id of [rejectedRecent, takenDownInWindow, counterWaiting, pending]) {
      expect((await row(id)).complainant_name).toBe("Jane Owner");
    }
  });

  it("is idempotent: a second run erases nothing more", async () => {
    await seed({ state: "rejected", decidedAgo: "4 years" });
    await erase();
    // Only rows that are not already erased can match; other tests' leftovers aside, this id is done.
    const again = await ctxRun(async (c) =>
      (await c.query(`SELECT 1 FROM dmca_notices WHERE id = ANY($1::uuid[]) AND complainant_email <> $2`, [noticeIds, ERASED_MARKER])).rowCount,
    );
    expect(again).toBe(0);
  });
});

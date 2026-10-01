import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { sha256Hex } from "../src/auth/encoding";
import { withClient } from "../src/db/client";
import { reapUnconfirmedDsaNotices } from "../src/moderation/dsa-notices";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

/**
 * Task 3 (DSA notice intake, plan C of #113) — confirmation (GET peeks, POST
 * redeems) and the unconfirmed-notice reaper.
 *
 * Fixtures seed `dsa_notices` rows DIRECTLY with a known plaintext token (never
 * through `POST /dsa-notice`, which mails the token rather than returning it),
 * same reasoning as test/reap-unverified.test.ts's `seed` — the route under
 * test is what is under test.
 *
 * Runs in the POOL project (real workerd) against the real Hyperdrive/Postgres
 * binding, same shape as test/reap-unverified.test.ts / test/dsa-ac1.test.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

/** Every dsa_notices id this suite seeds directly, for afterEach cleanup. */
const createdNoticeIds: string[] = [];

/** Seed a dsa_notices row against `postId`, backdated `ageDays` old, with a
 * KNOWN plaintext token (the suite hashes it the same way createDsaNotice does). */
async function seedNotice(opts: {
  postId: string;
  ageDays: number;
  confirmed?: boolean;
}): Promise<{ id: string; token: string }> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const hash = await sha256Hex(token);
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, email_verified_at, verify_token_hash, post_id, reason, statement, created_at)
       VALUES ($1, 'Reporter', true, $2, $3, $4, 'spam', 'illegal', now() - ($5 || ' days')::interval)
       RETURNING id`,
      [
        `confirm-${crypto.randomUUID()}@example.test`,
        opts.confirmed === true ? new Date() : null,
        hash,
        opts.postId,
        String(opts.ageDays),
      ],
    );
    return rows[0]!.id;
  });
  createdNoticeIds.push(id);
  return { id, token };
}

async function noticeEmailVerifiedAt(id: string): Promise<Date | null | undefined> {
  return ctxRun(
    async (c) =>
      (await c.query<{ v: Date | null }>(`SELECT email_verified_at AS v FROM dsa_notices WHERE id = $1`, [id]))
        .rows[0]?.v,
  );
}

async function noticeExists(id: string): Promise<boolean> {
  return ctxRun(async (c) => (await c.query(`SELECT 1 FROM dsa_notices WHERE id = $1`, [id])).rowCount === 1);
}

function getConfirmRequest(token: string): Request {
  return new Request(`https://api.test/dsa-notice/confirm?token=${encodeURIComponent(token)}`);
}

function postConfirmRequest(body: Record<string, unknown>, opts?: { noOrigin?: boolean }): Request {
  return new Request("https://api.test/dsa-notice/confirm", {
    method: "POST",
    headers: {
      ...(opts?.noOrigin === true ? {} : { Origin: ALLOWED_ORIGIN }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await deleteCreatedUsers();
  if (createdNoticeIds.length > 0) {
    await ctxRun((c) => c.query(`DELETE FROM dsa_notices WHERE id = ANY($1::uuid[])`, [createdNoticeIds]));
    createdNoticeIds.length = 0;
  }
});

describe("GET /dsa-notice/confirm", () => {
  it("peeks three times, each 200 { ok: true }, and never confirms", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const { id, token } = await seedNotice({ postId, ageDays: 1 });

    for (let i = 0; i < 3; i++) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(getConfirmRequest(token), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }

    expect(await noticeEmailVerifiedAt(id)).toBeNull();
  });

  it("400s INVALID_TOKEN for an unknown token", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(getConfirmRequest(crypto.randomUUID()), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("400s INVALID_TOKEN for a notice older than 7 days, even though the reaper hasn't run", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const { id, token } = await seedNotice({ postId, ageDays: 8 });

    const ctx = createExecutionContext();
    const response = await worker.fetch(getConfirmRequest(token), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
    // The row is still there — only the WINDOW rejected it, not a reap.
    expect(await noticeExists(id)).toBe(true);
  });
});

describe("POST /dsa-notice/confirm", () => {
  it("confirms once; a second POST 400s INVALID_TOKEN; reports/hidden_at are unchanged (AC-1, confirm half)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const { id, token } = await seedNotice({ postId, ageDays: 1 });

    const ctx1 = createExecutionContext();
    const first = await worker.fetch(postConfirmRequest({ token }), env, ctx1);
    await waitOnExecutionContext(ctx1);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({});
    expect(await noticeEmailVerifiedAt(id)).not.toBeNull();

    const ctx2 = createExecutionContext();
    const second = await worker.fetch(postConfirmRequest({ token }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ code: "INVALID_TOKEN" });

    // AC-1, confirm half: confirming a notice never writes `reports` or
    // `hidden_at` — see src/moderation/dsa-notices.ts's confirmDsaNotice header.
    const reportCount = await ctxRun(
      async (c) =>
        Number(
          (await c.query<{ n: string }>(`SELECT count(*) AS n FROM reports WHERE post_id = $1`, [postId])).rows[0]!
            .n,
        ),
    );
    expect(reportCount).toBe(0);
    const hiddenAt = await ctxRun(
      async (c) =>
        (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [postId])).rows[0]!.h,
    );
    expect(hiddenAt).toBeNull();
  });

  it("400s INVALID_TOKEN for an unknown token", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(postConfirmRequest({ token: crypto.randomUUID() }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("400s INVALID_TOKEN for a notice older than 7 days", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const { token } = await seedNotice({ postId, ageDays: 8 });

    const ctx = createExecutionContext();
    const response = await worker.fetch(postConfirmRequest({ token }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("403s an origin-less request (same inline checkOrigin as the intake route)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      postConfirmRequest({ token: crypto.randomUUID() }, { noOrigin: true }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });
});

describe("reapUnconfirmedDsaNotices", () => {
  it("deletes an unconfirmed notice backdated 8 days, keeps one at 6 days, and keeps a CONFIRMED one backdated 30 days", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);

    const old = await seedNotice({ postId, ageDays: 8 });
    const recent = await seedNotice({ postId, ageDays: 6 });
    const confirmedOld = await seedNotice({ postId, ageDays: 30, confirmed: true });

    const ctx = createExecutionContext();
    await reapUnconfirmedDsaNotices(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await noticeExists(old.id)).toBe(false);
    expect(await noticeExists(recent.id)).toBe(true);
    expect(await noticeExists(confirmedOld.id)).toBe(true);
  });
});

describe("the scheduled dispatcher", () => {
  it('routes cron "30 3 * * *" to the DSA reaper as well as the account reaper', async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const old = await seedNotice({ postId, ageDays: 8 });

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: "30 3 * * *", scheduledTime: Date.now(), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Proof the DSA reaper ran (alongside the account reaper): the notice
    // seeded ONLY for this cron branch is gone.
    expect(await noticeExists(old.id)).toBe(false);
  });
});

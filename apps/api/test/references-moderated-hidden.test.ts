// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { applyDecision } from "../src/moderation/decide";
import { takedownDmcaNotice } from "../src/moderation/dmca-decisions";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Client } from "pg";
import type { Actor } from "./actor";

/**
 * M3.10 slice A: a post taken out of public view by a MODERATOR (decide.ts `remove`, which sets `hidden_at`) or by the
 * DMCA takedown path (which runs the very same `applyDecisionInTx`) is a public 404 that serves no `refs` and no card
 * text (spec 2026-11-09-m3-connector-contract.md section 4: "a post's removal or hide hides its cards").
 *
 * Each arm has its CONTROL: the same post answers 200 with its card BEFORE the decision, so a 404 is caused by the
 * decision and not by a broken fixture. Mutation that must fail every arm: drop `hidden_at IS NULL` from the public query.
 */
const ALLOWED_ORIGIN = "http://localhost:8787";
const TOKEN = "ABCDEFGHIJKL";
const CARD_TITLE = "Moderated card title";
const ADMIN = "mod-hidden-test@example.test";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const value = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return value;
}

const referenceIds: string[] = [];
const noticeIds: string[] = [];
let actor: Actor;

beforeAll(async () => {
  actor = await createVerifiedActor();
});

afterEach(async () => {
  // Notices first (SET NULL keeps them past their target), then the queued emails (no FK to users).
  await run(async (c) => {
    await c.query(`DELETE FROM dmca_notices WHERE id = ANY($1::uuid[])`, [noticeIds]);
    await c.query(
      `DELETE FROM moderation_notice_outbox
        WHERE recipient_user_id = $1
           OR action_id IN (SELECT id FROM moderation_actions WHERE subject_user_id = $1)`,
      [actor.userId],
    );
  });
  noticeIds.length = 0;
});

afterAll(async () => {
  await deleteCreatedUsers();
  await run((c) => c.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]));
});

/** A published post carrying one reference card, fixtures made as references-public-post.test.ts makes them. */
async function postWithCard(): Promise<{ id: string; slug: string }> {
  const response = await fetchWorker(
    new Request("https://api.test/posts", {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "Moderated", markdownSource: `Intro\n\n{{ref:${TOKEN}}}\n`, status: "published" }),
    }),
  );
  if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  const post = (await response.json()) as { id: string; slug: string };
  await run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO "references" (kind, resource_key, content_hash, snapshot) VALUES ('web', $1, $2, $3) RETURNING id`,
      [
        `web:https://example.com/${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify({ kind: "web", title: CARD_TITLE, finalUrl: "https://example.com/p" }),
      ],
    );
    referenceIds.push(rows[0]!.id);
    await c.query("INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, $3)", [post.id, rows[0]!.id, TOKEN]);
  });
  return post;
}

function getPost(slug: string): Promise<Response> {
  return fetchWorker(new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`));
}

async function expectPublic404WithNoCards(slug: string): Promise<void> {
  const response = await getPost(slug);
  expect(response.status).toBe(404);
  const body = await response.text();
  expect(body).not.toContain(CARD_TITLE);
  expect(body).not.toContain("refs");
  expect(body).not.toContain("example.com/p");
}

describe("a moderated post serves no reference cards", () => {
  it("moderator remove (decide.ts) sets hidden_at and the public read is a 404 with no refs or card text", async () => {
    const { id, slug } = await postWithCard();
    const control = await getPost(slug);
    expect(control.status).toBe(200);
    expect(await control.text()).toContain(CARD_TITLE);

    const result = await run((c) =>
      applyDecision(c, { subject: "post", subjectId: id, decision: "remove", reason: "test removal", actorAdmin: ADMIN }),
    );
    expect(result?.hidden).toBe(true);
    const hiddenAt = await run(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [id])).rows[0]!.h);
    expect(hiddenAt).not.toBeNull();

    await expectPublic404WithNoCards(slug);
  });

  it("moderator keep_hidden is the same: 404, no cards", async () => {
    const { id, slug } = await postWithCard();
    expect((await getPost(slug)).status).toBe(200); // control
    await run((c) => applyDecision(c, { subject: "post", subjectId: id, decision: "keep_hidden", reason: "test", actorAdmin: ADMIN }));
    await expectPublic404WithNoCards(slug);
  });

  it("the DMCA takedown path sets hidden_at the same way: 404, no refs or card text", async () => {
    const { id, slug } = await postWithCard();
    expect((await getPost(slug)).status).toBe(200); // control
    const noticeId = await run(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO dmca_notices
           (complainant_email, complainant_name, complainant_address, complainant_phone, signature, work_description,
            statement_good_faith, statement_accuracy, verify_token_hash, target_kind, target_label, post_id, email_verified_at)
         VALUES ($1, 'Jane Owner', '1 Example Street', '+1 555 0100', 'Jane Owner', 'My essay On Boats',
                 true, true, $2, 'post', 'a label', $3, now())
         RETURNING id`,
        [`claimant-${crypto.randomUUID()}@example.test`, `hash-${crypto.randomUUID()}`, id],
      );
      return rows[0]!.id;
    });
    noticeIds.push(noticeId);

    const outcome = await run((c) => takedownDmcaNotice(c, { noticeId, actorAdmin: ADMIN, origin: "https://community.test" }));
    expect(outcome.kind).toBe("ok");
    const hiddenAt = await run(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [id])).rows[0]!.h);
    expect(hiddenAt).not.toBeNull();

    await expectPublic404WithNoCards(slug);
  });

  it("CONTROL: a restore after a remove makes the card reachable again", async () => {
    const { id, slug } = await postWithCard();
    await run((c) => applyDecision(c, { subject: "post", subjectId: id, decision: "remove", reason: "x", actorAdmin: ADMIN }));
    expect((await getPost(slug)).status).toBe(404);
    await run((c) => applyDecision(c, { subject: "post", subjectId: id, decision: "restore", reason: "x", actorAdmin: ADMIN }));
    const restored = await getPost(slug);
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain(CARD_TITLE);
  });
});

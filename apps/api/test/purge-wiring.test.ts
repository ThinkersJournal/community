import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import {
  createPostRequest,
  createPublished,
  createVerifiedActor,
  deleteCreatedUsers,
  patchPostRequest,
} from "./actor";

import type { Actor } from "./actor";

/**
 * ⚠️ THE HANDLERS MUST ACTUALLY PURGE. test/purge.test.ts proves purgeTags sends
 * the right request; NOTHING there proves a handler ever calls it. That gap is
 * the silent one: a create/edit that skips the purge passes every posts test,
 * every type check, and every local run (where there may be no edge cache at
 * all) — and ships content that is stale for a full maxAge+swr window (25h).
 *
 * The `WEB` Service Binding is stubbed so the call is observable. ⚠️ The real
 * cross-Worker dispatch is NOT covered by the E2E today: its only authoring flow
 * creates DRAFTS (new-post.astro sends no `status`), which purge nothing by
 * design. See test/purge.test.ts's header for exactly what is and is not proven.
 *
 * ⚠️ WHAT THE "purges NOTHING" CASES ARE WORTH. A test that asserts an empty
 * array passes just as happily when the wiring is deleted entirely — so on its
 * own it proves nothing. Two things earn them: the POSITIVE cases below share
 * `fetchCapturingPurges` and the same request builders, so the harness is proven
 * able to SEE a purge; and the 404 case is pinned by a deliberate mutation
 * (moving the purge above the ownership check reddens it — see the task report).
 */
let actor: Actor;

/**
 * A verified actor who has ALSO chosen a handle (so Task 8's publish-username
 * gate passes). Every case here publishes through the real API, so a fixture
 * must be past that gate already — mirroring test/follows.test.ts's
 * `onboardedActor()`.
 */
async function onboardedActor(): Promise<Actor> {
  const created = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [created.userId]),
  );
  await waitOnExecutionContext(ctx);
  return created;
}

/** Drive the Worker with a stubbed WEB binding, capturing every purge call. */
async function fetchCapturingPurges(
  request: Request,
): Promise<{ response: Response; purges: string[][] }> {
  const purges: string[][] = [];
  const web = {
    fetch: async (_url: string, init: RequestInit) => {
      purges.push((JSON.parse(init.body as string) as { tags: string[] }).tags);
      return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
    },
  };
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, WEB: web } as never, ctx);
  await waitOnExecutionContext(ctx);
  return { response, purges };
}

beforeAll(async () => {
  actor = await onboardedActor();
});

afterAll(deleteCreatedUsers);

describe("POST /posts purges on publish", () => {
  it("publishing purges author + listing in ONE call", async () => {
    const { response, purges } = await fetchCapturingPurges(createPostRequest(actor, "published"));
    expect(response.status).toBe(201);

    // ⚠️ ONE call, not one per tag. The Free-zone purge limit is 5 requests per
    // MINUTE — a call per tag spends an author's whole budget in under two edits.
    expect(purges).toHaveLength(1);
    // No `post:` tag: nothing has ever been cached for a post that did not exist
    // until now.
    expect(purges[0]).toEqual([`author:${actor.userId}`, "listing"]);
  });

  it("saving a DRAFT purges NOTHING", async () => {
    // A draft is not in any cached listing, so purging would spend a scarce
    // quota to invalidate nothing.
    const { response, purges } = await fetchCapturingPurges(createPostRequest(actor, "draft"));
    expect(response.status).toBe(201);
    expect(purges).toHaveLength(0);
  });
});

describe("PATCH /posts/:id purges on edit", () => {
  it("editing purges post + author + listing in ONE call", async () => {
    const id = await createPublished(actor);
    const { response, purges } = await fetchCapturingPurges(
      patchPostRequest(actor, id, "published"),
    );
    expect(response.status).toBe(200);
    expect(purges).toHaveLength(1);
    expect(purges[0]).toEqual([`post:${id}`, `author:${actor.userId}`, "listing"]);
  });

  it("a 404 edit (another author's post) purges NOTHING", async () => {
    // ⚠️ THE QUOTA-BURN VECTOR. The purge must sit AFTER the ownership check, or
    // any caller could burn the 5/min purge budget for a post they cannot touch —
    // by PATCHing ids they do not own, at no cost to themselves.
    const id = await createPublished(actor);
    // Onboarded: a `status: "published"` PATCH gates on the SESSION's own
    // username_chosen (Task 8) before the ownership check in the UPDATE's WHERE
    // clause ever runs. An un-onboarded attacker would 409 for that unrelated
    // reason, never reaching the 404 this case exists to pin.
    const attacker = await onboardedActor();
    const { response, purges } = await fetchCapturingPurges(
      patchPostRequest(attacker, id, "published"),
    );
    expect(response.status).toBe(404);
    expect(purges).toHaveLength(0);
  });
});

function createCommentRequest(actor: Actor, postId: string): Request {
  return new Request("https://api.test/comments", {
    method: "POST",
    headers: {
      Origin: "http://localhost:8787",
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ postId, markdownSource: "purge probe" }),
  });
}

describe("POST /comments purges the post page", () => {
  it("a comment purges post:<id> in ONE call", async () => {
    const postId = await createPublished(actor);
    const { response, purges } = await fetchCapturingPurges(createCommentRequest(actor, postId));
    expect(response.status).toBe(201);
    expect(purges).toHaveLength(1);
    expect(purges[0]).toEqual([`post:${postId}`]);
  });

  it("a rejected comment (draft post) purges NOTHING", async () => {
    const { response: draft } = await fetchCapturingPurges(createPostRequest(actor, "draft"));
    const draftId = ((await draft.json()) as { id: string }).id;
    const { response, purges } = await fetchCapturingPurges(createCommentRequest(actor, draftId));
    expect(response.status).toBe(404);
    expect(purges).toHaveLength(0);
  });
});

describe("a purge failure NEVER fails the write", () => {
  it("still 200s when the purge hop rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await createPublished(actor);
    const web = { fetch: async () => new Response("nope", { status: 403 }) };
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      patchPostRequest(actor, id, "published"),
      { ...env, WEB: web } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // ⚠️ THE POST IS ALREADY COMMITTED by the time the purge runs. Turning a
    // saved edit into a 500 because an invalidation failed would lose the user's
    // work over a cache. The cost is that the failure is SILENT to the user —
    // which is why alerting on `cache purge` is a deploy-gate item.
    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import {
  createPostRequest,
  createPublished,
  createVerifiedActor,
  deleteCreatedUsers,
  getPostRequest,
  patchPostRequest,
} from "./actor";

import type { Actor } from "./actor";
import type { TagRef } from "@thinkersjournal/shared";

/**
 * M2.4c Task 3 — tags thread through POST /posts + PATCH /posts/:id, persist in
 * the held connection, and come back on GET /posts/:id.
 *
 * Drives the Worker directly (real `env`, whose WEB stub 200s), mirroring
 * test/posts.test.ts's `fetchWorker` idiom. The PURGE shapes are pinned
 * separately in test/purge-wiring.test.ts; this file is about PERSISTENCE.
 */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A verified actor — every account already has a handle from signup. */
async function onboardedActor(): Promise<Actor> {
  return createVerifiedActor();
}

async function tagsOf(actor: Actor, id: string): Promise<TagRef[]> {
  const got = await fetchWorker(getPostRequest(actor, id));
  expect(got.status).toBe(200);
  return ((await got.json()) as { tags: TagRef[] }).tags;
}

let actor: Actor;

beforeAll(async () => {
  actor = await onboardedActor();
});

afterAll(deleteCreatedUsers);

describe("tags on create/edit", () => {
  it("persists tags on publish and returns them on GET /posts/:id", async () => {
    const create = await fetchWorker(createPostRequest(actor, "published", { tags: ["Rust", "web-dev"] }));
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };
    const tags = await tagsOf(actor, id);
    expect(tags.map((t) => t.slug).sort()).toEqual(["rust", "web-dev"]);
    // The FIRST writer's display casing is kept as the label.
    expect(tags.find((t) => t.slug === "rust")?.label).toBe("Rust");
  });

  it("editing to a different tag set REPLACES the old tags", async () => {
    const id = await createPublished(actor, { tags: ["old-a", "old-b"] });
    expect((await tagsOf(actor, id)).map((t) => t.slug).sort()).toEqual(["old-a", "old-b"]);

    const edit = await fetchWorker(patchPostRequest(actor, id, "published", { tags: ["new-c"] }));
    expect(edit.status).toBe(200);
    expect((await tagsOf(actor, id)).map((t) => t.slug)).toEqual(["new-c"]);
  });

  it("an edit that omits tags clears them (UpdatePostInput defaults [])", async () => {
    const id = await createPublished(actor, { tags: ["temporary"] });
    expect((await tagsOf(actor, id)).map((t) => t.slug)).toEqual(["temporary"]);

    // patchPostRequest with no opts sends a body WITHOUT a `tags` key → schema
    // default `[]` → tags cleared. Intended: the editor always submits the field.
    const edit = await fetchWorker(patchPostRequest(actor, id, "published"));
    expect(edit.status).toBe(200);
    expect(await tagsOf(actor, id)).toEqual([]);
  });

  it("dedupes case-insensitively and normalizes to slugs", async () => {
    // "Rust" and "rust" are one slug; the first label wins.
    const id = await createPublished(actor, { tags: ["Rust", "rust", "Web Dev"] });
    const tags = await tagsOf(actor, id);
    expect(tags.map((t) => t.slug).sort()).toEqual(["rust", "web-dev"]);
    expect(tags.find((t) => t.slug === "rust")?.label).toBe("Rust");
  });

  it("drops a label with no [a-z0-9] content (no 'post' fallback)", async () => {
    // slugify's ""→"post" fallback must NOT leak into tags: a non-Latin label
    // has no usable slug and persists ZERO tags (this drives normalizeTags via
    // the route — the module-private helper is asserted through its effect).
    const id = await createPublished(actor, { tags: [" 汉字 "] });
    expect(await tagsOf(actor, id)).toEqual([]);
  });

  it("400s on more than 5 tags", async () => {
    // The Zod schema caps at 5 (max(5)); a 6th is INVALID_INPUT, not silently
    // truncated at the route.
    const response = await fetchWorker(
      createPostRequest(actor, "published", { tags: ["a", "b", "c", "d", "e", "f"] }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("400s on an empty-string tag", async () => {
    // Each tag is min(1) after trim; a "" (or all-whitespace) tag is rejected.
    const response = await fetchWorker(
      createPostRequest(actor, "published", { tags: ["ok", "   "] }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });
});

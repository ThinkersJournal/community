import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { slugify } from "../src/routes/posts";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * Task 9 — the AUTHOR-facing post routes: POST /posts, PATCH /posts/:id,
 * GET /posts/:id.
 *
 * ⚠️ THIS FILE IS ABOUT AUTHORSHIP AND OWNERSHIP, NOT ABOUT THE AUTH SPINE. The
 * auth-shaped assertions (no Origin -> 403, no session -> 401) are covered
 * STRUCTURALLY by test/route-protection.test.ts, which enumerates src/routes.ts:
 * `POST /posts` and `PATCH /posts/:id` are held to them the moment they are
 * registered, with no edit there. What lives HERE is what that file cannot know:
 * that author_id comes from the session, that a non-owner cannot edit, and that
 * a published URL never moves.
 */

/** An origin in `checkOrigin`'s allowlist (src/auth/csrf.ts). */
const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface PostPayload {
  title: string;
  markdownSource: string;
  status?: string;
}

function createPost(actor: Actor, payload: PostPayload): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/posts", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
}

function patchPost(actor: Actor, id: string, payload: PostPayload): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/posts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * A verified actor. Named `onboardedActor` (kept, not renamed, to hold this
 * file's diff to the handle-at-signup cleanup), mirroring
 * test/follows.test.ts's helper of the same name — see its comment for why a
 * plain verified actor is now enough (the handle comes from signup; there is
 * no more separate onboarding step to publish through).
 */
async function onboardedActor(): Promise<Actor> {
  return createVerifiedActor();
}

function getPost(actor: Actor, id: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/posts/${encodeURIComponent(id)}`, {
      headers: { Cookie: actor.cookie },
    }),
  );
}

/** Create a post and return its id + slug, failing loudly if it did not work. */
async function create(actor: Actor, payload: PostPayload): Promise<{ id: string; slug: string }> {
  const response = await createPost(actor, payload);
  if (response.status !== 201) {
    throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { id: string; slug: string };
}

interface PostRow {
  author_id: string;
  title: string;
  slug: string;
  markdown_source: string;
  status: string;
  published_at: Date | null;
  updated_at: Date;
}

/** The row as the DATABASE holds it — the assertions that must not go via the API. */
async function postRow(id: string): Promise<PostRow> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<PostRow>("SELECT * FROM posts WHERE id = $1", [id]);
    return rows[0] ?? null;
  });
  await waitOnExecutionContext(ctx);
  if (row === null) throw new Error(`no post row for ${id}`);
  return row;
}

async function authorOf(id: string): Promise<string> {
  return (await postRow(id)).author_id;
}

let actor: Actor;

beforeAll(async () => {
  actor = await onboardedActor();
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("POST /posts", () => {
  it("creates a draft owned by the SESSION's user", async () => {
    const response = await createPost(actor, { title: "Hello world", markdownSource: "# hi" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; slug: string; status: string; username: string };
    expect(body.slug).toBe("hello-world");
    expect(body.status).toBe("draft");
    expect(body.id[14]).toBe("7"); // uuidv7 PK
    expect(await authorOf(body.id)).toBe(actor.userId);
  });

  /**
   * ⚠️ T17's editor redirects a successful PUBLISH to `/@<username>/<slug>` —
   * the `web` Worker has no session of its own, so it cannot compute this
   * itself. It must come from the SAME handler that already resolved
   * `authorId` from the session (never trust a caller-supplied username).
   */
  it("returns the AUTHOR's username alongside id/slug — the editor's redirect needs it", async () => {
    const response = await createPost(actor, { title: "Byline", markdownSource: "x" });
    const body = (await response.json()) as { username: string };
    expect(body.username).toBe(actor.username);
  });

  /**
   * ⚠️ THE CENTRAL AUTHORSHIP PROPERTY. `CreatePostInput` has no `authorId`
   * field, so this is unrepresentable rather than merely unused — but that is a
   * claim about a schema, and this is the case that proves the HANDLER honors it.
   */
  it("NEVER takes author_id from the body", async () => {
    const victim = await createVerifiedActor();
    const response = await createPost(actor, {
      title: "Spoof",
      markdownSource: "x",
      // @ts-expect-error — deliberately sending a field the schema does not have
      authorId: victim.userId,
    });
    const { id } = (await response.json()) as { id: string };
    expect(await authorOf(id)).toBe(actor.userId);
  });

  it("publishes with a published_at when status=published", async () => {
    const response = await createPost(actor, {
      title: "Live",
      markdownSource: "x",
      status: "published",
    });
    const { id } = (await response.json()) as { id: string };
    const row = await postRow(id);
    expect(row.status).toBe("published");
    expect(row.published_at).not.toBeNull();
  });

  it("uniquifies a slug that collides for the SAME author", async () => {
    await createPost(actor, { title: "Same Title", markdownSource: "a" });
    const second = await createPost(actor, { title: "Same Title", markdownSource: "b" });
    expect(second.status).toBe(201);
    const { slug } = (await second.json()) as { slug: string };
    expect(slug).toMatch(/^same-title-[a-z0-9]+$/);
  });

  it("lets a DIFFERENT author keep the same slug", async () => {
    // The unique index is (author_id, slug), not (slug): one author's title must
    // never consume the URL space of every other author.
    const other = await createVerifiedActor();
    await createPost(actor, { title: "Shared Title", markdownSource: "a" });
    const second = await createPost(other, { title: "Shared Title", markdownSource: "b" });
    expect(((await second.json()) as { slug: string }).slug).toBe("shared-title");
  });

  it.each([
    ["an empty title", { title: "", markdownSource: "x" }],
    ["an empty body", { title: "t", markdownSource: "" }],
    ["an over-long title", { title: "a".repeat(201), markdownSource: "x" }],
    ["an unknown status", { title: "t", markdownSource: "x", status: "deleted" }],
  ])("400s on %s", async (_name, payload) => {
    const response = await createPost(actor, payload as PostPayload);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("403s for an UNVERIFIED author (the soft gate)", async () => {
    const unverified = await createUnverifiedActor();
    const response = await createPost(unverified, { title: "t", markdownSource: "x" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });
});

describe("PATCH /posts/:id", () => {
  it("edits the author's own post and bumps updated_at", async () => {
    const { id } = await create(actor, { title: "Before", markdownSource: "a" });
    const before = await postRow(id);
    const response = await patchPost(actor, id, {
      title: "After",
      markdownSource: "b",
      status: "published",
    });
    expect(response.status).toBe(200);
    const after = await postRow(id);
    expect(after.title).toBe("After");
    expect(after.published_at).not.toBeNull();
    expect(after.updated_at > before.updated_at).toBe(true);
    // Same reasoning as POST /posts: the editor's publish redirect needs it.
    expect(((await response.json()) as { username: string }).username).toBe(actor.username);
  });

  /**
   * ⚠️ THE CENTRAL AUTHORIZATION PROPERTY — a non-owner cannot edit another
   * author's post. Both halves matter: the STATUS (404, never 403 — a 403 would
   * confirm the id names a real post) and the ROW (the edit did not land).
   * Ownership is enforced IN the UPDATE's WHERE clause, so there is no check to
   * race.
   */
  it("404s on ANOTHER author's post — never 403", async () => {
    const { id } = await create(actor, { title: "Mine", markdownSource: "a" });
    const attacker = await onboardedActor();
    const response = await patchPost(attacker, id, {
      title: "Yours",
      markdownSource: "b",
      status: "published",
    });
    expect(response.status).toBe(404);
    expect((await postRow(id)).title).toBe("Mine");
  });

  it("404s on a well-formed but unknown id", async () => {
    const response = await patchPost(actor, "00000000-0000-7000-8000-000000000000", {
      title: "x",
      markdownSource: "y",
      status: "draft",
    });
    expect(response.status).toBe(404);
  });

  it("does NOT change the slug when the title changes", async () => {
    const { id, slug } = await create(actor, { title: "Original Title", markdownSource: "a" });
    await patchPost(actor, id, {
      title: "Completely New",
      markdownSource: "a",
      status: "published",
    });
    // A published URL is a promise. Re-slugging on edit would 404 every inbound
    // link and every cached copy at once.
    expect((await postRow(id)).slug).toBe(slug);
  });

  it("keeps the ORIGINAL published_at across re-publishes", async () => {
    const { id } = await create(actor, { title: "P", markdownSource: "a", status: "published" });
    const first = (await postRow(id)).published_at;
    await patchPost(actor, id, { title: "P", markdownSource: "b", status: "published" });
    expect((await postRow(id)).published_at).toEqual(first);
  });

  /**
   * A malformed id is the CLIENT's error. Without the 22P02 handler this is a
   * 500: `WHERE id = 'not-a-uuid'` throws in Postgres before it can match nothing.
   */
  it("404s a malformed id rather than 500ing", async () => {
    const response = await patchPost(actor, "not-a-uuid", {
      title: "x",
      markdownSource: "y",
      status: "draft",
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /posts/:id (the author's own draft)", () => {
  it("returns the author's own draft", async () => {
    const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
    const response = await getPost(actor, id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { markdownSource: string }).markdownSource).toBe("secret");
  });

  /** An author's unpublished text is per-author: it must never reach a shared cache. */
  it("is never cacheable", async () => {
    const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
    const response = await getPost(actor, id);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("404s another author's draft", async () => {
    const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
    expect((await getPost(await createVerifiedActor(), id)).status).toBe(404);
  });

  it("401s with no session", async () => {
    const { id } = await create(actor, { title: "Draft", markdownSource: "secret" });
    expect((await fetchWorker(new Request(`https://api.test/posts/${id}`))).status).toBe(401);
  });
});

/**
 * Pure-unit guard for `slugify`'s accent-folding (src/routes/posts.ts). NFKD
 * splits an accented letter into base + a U+0300–U+036F combining mark; the strip
 * drops ONLY the mark, so the base letter survives ("café" -> "cafe", never
 * "caf"). Pinned because the character range is a silent-break magnet — an editor
 * re-normalizing the source, or the `̀-ͯ` escapes being "tidied" back
 * into raw invisible marks, would degrade folding with nothing here to catch it.
 */
describe("slugify — accent folding", () => {
  it('folds "Café" to "cafe" (mark dropped, base letter kept)', () => {
    expect(slugify("Café")).toBe("cafe");
  });

  it("folds multiple accented words and hyphenates the spaces", () => {
    expect(slugify("Crème Brûlée")).toBe("creme-brulee");
  });

  it("folds mixed diacritics without dropping any base letter", () => {
    expect(slugify("Naïve résumé over Zürich")).toBe("naive-resume-over-zurich");
  });

  it('falls back to "post" for an all-non-Latin title', () => {
    expect(slugify("日本語")).toBe("post");
  });
});

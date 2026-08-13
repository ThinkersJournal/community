import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";
import type { PublicPost, PublicProfile } from "@thinkersjournal/shared";

/**
 * Task 9 — the ANONYMOUS public reads: GET /public/posts, /public/profile,
 * /public/recent.
 *
 * ⚠️ THE PROPERTY THIS FILE EXISTS FOR IS VIEWER-INDEPENDENCE. These routes are
 * the ones the edge caches (Task 12), and Cookie is NOT in the Workers Cache key
 * and does NOT trigger bypass — so ANY per-viewer variance here becomes content
 * cached under one viewer's identity and served to everyone. The draft case
 * below sends the AUTHOR'S OWN COOKIE and still demands a 404. If a future change
 * makes these routes read a session, that case is what goes red.
 *
 * M2.4c Task 5 added `tags`: the tagged-post cases below create through the
 * REAL `POST /posts` route (Task 3 already threads `tags` through create), so
 * the fixture exercises the same normalize/persist path every author uses,
 * not a hand-rolled `post_tags` row.
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
  tags?: string[];
}

async function create(actor: Actor, payload: PostPayload): Promise<{ id: string; slug: string }> {
  const response = await fetchWorker(
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
  if (response.status !== 201) {
    throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { id: string; slug: string };
}

/**
 * A verified actor — every account already has a handle from signup, so
 * publishing is never gated on a separate onboarding step (see
 * test/publish-username-gate.test.ts). Mirrors test/follows.test.ts's
 * `onboardedActor()`.
 */
async function onboardedActor(): Promise<Actor> {
  return createVerifiedActor();
}

let actor: Actor;

beforeAll(async () => {
  actor = await onboardedActor();
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("GET /public/posts", () => {
  it("returns a published post by username + slug", async () => {
    const { slug } = await create(actor, {
      title: "Public One",
      markdownSource: "# body",
      status: "published",
    });
    const response = await fetchWorker(
      new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`),
    );
    expect(response.status).toBe(200);
    const post = (await response.json()) as PublicPost;
    // The MARKDOWN SOURCE, not HTML: rendering happens in the web Worker at read
    // time. No rendered HTML is ever stored or served from here.
    expect(post.markdownSource).toBe("# body");
    expect(post.username).toBe(actor.username);
    // Untagged: [] (COALESCE-guaranteed), never undefined — see TAGS_AGG.
    expect(post.tags).toEqual([]);
  });

  it("carries its tags", async () => {
    const { slug } = await create(actor, {
      title: "Public Tagged",
      markdownSource: "# body",
      status: "published",
      tags: ["Rust"],
    });
    const response = await fetchWorker(
      new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`),
    );
    expect(response.status).toBe(200);
    const post = (await response.json()) as PublicPost;
    expect(post.tags).toEqual([{ slug: "rust", label: "Rust" }]);
  });

  it("404s a DRAFT — anonymously and for its own author alike", async () => {
    const { slug } = await create(actor, { title: "Hidden", markdownSource: "x" });
    const anon = await fetchWorker(
      new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`),
    );
    expect(anon.status).toBe(404);

    // ⚠️ Even WITH the author's own cookie. This route is what the edge caches;
    // if it could ever vary by viewer, one author's draft would be cached and
    // served to the world. It must be viewer-INDEPENDENT by construction.
    const authed = await fetchWorker(
      new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`, {
        headers: { Cookie: actor.cookie },
      }),
    );
    expect(authed.status).toBe(404);
  });

  it("404s a missing username or slug", async () => {
    expect(
      (await fetchWorker(new Request("https://api.test/public/posts?username=nobody&slug=x")))
        .status,
    ).toBe(404);
    expect((await fetchWorker(new Request("https://api.test/public/posts"))).status).toBe(404);
  });

  it("matches the slug case-insensitively (citext)", async () => {
    const { slug } = await create(actor, {
      title: "Case Test",
      markdownSource: "x",
      status: "published",
    });
    const response = await fetchWorker(
      new Request(
        `https://api.test/public/posts?username=${actor.username}&slug=${slug.toUpperCase()}`,
      ),
    );
    expect(response.status).toBe(200);
  });
});

describe("GET /public/profile", () => {
  it("paginates newest-first by keyset", async () => {
    const author = await onboardedActor();
    for (let i = 0; i < 25; i++) {
      await create(author, { title: `Post ${i}`, markdownSource: "x", status: "published" });
    }
    const first = (await (
      await fetchWorker(new Request(`https://api.test/public/profile?username=${author.username}`))
    ).json()) as PublicProfile;
    expect(first.posts).toHaveLength(20);
    expect(first.posts[0]!.title).toBe("Post 24");
    expect(first.nextCursor).toBe(first.posts[19]!.id);

    const second = (await (
      await fetchWorker(
        new Request(
          `https://api.test/public/profile?username=${author.username}&cursor=${first.nextCursor}`,
        ),
      )
    ).json()) as PublicProfile;
    expect(second.posts).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    // No overlap and no gap — the property keyset pagination exists to give.
    expect(new Set([...first.posts, ...second.posts].map((p) => p.id)).size).toBe(25);
  });

  it("excludes drafts", async () => {
    const author = await onboardedActor();
    await create(author, { title: "Draft", markdownSource: "x" });
    await create(author, { title: "Live", markdownSource: "x", status: "published" });
    const profile = (await (
      await fetchWorker(new Request(`https://api.test/public/profile?username=${author.username}`))
    ).json()) as PublicProfile;
    expect(profile.posts.map((p) => p.title)).toEqual(["Live"]);
  });

  it("404s an unknown username", async () => {
    expect(
      (await fetchWorker(new Request("https://api.test/public/profile?username=nobody"))).status,
    ).toBe(404);
  });

  it("carries each post's tags", async () => {
    const author = await onboardedActor();
    await create(author, {
      title: "Profile Tagged",
      markdownSource: "x",
      status: "published",
      tags: ["Design"],
    });
    const profile = (await (
      await fetchWorker(new Request(`https://api.test/public/profile?username=${author.username}`))
    ).json()) as PublicProfile;
    const mine = profile.posts.find((p) => p.title === "Profile Tagged");
    expect(mine).toBeDefined();
    expect(mine!.tags).toEqual([{ slug: "design", label: "Design" }]);
  });

  it("400s a malformed cursor rather than 500ing", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/profile?username=${actor.username}&cursor=not-a-uuid`),
    );
    // `id < 'not-a-uuid'` is a Postgres 22P02 cast error -> a 500 without this.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });
});

describe("GET /public/recent", () => {
  it("returns published posts with their author's username", async () => {
    const author = await onboardedActor();
    const { id } = await create(author, {
      title: "Recent One",
      markdownSource: "x",
      status: "published",
      tags: ["Rust"],
    });
    const body = (await (
      await fetchWorker(new Request("https://api.test/public/recent"))
    ).json()) as { posts: { id: string; username: string; tags: { slug: string; label: string }[] }[] };
    const mine = body.posts.find((p) => p.id === id);
    expect(mine).toBeDefined();
    expect(mine!.username).toBe(author.username);
    expect(mine!.tags).toEqual([{ slug: "rust", label: "Rust" }]);
  });

  it("excludes drafts", async () => {
    const author = await createVerifiedActor();
    const { id } = await create(author, { title: "Recent Draft", markdownSource: "x" });
    const body = (await (
      await fetchWorker(new Request("https://api.test/public/recent"))
    ).json()) as { posts: { id: string }[] };
    expect(body.posts.some((p) => p.id === id)).toBe(false);
  });

  it("honors a limit", async () => {
    const body = (await (
      await fetchWorker(new Request("https://api.test/public/recent?limit=1"))
    ).json()) as { posts: unknown[] };
    expect(body.posts).toHaveLength(1);
  });

  /**
   * A non-numeric limit is the client's error, and saying so is what earns this
   * route its error-envelope probe. Silently clamping `limit=abc` to the maximum
   * would answer 200 with 1000 posts for a request that asked for something
   * incoherent — and would leave the route claiming, in
   * test/error-envelope.test.ts's ERROR_FREE ledger, to have no error path at
   * all while holding a DB query. See src/routes/public.ts.
   */
  it("400s a malformed limit", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/recent?limit=abc"));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });
});

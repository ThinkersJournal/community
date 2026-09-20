/**
 * THE PROFILE OWNER'S HIDDEN/DRAFT POSTS — #78 item 2, the other half of
 * CireSnave's ruling: "posts hidden by the user should still be visible to
 * the user in their own list of posts. If they aren't visible there, where
 * would a user go to click a link to edit that post?"
 *
 * `[handle]/index.astro` is anonymous + edge-cached SSR (same construction as
 * `[handle]/[slug].astro` — see that page's header), and PM review was
 * explicit: this listing must NOT come from the cached anonymous
 * `PublicProfile` DTO (`GET /public/profile`, which filters to published +
 * visible posts by design). So this hydrates CLIENT-SIDE instead, from the
 * authenticated `GET /api/my-posts` hop, ONLY when the viewer IS this
 * profile's own owner — same reveal mechanics as post-delete.ts's and
 * social.ts's islands, for the same reason.
 *
 * Renders a SEPARATE section from the SSR public list rather than merging
 * into it: the two come from different endpoints with different shapes
 * (`AuthoredPostSummary` vs `PublicPost`'s excerpt), and a post that is
 * BOTH published-and-visible already appears in the public list — this
 * section only needs to add what that list structurally cannot show
 * (drafts, and posts hidden by moderation or by the author).
 *
 * Talks ONLY to same-origin /api/* (the api Worker has no public origin).
 */
interface Me {
  userId: string | null;
}

async function me(): Promise<Me> {
  try {
    const r = await fetch("/api/me");
    if (!r.ok) return { userId: null };
    const m = (await r.json()) as { userId: string | null };
    return { userId: m.userId };
  } catch {
    return { userId: null };
  }
}

interface AuthoredPostSummary {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  hiddenAt: string | null;
  hiddenReason: "author" | "moderation" | null;
}

interface MyPostsPage {
  posts: AuthoredPostSummary[];
  nextCursor: string | null;
}

async function loadMine(): Promise<AuthoredPostSummary[]> {
  const out: AuthoredPostSummary[] = [];
  let cursor: string | null = null;
  // ⚠️ BOUNDED, not "until nextCursor is null": a pathological account with
  // thousands of posts must not turn one profile-page load into an unbounded
  // fetch loop. Ten pages (500 posts, PAGE_SIZE=50 at the api) comfortably
  // covers this app's real usage; anything beyond that is simply not shown
  // here yet — this is a convenience surface, not the canonical record (the
  // editor and this post's own URL always show the full truth).
  for (let page = 0; page < 10; page++) {
    const path = cursor === null ? "/api/my-posts" : `/api/my-posts?cursor=${encodeURIComponent(cursor)}`;
    let resp: Response;
    try {
      resp = await fetch(path);
    } catch {
      break;
    }
    if (!resp.ok) break;
    const data = (await resp.json()) as MyPostsPage;
    out.push(...data.posts);
    if (data.nextCursor === null) break;
    cursor = data.nextCursor;
  }
  return out;
}

function statusLabel(post: AuthoredPostSummary): string {
  if (post.status === "draft") return "Draft";
  if (post.hiddenAt !== null) return post.hiddenReason === "author" ? "Hidden by you" : "Hidden";
  return "";
}

export function initOwnerPosts(): void {
  const root = document.querySelector<HTMLElement>("[data-owner-posts]");
  if (root === null) return;
  const profileUserId = root.dataset.profileUserId ?? "";
  const username = root.dataset.username ?? "";
  const list = root.querySelector<HTMLElement>("[data-owner-posts-list]");
  if (list === null) return;

  void me().then((m) => {
    // Owner-only — a stranger, or a degraded /api/me response, sees nothing.
    if (m.userId === null || m.userId !== profileUserId) return;

    void loadMine().then((posts) => {
      // Only what the public list structurally cannot already show — a
      // published, currently-visible post is already on the page above.
      const extra = posts.filter((p) => p.status === "draft" || p.hiddenAt !== null);
      if (extra.length === 0) return;

      root.hidden = false;
      list.replaceChildren(
        ...extra.map((post) => {
          const li = document.createElement("li");
          li.className = "post owner-only-post";

          const h2 = document.createElement("h2");
          const a = document.createElement("a");
          // Drafts have never been published, so there's no [handle]/[slug]
          // owner-fallback to send them to yet — that page's anonymous fetch
          // and this authenticated fallback both key on a real slug, but a
          // draft's slug is real (assigned at creation, see routes/posts.ts)
          // and the owner-fallback renders it all the same. Send every row
          // here, draft or hidden, to that one shared destination.
          a.href = `/@${encodeURIComponent(username)}/${encodeURIComponent(post.slug)}`;
          a.textContent = post.title;
          h2.appendChild(a);
          li.appendChild(h2);

          const label = statusLabel(post);
          if (label !== "") {
            const badge = document.createElement("span");
            badge.className = "owner-post-badge";
            badge.textContent = label;
            li.appendChild(badge);
          }

          const edit = document.createElement("a");
          edit.className = "link owner-post-edit";
          edit.href = `/new-post?post=${encodeURIComponent(post.id)}`;
          edit.textContent = "Edit";
          li.appendChild(edit);

          return li;
        }),
      );
    });
  });
}

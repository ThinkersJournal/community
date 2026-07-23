/**
 * THE COMMENTS ISLAND — hydrates per-viewer comment affordances onto the CACHED
 * post page: the comment form (or the right gate affordance), Reply/Edit/Delete
 * per comment. The page HTML is identical for every viewer; everything decided
 * here comes from /api/me at runtime. After ANY successful write it reloads —
 * the api purged post:<id> before answering, so the reload IS the fresh render.
 * DOM is built with createElement/textContent ONLY (no HTML injection sink).
 */
interface MeResponse {
  loggedIn: boolean;
  userId: string | null;
  username: string | null;
  usernameChosen: boolean;
  csrfToken: string | null;
}

interface CommentRowWire {
  id: string;
  bodyMarkdown: string;
}

const MAX_DEPTH = 8;

async function loadMe(): Promise<MeResponse> {
  try {
    const resp = await fetch("/api/me");
    if (!resp.ok) throw new Error("me failed");
    return (await resp.json()) as MeResponse;
  } catch {
    return { loggedIn: false, userId: null, username: null, usernameChosen: false, csrfToken: null };
  }
}

function showError(container: HTMLElement, message: string): void {
  let note = container.querySelector<HTMLElement>("[data-error]");
  if (note === null) {
    note = document.createElement("p");
    note.setAttribute("data-error", "");
    note.className = "comment-error";
    container.appendChild(note);
  }
  note.textContent = message;
}

function buildForm(opts: {
  csrfToken: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (markdownSource: string, form: HTMLFormElement) => Promise<Response>;
}): HTMLFormElement {
  const form = document.createElement("form");
  const textarea = document.createElement("textarea");
  textarea.name = "markdownSource";
  textarea.required = true;
  textarea.maxLength = 10_000;
  textarea.rows = 4;
  if (opts.initial !== undefined) textarea.value = opts.initial;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "btn btn-primary";
  button.textContent = opts.submitLabel;
  form.appendChild(textarea);
  form.appendChild(button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    void opts
      .onSubmit(textarea.value, form)
      .then(async (resp) => {
        if (resp.ok) {
          location.reload();
          return;
        }
        const body = (await resp.json().catch(() => null)) as { code?: string } | null;
        if (body?.code === "USERNAME_REQUIRED") {
          location.href = `/choose-username?next=${encodeURIComponent(location.pathname)}`;
          return;
        }
        button.disabled = false;
        showError(
          form,
          body?.code === "EMAIL_NOT_VERIFIED"
            ? "Verify your email to comment."
            : body?.code === "RATE_LIMITED"
              ? "Slow down a moment, then try again."
              : "Something went wrong — try again.",
        );
      })
      .catch(() => {
        button.disabled = false;
        showError(form, "Network error — try again.");
      });
  });
  return form;
}

function postJson(url: string, csrfToken: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
  });
}

/** The page's ?comments= cursor — edit-prefill must fetch the SAME page. */
function commentsCursor(): string | null {
  return new URLSearchParams(location.search).get("comments");
}

async function fetchSource(postId: string, commentId: string): Promise<string | null> {
  const q = new URLSearchParams({ postId });
  const cursor = commentsCursor();
  if (cursor !== null) q.set("cursor", cursor);
  const resp = await fetch(`/api/comments?${q.toString()}`);
  if (!resp.ok) return null;
  const page = (await resp.json()) as { comments: CommentRowWire[] };
  return page.comments.find((c) => c.id === commentId)?.bodyMarkdown ?? null;
}

export function initCommentsIsland(): void {
  const section = document.querySelector<HTMLElement>("[data-comments]");
  if (section === null) return;
  const postId = section.dataset.postId ?? "";
  const postAuthorId = section.dataset.postAuthorId ?? "";
  const slot = section.querySelector<HTMLElement>("[data-comment-form-slot]");

  void loadMe().then((me) => {
    // 1. The form slot: logged-out keeps the SSR login link; un-onboarded gets
    //    the choose-handle affordance; onboarded gets the real form.
    if (slot !== null && me.loggedIn) {
      if (!me.usernameChosen || me.csrfToken === null) {
        const p = document.createElement("p");
        const a = document.createElement("a");
        a.className = "link";
        a.href = `/choose-username?next=${encodeURIComponent(location.pathname)}`;
        a.textContent = "Choose your handle";
        p.appendChild(a);
        p.appendChild(document.createTextNode(" to join the conversation."));
        slot.replaceChildren(p);
      } else {
        const csrfToken = me.csrfToken;
        slot.replaceChildren(
          buildForm({
            csrfToken,
            submitLabel: "Comment",
            onSubmit: (markdownSource) =>
              postJson("/api/comment", csrfToken, { postId, markdownSource }),
          }),
        );
      }
    }

    // 2. Per-comment affordances — only for onboarded viewers with a token.
    if (!me.loggedIn || !me.usernameChosen || me.csrfToken === null || me.userId === null) return;
    const csrfToken = me.csrfToken;
    const viewerId = me.userId;

    for (const li of Array.from(
      section.querySelectorAll<HTMLElement>("[data-comment-id]:not([data-deleted])"),
    )) {
      const commentId = li.dataset.commentId ?? "";
      const authorId = li.dataset.authorId ?? "";
      const depth = Number(li.dataset.depth ?? "0");
      const actions = li.querySelector<HTMLElement>("[data-comment-actions]");
      if (actions === null) continue;

      if (depth < MAX_DEPTH) {
        const reply = document.createElement("button");
        reply.type = "button";
        reply.className = "btn btn-ghost";
        reply.textContent = "Reply";
        reply.addEventListener("click", () => {
          reply.disabled = true;
          actions.appendChild(
            buildForm({
              csrfToken,
              submitLabel: "Reply",
              onSubmit: (markdownSource) =>
                postJson("/api/comment", csrfToken, { postId, parentId: commentId, markdownSource }),
            }),
          );
        });
        actions.appendChild(reply);
      }

      if (authorId === viewerId) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "btn btn-ghost";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => {
          edit.disabled = true;
          void fetchSource(postId, commentId).then((source) => {
            if (source === null) {
              edit.disabled = false;
              return;
            }
            actions.appendChild(
              buildForm({
                csrfToken,
                submitLabel: "Save",
                initial: source,
                onSubmit: (markdownSource) =>
                  postJson("/api/comment-update", csrfToken, { commentId, markdownSource }),
              }),
            );
          });
        });
        actions.appendChild(edit);
      }

      // Delete: own comment, or ANY comment on the viewer's own post (decision 7).
      if (authorId === viewerId || viewerId === postAuthorId) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn btn-ghost";
        del.textContent = "Delete";
        del.addEventListener("click", () => {
          del.disabled = true;
          void postJson("/api/comment-delete", csrfToken, { commentId })
            .then((resp) => {
              if (resp.ok) location.reload();
              else del.disabled = false;
            })
            .catch(() => {
              del.disabled = false;
            });
        });
        actions.appendChild(del);
      }
    }
  });
}

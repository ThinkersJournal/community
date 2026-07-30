/**
 * THE PER-POST LIVE SPINE, END TO END (M2.3b-live's final task) — two tabs on
 * the SAME post, one acts (comments, reacts, edits, deletes), the other sees
 * it live with NO reload and NO poll: `PostLiveDO` -> `/posts/live` -> the
 * `/api/posts-live` web proxy -> the content-free push seam
 * (`notifyPostLive`) -> `/api/comments-fragment` -> the reconcile client
 * (comments-live.ts) -> the observable DOM, across both Workers + real
 * Postgres + the Durable Object, under the same `wrangler dev` topology every
 * other spec in this directory proves against.
 *
 * ⚠️ THE ISOLATION ARGUMENT (why a fast DOM update proves the WS, not a
 * reload or a poll). From the moment V's socket is confirmed open, this test
 * never calls `v.goto`, `v.reload`, or clicks anything on `v` — V is a pure
 * observer for the rest of the test. `comments-live.ts` touches V's DOM from
 * exactly one place: its WS `onmessage` handler (a "comment" nudge triggers a
 * `/api/comments-fragment` refetch + reconcile; a "reaction" nudge triggers
 * `refreshReactionCounts()`). There is no timer and no other trigger that
 * could paint new content into V's page. So every `{ timeout: 8000 }`
 * assertion below — on a tab that has done nothing since it loaded — is a
 * discriminating assertion for the push, not a generous timeout on some other
 * path.
 *
 * ⚠️ THE ONE RACE THAT MAKES THIS FLAKE (mirrors notifications-realtime.spec.ts).
 * The nudge is CONTENT-FREE and PostLiveDO does NOT replay it: a socket that
 * is not open yet at the moment B acts simply never receives that nudge —
 * there is no poll fallback here at all (unlike the notify bell), so a missed
 * nudge means the assertion just times out. `page.waitForEvent("websocket")`
 * fires the moment the browser CREATES the socket, so it must be ARMED before
 * `v.goto(url)` — a listener registered after navigation can race a socket
 * that opens the instant the page's inline script runs. Arm, then goto, then
 * confirm the comments section rendered, then await the arm — only THEN is it
 * safe to let B act.
 *
 * Never asserts on WS frame contents: the frames are content-free by design
 * (`{type:"comment"|"reaction"}`, see PostLiveDO) — this only ever asserts the
 * OBSERVABLE DOM (comment text, a reaction count, a tombstone marker), never a
 * `page.evaluate`d wire payload.
 */
import { expect, test } from "@playwright/test";

import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("comment/reaction/edit/delete on an open post page appear live in a second tab", async ({
  page: a,
  browser,
}) => {
  // ---- Author A publishes ---------------------------------------------------
  await signUpAndVerify(a, a.request);
  const { url } = await publishPost(a, {
    title: "Live Spine Probe",
    markdownSource: "A post for the live-spine e2e.",
  });

  const vCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  try {
    // ---- Viewer V opens the post ANONYMOUS (the channel is unauthed) and ---
    // arms its socket-open listener BEFORE navigating — see the header's race
    // note. Only after `vWsOpened` resolves is it safe to let B act.
    const v = await vCtx.newPage();
    const vWsOpened = v.waitForEvent("websocket");
    await v.goto(url);
    await expect(v.locator("[data-comments]")).toBeVisible();
    await vWsOpened;

    // ---- Commenter B signs up, onboards, and comments ------------------------
    const b = await bCtx.newPage();
    await signUpAndVerify(b, b.request);
    await chooseUsername(b, uniqueHandle("commenter"));
    await b.goto(url);

    const commentText = "Live comment from B";
    const form = b.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill(commentText);
    await form.locator("button[type=submit]").click();
    // A successful submit reloads B's own page (comments.ts's buildForm) — B's
    // confirmation is the fresh SSR render, independent of V's WS-driven one.
    await expect(b.locator(".comment-body").first()).toContainText(commentText);

    // ---- LIVE ASSERT #1 — V has done NOTHING since `vWsOpened` above -------
    // No goto, no reload, no interaction on `v`. See the header for why <8s
    // here can only be the WS push, not a masked reload or refresh.
    await expect(
      v.locator('[data-comments] [data-comment-id]', { hasText: commentText }),
    ).toBeVisible({ timeout: 8000 });

    // ---- LIVE REACTION — B reacts on the POST'S chips (scoped away from ----
    // its own comment's chip row, which now also exists on this page).
    const bPostReaction = b
      .locator("[data-reactions][data-target-post]")
      .locator('button[data-kind="insightful"]');
    await expect(bPostReaction).toBeEnabled(); // reactions island hydrated
    await bPostReaction.click();
    await expect(bPostReaction).toHaveAttribute("aria-pressed", "true");

    // ---- LIVE ASSERT #2 — V's matching chip ticks up with no interaction ---
    const vPostReactionCount = v
      .locator("[data-reactions][data-target-post]")
      .locator('button[data-kind="insightful"]')
      .locator("[data-count]");
    await expect(vPostReactionCount).toHaveText("1", { timeout: 8000 });

    // ---- LIVE EDIT — B edits its own (only) comment on this post -----------
    const bComment = b.locator("[data-comment-id]").first();
    await bComment.locator("button", { hasText: "Edit" }).click();
    const editForm = bComment.locator("[data-comment-actions] form");
    await expect(editForm.locator("textarea")).toHaveValue(commentText);
    const editedText = "Live comment from B, now edited";
    await editForm.locator("textarea").fill(editedText);
    await editForm.locator("button[type=submit]").click();
    // Successful edit also reloads B's page.
    await expect(b.locator(".comment-body").first()).toContainText(editedText);

    // ---- LIVE ASSERT #3 — V's body updates with no interaction -------------
    await expect(
      v.locator('[data-comments] [data-comment-id]', { hasText: editedText }),
    ).toBeVisible({ timeout: 8000 });

    // ---- LIVE DELETE — B deletes its own (now-edited) comment --------------
    const bCommentAgain = b.locator("[data-comment-id]").first();
    await bCommentAgain.locator("button", { hasText: "Delete" }).click();
    // Successful delete also reloads B's page.
    await expect(b.locator(".tombstone").first()).toHaveText("[deleted]");

    // ---- LIVE ASSERT #4 — V sees the tombstone with no interaction ---------
    await expect(
      v.locator('[data-comments] [data-comment-id][data-deleted="true"]'),
    ).toBeVisible({ timeout: 8000 });
    await expect(v.locator("[data-comments] .tombstone").first()).toHaveText("[deleted]", {
      timeout: 8000,
    });
  } finally {
    await bCtx.close();
    await vCtx.close();
  }
});

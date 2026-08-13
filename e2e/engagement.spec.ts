/**
 * THE ENGAGEMENT SPINE — a real browser drives comment + reaction life-cycles
 * across both Workers: author A publishes; reader B comments, replies, edits,
 * reacts; an anonymous reader sees the comments; A moderates (deletes B's
 * comment on A's post).
 *
 * ⚠️ miniflare does not simulate Workers Cache (see publish.spec.ts's header):
 * "the comment appears after reload" here observes the DB-backed re-render,
 * which is exactly what the requirement asks; the purge-driven cache
 * invalidation is deploy-gate-only and this file does NOT claim to test it.
 */
import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify } from "./helpers";

test("comment → reply → edit → react → anonymous sees it → author moderates", async ({
  page,
  browser,
}) => {
  // ---- Author A publishes --------------------------------------------------
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, {
    title: "Engagement Spine",
    markdownSource: "A post worth **discussing**.",
  });

  // ---- Reader B comments ---------------------------------------------------
  const readerCtx = await browser.newContext();
  const readerPage = await readerCtx.newPage();
  try {
    await signUpAndVerify(readerPage, readerPage.request);

    await readerPage.goto(url);
    // The island replaced the SSR login-link with a real form.
    const form = readerPage.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill("A comment with `code` in it.");
    await form.locator("button[type=submit]").click();
    // reload happened; the SSR'd comment renders THROUGH the markdown pipeline.
    await expect(readerPage.locator(".comment-body code")).toHaveText("code");

    // ---- Reply (nested) ----------------------------------------------------
    const commentLi = readerPage.locator("[data-comment-id]").first();
    await commentLi.locator("button", { hasText: "Reply" }).click();
    const replyForm = commentLi.locator("[data-comment-actions] form");
    await replyForm.locator("textarea").fill("Replying to myself.");
    await replyForm.locator("button[type=submit]").click();
    await expect(readerPage.locator('[data-depth="1"]')).toContainText("Replying to myself.");

    // ---- Edit own reply ----------------------------------------------------
    const replyLi = readerPage.locator('[data-depth="1"]');
    await replyLi.locator("button", { hasText: "Edit" }).click();
    const editForm = replyLi.locator("[data-comment-actions] form");
    await expect(editForm.locator("textarea")).toHaveValue("Replying to myself.");
    await editForm.locator("textarea").fill("Edited reply.");
    await editForm.locator("button[type=submit]").click();
    await expect(readerPage.locator('[data-depth="1"]')).toContainText("Edited reply.");
    await expect(readerPage.locator('[data-depth="1"] .edited')).toBeVisible();

    // ---- React to the reply (comment-level reactions) ----------------------
    // Reactions have no self-restriction (unlike follows), so the reader
    // reacting to their own reply is valid. Scoped to the reply's own chip
    // row so this can never accidentally hit the post's reactions section.
    const replyChips = readerPage.locator('[data-depth="1"] [data-reactions][data-target-comment]');
    const curious = replyChips.locator('button[data-kind="curious"]');
    await expect(curious).toBeEnabled(); // island hydrated
    await curious.click();
    await expect(curious).toHaveAttribute("aria-pressed", "true");
    await expect(curious.locator("[data-count]")).toHaveText("1");
    // Survives a reload (server state, not client optimism).
    await readerPage.reload();
    await expect(
      readerPage
        .locator('[data-depth="1"] [data-reactions][data-target-comment] button[data-kind="curious"]')
        .locator("[data-count]"),
    ).toHaveText("1");

    // ---- React to the post -------------------------------------------------
    const postChips = readerPage.locator('[data-reactions][data-target-post]');
    const insightful = postChips.locator('button[data-kind="insightful"]');
    await expect(insightful).toBeEnabled(); // island hydrated
    await insightful.click();
    await expect(insightful).toHaveAttribute("aria-pressed", "true");
    await expect(insightful.locator("[data-count]")).toHaveText("1");
    // Survives a reload (server state, not client optimism).
    await readerPage.reload();
    await expect(
      readerPage
        .locator('[data-reactions][data-target-post] button[data-kind="insightful"]')
        .locator("[data-count]"),
    ).toHaveText("1");

    // ---- Anonymous reader sees the comments --------------------------------
    const anonCtx = await browser.newContext();
    try {
      const anonPage = await anonCtx.newPage();
      await anonPage.goto(url);
      await expect(anonPage.locator(".comment-body").first()).toContainText("A comment with");
      // Anonymous: form slot still shows the SSR login affordance.
      await expect(anonPage.locator("[data-comment-form-slot]")).toContainText("Log in");
    } finally {
      await anonCtx.close();
    }

    // ---- Author A moderates: deletes B's top-level comment on A's post -----
    await page.goto(url);
    const target = page.locator("[data-comment-id]").first();
    await target.locator("button", { hasText: "Delete" }).click();
    await expect(page.locator(".tombstone").first()).toHaveText("[deleted]");
    // The reply SURVIVES under the tombstone.
    await expect(page.locator('[data-depth="1"]')).toContainText("Edited reply.");
  } finally {
    await readerCtx.close();
  }
});

// ⚠️ HANDLE-AT-SIGNUP REMOVAL. This file used to carry a test proving that a
// verified-but-un-onboarded viewer got a "Choose your handle" affordance in
// the comment-form slot instead of the form itself. That state no longer
// exists: the @handle is now chosen ON THE SIGNUP FORM, so every verified
// account already has one — `comments.ts`'s `initCommentsIsland` no longer
// even has a branch for "logged in, no handle" (see its own comment on the
// two logged-in cases, both requiring only a CSRF token). Nothing left to
// probe here.

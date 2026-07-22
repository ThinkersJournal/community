import { expect, test } from "@playwright/test";

import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("follow → the feed shows the followee's post → unfollow removes it", async ({ page, browser }) => {
  // Author A publishes a post (publishPost onboards A with a chosen handle).
  await signUpAndVerify(page, page.request);
  const { username: authorHandle } = await publishPost(page, {
    title: "Alice On Systems",
    markdownSource: "a thought from alice",
  });

  // Reader B in a fresh browser context.
  const ctxB = await browser.newContext();
  try {
    const b = await ctxB.newPage();
    await signUpAndVerify(b, b.request);
    await chooseUsername(b, uniqueHandle("reader"));

    // B follows A from A's profile — the island reveals the button, then flips it.
    await b.goto(`/@${authorHandle}`);
    const followBtn = b.locator("[data-follow-btn]");
    await expect(followBtn).toBeVisible();
    await expect(followBtn).toHaveText("Follow");
    await followBtn.click();
    await expect(followBtn).toHaveText("Unfollow");

    // B's feed now shows A's post.
    await b.goto("/feed");
    await expect(b.locator("a", { hasText: "Alice On Systems" })).toBeVisible();

    // B unfollows → the feed no longer shows it.
    await b.goto(`/@${authorHandle}`);
    await b.locator("[data-follow-btn]").click();
    await expect(b.locator("[data-follow-btn]")).toHaveText("Follow");
    await b.goto("/feed");
    await expect(b.locator("a", { hasText: "Alice On Systems" })).toHaveCount(0);
  } finally {
    await ctxB.close();
  }
});

test("a not-yet-onboarded user opening the editor sees a choose-handle prompt, not a fillable form", async ({ page }) => {
  // ⚠️ MILESTONE-REVIEW FIX (content-loss). Before this fix, an unonboarded
  // author could type a title + body and only THEN discover (on publish)
  // that they needed a handle — losing everything typed across the
  // new-post → choose-username → /feed redirect chain. The fix gates at
  // EDITOR-OPEN: an unonboarded visitor never sees the form at all, so
  // there's nothing to fill or lose. Do NOT fill/publish here — there is no
  // form to fill.
  await signUpAndVerify(page, page.request);
  await page.goto("/new-post");

  await expect(page.locator("#onboarding-required")).toBeVisible();
  const link = page.locator('a[href="/choose-username?next=/new-post"]');
  await expect(link).toBeVisible();
  await expect(page.locator("#editor-form")).toHaveCount(0);

  // Following the prompt to onboard returns the author to the editor
  // (?next= honored), where the form is now actually present.
  await link.click();
  await page.fill('input[name="username"]', uniqueHandle("late"));
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/new-post$/);
  await expect(page.locator("#editor-form")).toBeVisible();
});

test("a new user's feed is empty and points at discovery", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  await chooseUsername(page, uniqueHandle("lonely"));
  await page.goto("/feed");
  // Scoped to <main>: the themed shell's global footer (a sibling of <main>,
  // see BaseLayout.astro) now ALSO has a "Discover authors" link, so an
  // unscoped `a` locator is ambiguous (strict-mode violation). Scoping to
  // main targets this page's own empty-state prompt, not chrome.
  await expect(page.locator("main a", { hasText: "Discover authors" })).toBeVisible();
});

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

test("publishing before choosing a handle routes to onboarding", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  await page.goto("/new-post");
  await page.fill("#title", "Too Early");
  await page.fill("#markdownSource", "body");
  await page.click("button[value='publish']");
  await expect(page).toHaveURL(/\/choose-username$/);
});

test("a new user's feed is empty and points at discovery", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  await chooseUsername(page, uniqueHandle("lonely"));
  await page.goto("/feed");
  await expect(page.locator("a", { hasText: "Discover authors" })).toBeVisible();
});

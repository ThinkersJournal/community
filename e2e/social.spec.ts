import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify, toggleFollowTo } from "./helpers";

test("follow → the feed shows the followee's post → unfollow removes it", async ({ page, browser }) => {
  // Author A publishes a post (the handle comes from signup — handle-at-signup).
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

    // B follows A from A's profile — the island reveals the button, then flips it.
    // (toggleFollowTo tolerates the E2E dev-harness's lost-follow-response stall;
    // see its doc in helpers.ts.)
    await b.goto(`/@${authorHandle}`);
    await toggleFollowTo(b, "Unfollow");

    // B's feed now shows A's post.
    await b.goto("/feed");
    await expect(b.locator("a", { hasText: "Alice On Systems" })).toBeVisible();

    // B unfollows → the feed no longer shows it.
    await b.goto(`/@${authorHandle}`);
    await toggleFollowTo(b, "Follow");
    await b.goto("/feed");
    await expect(b.locator("a", { hasText: "Alice On Systems" })).toHaveCount(0);
  } finally {
    await ctxB.close();
  }
});

// ⚠️ HANDLE-AT-SIGNUP REMOVAL. This file used to carry a test proving that a
// not-yet-onboarded author opening the editor got a choose-handle prompt
// instead of a fillable form (the M2.1 content-loss fix's payoff). That state
// no longer exists to test: the @handle is now chosen ON THE SIGNUP FORM
// itself, so every signed-up account — this test's premise notwithstanding —
// already has one by the time it can reach `/new-post` at all. See
// apps/web/src/pages/new-post.astro (no more "not onboarded" branch) and
// e2e/signup.spec.ts's rewritten negative test for where that gate's
// underlying security property (an unverified user cannot get a post saved)
// now lives instead.

test("a new user's feed is empty and points at discovery", async ({ page }) => {
  await signUpAndVerify(page, page.request);
  await page.goto("/feed");
  // Scoped to <main>: the themed shell's global footer (a sibling of <main>,
  // see BaseLayout.astro) now ALSO has a "Discover authors" link, so an
  // unscoped `a` locator is ambiguous (strict-mode violation). Scoping to
  // main targets this page's own empty-state prompt, not chrome.
  await expect(page.locator("main a", { hasText: "Discover authors" })).toBeVisible();
});

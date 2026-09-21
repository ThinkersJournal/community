import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify } from "./helpers";

/**
 * #71 — THE EDITOR'S DISCARD LINK. Before this, a brand-new post in progress
 * had no exit but navigating away with no confirmation and no indication
 * whether a draft was left behind. Proves the real thing a source/structure
 * test can't: clicking it actually leaves, and for an existing post it does
 * NOT delete anything — only Delete's own two-step confirm does that.
 */

test("a NEW post's Discard link leaves the editor without saving anything", async ({ page, request }) => {
  await signUpAndVerify(page, request);

  await page.goto("/new-post");
  await page.fill("#title", "Never Saved");
  await page.fill("#markdownSource", "this should never be persisted");

  await page.getByRole("link", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(/\/feed$/);

  // Nothing was saved — going back to a fresh /new-post shows an empty form,
  // not the abandoned draft.
  await page.goto("/new-post");
  await expect(page.locator("#title")).toHaveValue("");
});

test("an EXISTING post's 'Discard changes' reloads the saved version — it does NOT delete the post", async ({
  page,
  request,
}) => {
  const { postId, url } = await publishPost(page, {
    title: "Untouched By Discard",
    markdownSource: "original body",
  });

  await page.goto(`/new-post?post=${encodeURIComponent(postId)}`);
  await page.fill("#markdownSource", "an edit nobody will save");

  await page.getByRole("link", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/new-post\\?post=${postId}$`));
  // The RELOADED editor shows the ORIGINAL saved body, not the abandoned edit.
  await expect(page.locator("#markdownSource")).toHaveValue("original body");

  // And the post itself is still live at its public URL — discard never
  // touched the row Delete's own confirm exists to remove.
  const response = await page.request.get(url);
  expect(response.status()).toBe(200);
});

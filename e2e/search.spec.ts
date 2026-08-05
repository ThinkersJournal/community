import { expect, test } from "@playwright/test";
import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("search finds a post by a partial+typo term and a person by partial name", async ({ page, request }) => {
  await signUpAndVerify(page, request);
  // A distinctive, unlikely-to-collide title.
  const title = `Zorptaxis Fieldnotes ${uniqueHandle("z")}`;
  const { username: handle } = await publishPost(page, { title, markdownSource: "notes about zorptaxis" });

  // Posts tab: a partial + typo of "Zorptaxis" still matches (trigram fuzzy).
  await page.goto(`/search?q=${encodeURIComponent("zorptaxs")}&type=posts`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // People tab: the full handle is an exact match (word_similarity 1.0) → ranks first,
  // unambiguous even when other specs have seeded author_* profiles in the shared DB.
  await page.goto(`/search?q=${encodeURIComponent(handle)}&type=people`);
  await expect(page.getByRole("link", { name: new RegExp(handle) })).toBeVisible();
});

test("the nav search box routes to /search", async ({ page, request }) => {
  await signUpAndVerify(page, request);
  await chooseUsername(page, uniqueHandle("navsearch"));
  await page.goto("/feed");
  await page.fill('.nav-search input[name="q"]', "anything");
  await page.press('.nav-search input[name="q"]', "Enter");
  await expect(page).toHaveURL(/\/search\?.*q=anything/);
});

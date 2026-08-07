/**
 * e2e Tags spine (M2.4c Task 9) — the end-to-end proof that a freeform tag
 * carried through the editor actually reaches every reader-facing surface:
 * the chip on the published post page, the post's own `/tag/<slug>` listing,
 * and the community-wide `/tags` index.
 *
 * The tag is deliberately made slug-identical (see `uniqueHandle` below) so
 * the chip label, the `/tag/<slug>` URL, and the `/tags` link text are all
 * exactly the same string — no slugify-vs-label mismatch to reason about.
 */
import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("a tagged post appears on its /tag page, the post page, and /tags", async ({ page, request }) => {
  await signUpAndVerify(page, request);

  // uniqueHandle() returns `<prefix>_<hex>` — the underscore is NOT a valid
  // slug character (the server's slugify maps [^a-z0-9]+ to "-"), so a
  // trailing "_" would come back as "-" and the raw label would no longer
  // match the derived slug. Stripping underscores keeps label === slug on
  // every surface (chip href, /tag/<slug> URL, /tags link).
  const tag = uniqueHandle("topic").replace(/_/g, "-");
  const title = `Tagged Fieldnote ${uniqueHandle("t")}`;
  const { username, slug } = await publishPost(page, {
    title,
    markdownSource: "a tagged body",
    tags: [tag],
  });

  // (a) the tag chip renders on the published post page and links to /tag/<slug>
  await page.goto(`/@${username}/${slug}`);
  await expect(page.locator("main").getByRole("link", { name: tag })).toBeVisible();

  // (b) visiting /tag/<slug> shows the post's heading
  await page.goto(`/tag/${tag}`);
  await expect(page.locator("main").getByRole("heading", { name: title })).toBeVisible();

  // (c) /tags lists the tag (its accessible name is "<label> <count>", so a
  // substring match on the label alone is unambiguous given the random hex).
  await page.goto("/tags");
  await expect(page.locator("main").getByRole("link", { name: new RegExp(tag) })).toBeVisible();
});

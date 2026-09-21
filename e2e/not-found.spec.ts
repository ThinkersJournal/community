import { expect, test } from "@playwright/test";

/**
 * #79 — THE CUSTOM 404. Before this page existed, a request for a path that
 * matches no route (a typo, a dead link) got Astro's own unbranded default
 * fallback: no nav, no footer, a dev-error-styled box echoing the raw path —
 * a stranded reader with no way back to the site. This proves the real thing
 * a unit test on the page's source cannot: the actual HTTP status code, and
 * that the themed shell (nav + footer, same as theming.spec.ts's positive
 * control) really renders for a route Astro's router never matches.
 */

test("an unknown path gets a real 404 status with the themed shell, not Astro's bare default", async ({ page }) => {
  const response = await page.goto("/this-path-does-not-exist-anywhere");
  expect(response?.status()).toBe(404);
  await expect(page.locator("header.nav")).toBeVisible();
  await expect(page.locator("footer.ft")).toBeVisible();
  await expect(page.locator("h1")).toHaveText("Page not found");
  // A route back — same control as post-page-owner-fallback's "at least one
  // route back" requirement. Scoped to `main` (this page's own body), not a
  // bare `a[href="/"]`: the nav's own "Discover" link ALSO points at `/`,
  // and a bare selector strict-mode-violates on two matches.
  await expect(page.locator('main a[href="/"]')).toBeVisible();
});

test("⚠️ the 404 response is never edge-cacheable — private, no-store", async ({ page }) => {
  // Positive control that the harness can see the header at all: reuse the
  // exact assertion shape publish.spec.ts's cacheability test uses on a real
  // page, against a path guaranteed to hit this one.
  const response = await page.request.get("/this-path-does-not-exist-anywhere-either");
  expect(response.status()).toBe(404);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers()["cache-tag"]).toBeUndefined();
});

test("a REAL page is unaffected — positive control that 404 isn't swallowing known routes", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});

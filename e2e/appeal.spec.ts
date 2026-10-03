import { expect, test } from "@playwright/test";

import { API_URL, WEB_URL } from "../playwright.config";
import { signUpAndVerify } from "./helpers";

import type { APIRequestContext } from "@playwright/test";

/**
 * #113 plan B (Task 7) — THE APPEAL SPINE, token-authed. A real browser
 * drives signup -> (a ban seeded through the real `applyAccountAction`
 * primitive, standing in for a moderator's decision) -> open the emailed
 * appeal link -> file the appeal -> the same link cannot be reused.
 *
 * ⚠️ Mints the ban + token via `POST /__test/mint-action-token`, NOT through
 * the browser: E2E has no database access and no Cloudflare Access JWT, so
 * there is no real way to drive a moderator decision from here, and the
 * notice email the real flow would send never arrives (Postmark's dev
 * secret makes the send fail by design). This is the one seam that stands in
 * for both. Direct api call, on :8788 — the api's own `apiVars` (playwright
 * config) set `TEST_ROUTES=1`, which is what makes this route exist at all;
 * `Origin: WEB_URL` is required because the route runs an inline
 * `checkOrigin` (it has no session to key a CSRF token off), and WEB_URL
 * (`http://127.0.0.1:8787`) is one of `csrf.ts`'s `DEV_ORIGINS`. See
 * e2e/password-reset.spec.ts for the same `APIRequestContext` idiom for a
 * `__test` GET; this is the first spec in this harness that POSTs to the api
 * directly rather than only reading a stashed token back.
 */

async function mintAppealToken(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.post(`${API_URL}/__test/mint-action-token`, {
    headers: { Origin: WEB_URL },
    data: { email, purpose: "appeal" },
  });
  expect(
    response.status(),
    "POST /__test/mint-action-token failed — is TEST_ROUTES=1 set on the api dev server?",
  ).toBe(200);
  const body = (await response.json()) as { token: string };
  expect(body.token, "mint-action-token returned no token").not.toBe("");
  return body.token;
}

test("appeal by token: open the emailed link, file the appeal, and the same link cannot be reused", async ({
  page,
  request,
}) => {
  const { email } = await signUpAndVerify(page, request);
  const token = await mintAppealToken(request, email);

  // ---- Open the emailed link, in a FRESH (logged-out) browser state -------
  // The whole point of the token path: a barred user has no session, and the
  // link alone is the authority. Clear the signup session this browser
  // context is still carrying so the token path is what's actually exercised.
  await page.context().clearCookies();

  await page.goto(`/appeal?token=${encodeURIComponent(token)}`);
  await expect(page.locator("textarea[name='body']")).toBeVisible();

  // ---- File it --------------------------------------------------------------
  await page.fill("textarea[name='body']", "I did not do what this action says.");
  await page.click("button[type='submit']");
  await expect(page.locator("#filed")).toBeVisible();

  // ---- The same link cannot be reused (single-use token) --------------------
  await page.goto(`/appeal?token=${encodeURIComponent(token)}`);
  await expect(page.locator("#error")).toBeVisible();
  await expect(page.locator("#error")).toContainText("already been used");
});

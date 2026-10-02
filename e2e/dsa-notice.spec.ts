import { expect, test } from "@playwright/test";

import { API_URL } from "../playwright.config";
import { publishPost, signUpAndVerify } from "./helpers";

import type { APIRequestContext } from "@playwright/test";

/**
 * THE DSA NOTICE INTAKE SPINE (Part of #113, AC-1) — a real browser, SIGNED
 * OUT, files an unauthenticated DSA Art. 16 notice against a published post
 * and confirms it, through the `web` Worker, which reaches `api` only over
 * the Service Binding, against real Postgres and real workerd.
 *
 * ⚠️ Reads the confirmation token via `GET /__test/last-dsa-token` — the SAME
 * test-only seam `readResetToken` (e2e/password-reset.spec.ts) uses for
 * password-reset tokens, standing in for reading the emailed link
 * (Postmark's dev secret makes the real send fail by design; see that
 * function's own comment). Direct api call, on :8788 — the only other place
 * this harness does that.
 *
 * ⚠️ AC-1, END TO END: nothing in this flow is an auto-hide signal. The
 * assertion that closes this test is that the reported post is STILL
 * publicly visible after the notice is filed and confirmed — a notice is
 * queue input for a human only.
 */

async function readDsaToken(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${API_URL}/__test/last-dsa-token`);
  expect(
    response.status(),
    "GET /__test/last-dsa-token failed — did the dsa-notice request succeed, and is TEST_ROUTES=1 set on the api dev server?",
  ).toBe(200);
  const token = (await response.text()).trim();
  expect(token, "dsa token was empty").not.toBe("");
  return token;
}

test("signed-out visitor files a DSA notice against a published post, confirms it, and the post stays public", async ({
  page,
  browser,
  request,
}) => {
  // ---- Seed a published post as a VERIFIED author -------------------------
  await signUpAndVerify(page, page.request);
  const { url } = await publishPost(page, {
    title: "Reportable Post",
    markdownSource: "This post gets DSA-reported in the e2e suite.",
  });

  // ---- The reporter is a FRESH, SIGNED-OUT browser context ----------------
  // Not the author's own session — DSA Art. 16 notice-and-action is
  // unauthenticated by design (apps/api/src/routes/dsa-notice.ts's header),
  // and the test must prove that, not merely exercise the form while
  // incidentally logged in as someone else.
  const reporter = await browser.newContext();
  try {
    const reporterPage = await reporter.newPage();

    await reporterPage.goto(url);

    // The plain, always-visible link — visible to a signed-out viewer,
    // which is the whole point ([handle]/[slug].astro's `.dsa-notice-link`).
    await reporterPage.click('a:has-text("Report illegal content")');
    await expect(reporterPage).toHaveURL(/\/dsa-notice\?post=/);

    await reporterPage.fill('input[name="reporterName"]', "A Concerned Reader");
    await reporterPage.fill('input[name="reporterEmail"]', "dsa-reporter@example.com");
    await reporterPage.selectOption('select[name="reason"]', "ip_infringement");
    await reporterPage.fill(
      'textarea[name="statement"]',
      "This post reproduces my copyrighted work without permission.",
    );
    await reporterPage.check('input[name="goodFaith"]');
    // Turnstile's always-pass test key in this e2e environment — same
    // dev/e2e fallback as e2e/signup.spec.ts / password-reset.spec.ts: no
    // PUBLIC_TURNSTILE_SITE_KEY means the page renders the visible dummy
    // token input instead of the real widget.
    await reporterPage.fill('input[name="turnstileToken"]', "dummy-token");
    await reporterPage.click('button[type="submit"]');

    await expect(reporterPage.locator("#sent")).toBeVisible();

    // ---- Confirm it ---------------------------------------------------------
    const token = await readDsaToken(request);

    await reporterPage.goto(`/dsa-notice/confirm?token=${encodeURIComponent(token)}`);
    await reporterPage.click('button[type="submit"]');
    await expect(reporterPage.locator("#confirmed")).toBeVisible();
  } finally {
    await reporter.close();
  }

  // ---- AC-1, end to end: the reported post is STILL publicly visible ------
  // A fresh, anonymous context — not the reporter's, not the author's — is
  // exactly who a published post is for.
  const reader = await browser.newContext();
  try {
    const readerPage = await reader.newPage();
    const response = await readerPage.goto(url);
    expect(response?.status()).toBe(200);
    await expect(readerPage.locator("#post-body")).toContainText(
      "This post gets DSA-reported in the e2e suite.",
    );
  } finally {
    await reader.close();
  }
});

test("⚠️ an invalid confirmation token is rejected, not silently accepted", async ({ page }) => {
  await page.goto("/dsa-notice/confirm?token=definitely-not-a-real-token");
  await expect(page.locator("#invalid")).toBeVisible();
});

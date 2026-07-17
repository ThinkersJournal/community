/**
 * THE M0 ACCEPTANCE TEST: a real browser drives signup -> verify -> post across
 * BOTH Workers, against real Postgres and real workerd.
 *
 * Everything else in this repo tests a layer. This tests the SPINE, and it is
 * the only thing that exercises the pieces that only exist between the layers:
 * the browser actually storing the session cookie, the `web` Worker forwarding
 * it over the Service Binding, the api resolving a session from it, the CSRF
 * token round-tripping through rendered HTML, and the soft gate flipping from
 * closed to open when — and only when — the email is verified.
 *
 * ⚠️ THE SIGNUP -> VERIFY SEQUENCE NOW LIVES IN e2e/helpers.ts (`signUpAndVerify`),
 * so e2e/publish.spec.ts can reuse it instead of copying it. This file's OWN
 * assertions are unchanged — test 1 still proves a verified user can post, test 2
 * still proves the unverified soft gate is closed. The browser still only ever
 * visits :8787; the api is touched exactly once (reading the token) inside the
 * helper, standing in for the email inbox we have no access to.
 */
import { expect, test } from "@playwright/test";

import { signUp, signUpAndVerify, uniqueEmail } from "./helpers";

test.describe("signup -> verify -> post, across both Workers", () => {
  test("a verified user can create a post", async ({ page, request }) => {
    // ---- 1-3. Sign up, read the token, verify (the extracted spine) ---------
    // signUpAndVerify performs — and asserts — the whole sequence this test used
    // to inline: the 'check your email' state, the browser actually STORING the
    // tj_session cookie, and #verified after the session-carrying verify hop.
    await signUpAndVerify(page, request);

    // ---- 4. THE PAYOFF: posting now succeeds --------------------------------
    // Identical to the negative case below in every respect except that this
    // user verified. The soft gate is the only difference between them.
    // ⚠️ "Save draft" (name="intent" value="draft"), not "Publish": publishing
    // redirects away to /@user/slug (Task 17), which would make this case
    // about the redirect target rather than about the soft gate the test
    // exists to prove. The draft/publish CHOICE itself is proven server-side
    // by apps/api/test/posts.test.ts; this spine test only needs ONE of them
    // to reach the payoff assertion below. (The publish -> public-render path
    // is covered end-to-end in e2e/publish.spec.ts.)
    await page.goto("/new-post");
    await page.fill('input[name="title"]', "My first post");
    await page.fill('textarea[name="markdownSource"]', "Written by a verified account.");
    await page.click('button[name="intent"][value="draft"]');

    await expect(
      page.locator("#saved"),
      "a VERIFIED user could not create a post",
    ).toBeVisible();
    // And specifically NOT blocked by the soft gate.
    await expect(page.locator("#unverified")).toHaveCount(0);
  });

  /**
   * ⚠️ THE NEGATIVE — this is what makes the test above mean something.
   *
   * Without it, "verified user can post" would still pass if the soft gate were
   * deleted entirely, and the whole verification step would be decorative. This
   * proves the gate is CLOSED before verification, so the case above proves
   * verification is what OPENS it.
   *
   * Uses its own fresh, unverified account rather than reordering the flow
   * above: verification is one-way, so a single account cannot demonstrate both
   * sides, and posting-then-verifying in one test would leave the failure
   * ambiguous. Calls `signUp` (NOT `signUpAndVerify`) precisely to stop BEFORE
   * verification.
   */
  test("an UNVERIFIED user is blocked from posting by the soft gate", async ({
    page,
  }) => {
    const email = uniqueEmail("unverified");

    await signUp(page, email);
    await expect(page.locator("#check-email")).toBeVisible();

    // Authenticated (the signup minted a session) but NOT verified. Deliberately
    // no /verify-email visit.
    await page.goto("/new-post");
    await page.fill('input[name="title"]', "Too early");
    await page.fill('textarea[name="markdownSource"]', "This account never verified.");
    await page.click('button[name="intent"][value="draft"]');

    await expect(
      page.locator("#unverified"),
      "an UNVERIFIED user was not stopped by the soft gate",
    ).toBeVisible();
    // The post must NOT have been created.
    await expect(page.locator("#saved")).toHaveCount(0);
    await expect(page.locator("#published")).toHaveCount(0);

    // ⚠️ Distinguishes the SOFT GATE (403 EMAIL_NOT_VERIFIED) from the other
    // ways this page can fail. #unverified is only rendered after the request
    // cleared origin + session + CSRF + epoch and was stopped by the gate
    // itself; a CSRF/origin 403 renders #error and a dead session renders
    // #session-expired. Without this, a broken CSRF token could masquerade as a
    // working gate.
    await expect(page.locator("#error")).toHaveCount(0);
    await expect(page.locator("#session-expired")).toHaveCount(0);
  });
});

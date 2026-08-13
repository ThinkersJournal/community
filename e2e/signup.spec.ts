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
 *
 * ⚠️ HANDLE-AT-SIGNUP adds a second concern this file now covers: the @handle
 * itself is chosen right on this form (no more separate onboarding page for
 * claiming one — see e2e/helpers.ts's `signUp`), so below the verify spine
 * this file also proves the handle is LIVE the moment signup succeeds, and
 * that a second signup cannot steal one already taken.
 */
import { expect, test } from "@playwright/test";

import { signUp, signUpAndVerify, uniqueEmail, uniqueHandle } from "./helpers";

test.describe("signup -> verify -> post, across both Workers", () => {
  test("a verified user can create a post", async ({ page, request }) => {
    // ---- 1-3. Sign up, read the token, verify (the extracted spine) ---------
    // signUpAndVerify performs — and asserts — the whole sequence this test used
    // to inline: the 'check your email' state, the browser actually STORING the
    // tj_session cookie, and #verified after the session-carrying verify hop.
    await signUpAndVerify(page, request);

    // ⚠️ HANDLE-AT-SIGNUP. The editor's old handle gate (a not-yet-onboarded
    // visitor got a "choose your handle" prompt instead of the form —
    // formerly proven by e2e/social.spec.ts's onboarding test) is gone:
    // `signUpAndVerify` already produced a full account with a handle, so the
    // editor form is reachable directly. Nothing left to do here but go.

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
   *
   * ⚠️ HANDLE-AT-SIGNUP REWRITE. This used to be blocked one hop EARLIER, at
   * editor-open, by a since-removed "not onboarded" gate that then routed
   * through a since-deleted handle-claiming page to surface this same
   * EMAIL_NOT_VERIFIED error. Handle-at-signup deletes both: every signed-up
   * account — verified or not — already has its handle, so the editor form
   * now renders immediately for this user too (there is nothing left to
   * "onboard"). The underlying security property THIS TEST EXISTS TO PROVE is
   * unchanged — an unverified user cannot get a post saved — it is just
   * enforced exactly where it always logically belonged: on the POST itself
   * (apps/web/src/pages/new-post.astro's `EMAIL_NOT_VERIFIED` branch ->
   * `#unverified`), which is now the ONLY place it can fire from.
   */
  test("an UNVERIFIED user is blocked from posting by the soft gate", async ({
    page,
  }) => {
    const email = uniqueEmail("unverified");
    // ⚠️ Short prefix: uniqueHandle appends a 16-char hex suffix + "_" (17
    // chars), and the signup form's handle field caps at `maxlength="30"` —
    // a longer prefix like "stillunverified" (15) pushes the total to 32,
    // over the limit.
    const handle = uniqueHandle("unv");

    await signUp(page, email, handle);
    await expect(page.locator("#check-email")).toBeVisible();

    // Authenticated (the signup minted a session, and a handle) but NOT
    // verified. Deliberately no /verify-email visit.
    await page.goto("/new-post");

    // The editor form renders — handle-at-signup means there is no more
    // "choose a handle first" detour to fall through before reaching it.
    await expect(page.locator("#editor-form")).toBeVisible();

    await page.fill('input[name="title"]', "Should never save");
    await page.fill('textarea[name="markdownSource"]', "Written by an unverified account.");
    await page.click('button[name="intent"][value="draft"]');

    await expect(
      page.locator("#unverified"),
      "an UNVERIFIED user was not stopped by the email-verification soft gate on POST /new-post",
    ).toBeVisible();
    // And specifically NOT saved.
    await expect(page.locator("#saved")).toHaveCount(0);
  });
});

test.describe("signup with a chosen @handle", () => {
  test("signs up choosing a permanent @handle", async ({ page, request }) => {
    const { username } = await signUpAndVerify(page, request);

    // The handle is live the instant signup succeeds — no separate claim
    // step, no delay: the author page resolves right away.
    //
    // ⚠️ ASSERT THE RESPONSE STATUS, NOT JUST THE URL. `page.goto()` does NOT
    // throw on a 4xx, and apps/web/src/pages/[handle]/index.astro answers an
    // UNKNOWN handle with a bare 404 at this EXACT url shape — no redirect
    // elsewhere. A `toHaveURL` check alone would pass identically whether the
    // profile actually rendered (200) or 404'd, which is precisely the
    // signup->profile linkage this test exists to prove, so it would not
    // fail even if that linkage were broken. The status check below is the
    // load-bearing assertion; `[data-social-counts]` (only present on a real
    // profile render, never on the 404's empty body) is belt-and-braces.
    const response = await page.goto(`/@${username}`);
    expect(
      response?.status(),
      "the author page did not resolve (404?) for a handle just chosen at signup",
    ).toBe(200);
    await expect(page.locator("[data-social-counts]")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/@${username}$`));
  });

  /**
   * ⚠️ THE COLLISION CASE. `signUp` (not `signUpAndVerify`) deliberately: the
   * second account never needs to exist for this — the api's USERNAME_TAKEN
   * check (apps/api/src/routes/signup.ts) must reject the collision BEFORE
   * any account is created, so there is nothing here to verify or clean up.
   * A fresh browser context for the second attempt keeps the first account's
   * session out of the way — this is two DIFFERENT people racing for the same
   * handle, not one person retrying.
   */
  test("rejects a handle already taken, offering suggestions", async ({
    page,
    request,
    browser,
  }) => {
    const { username } = await signUpAndVerify(page, request);

    const ctx = await browser.newContext();
    try {
      const p2 = await ctx.newPage();
      await signUp(p2, uniqueEmail("dupe"), username); // reuse the taken handle

      await expect(
        p2.locator("#error"),
        "a duplicate handle was not rejected with a 'taken' message",
      ).toContainText(/taken/i);
      // Rejected, not signed up: still on the signup form, not "check your
      // email" — no account was created for the collision.
      await expect(p2.locator("#check-email")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});

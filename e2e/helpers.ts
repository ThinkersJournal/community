/**
 * SHARED E2E HELPERS — the two-Worker spine, factored out of the specs.
 *
 * ⚠️ THIS IS A HELPER MODULE, NOT A SPEC. It registers no tests, so importing it
 * cannot double-register anything (the concern e2e/resend-verification.spec.ts's
 * header raises about importing a *spec* module does not apply here). The signup
 * → fetch-token → verify sequence lived inline in e2e/signup.spec.ts; it moved
 * here VERBATIM so e2e/publish.spec.ts does not own a second copy of it, and
 * signup.spec.ts now calls `signUpAndVerify` while keeping its own tail
 * assertions (the posting payoff and the unverified negative).
 *
 * ⚠️ THE BROWSER ONLY EVER VISITS :8787 (the `web` Worker). The api is touched
 * exactly ONCE, out of band, to read the verification token — standing in for
 * the email inbox we have no access to. See `readVerificationToken`. Every other
 * step drives the real browser at :8787. Do not add direct api calls: vitest
 * already covers the api, and nothing else covers this spine.
 */
import { expect } from "@playwright/test";

import { API_URL } from "../playwright.config";

import type { APIRequestContext, Page } from "@playwright/test";

/**
 * A password that satisfies the api's zod schema (>= 12 chars). The password is
 * not what any of these tests is about.
 */
const PASSWORD = "correct-horse-battery-staple";

/**
 * A brand-new address for every run.
 *
 * ⚠️ NOT a fixed address, and NOT cleaned up. The E2E writes through the real
 * signup path into the real dev database and those rows PERSIST, so a constant
 * email would 409 ("already registered") on the second run — the suite would
 * pass exactly once and then fail forever. A random address also keeps
 * concurrent runs from colliding, and keeps this suite from truncating tables
 * out from under `pnpm --filter @thinkersjournal/api test`, which uses a
 * different database but the same server.
 */
export function uniqueEmail(prefix: string): string {
  return `e2e-${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Read the token the api just emailed — the one step a browser cannot do.
 *
 * In production the user gets this from their inbox. Here Postmark is
 * configured with a dummy token so the send FAILS (by design: it logs and
 * returns, because a mail failure must never 500 a signup), and the api instead
 * stashes the raw token in KV for `GET /__test/last-verify-token` to hand back.
 * That route only exists when `TEST_ROUTES === "1"`; in production it 404s like
 * any path that was never defined.
 *
 * ⚠️ Hits the api DIRECTLY on :8788 because it must: the route lives on the api,
 * and the `web` Worker neither proxies it nor should. This is the ONLY direct
 * api call in the whole E2E harness.
 */
async function readVerificationToken(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${API_URL}/__test/last-verify-token`);

  // A 404 here means either "no token issued" (the signup silently failed) or
  // TEST_ROUTES is unset. Both are setup faults, not assertion failures — say so
  // rather than letting an empty token produce a baffling "invalid link" later.
  expect(
    response.status(),
    "GET /__test/last-verify-token failed — did signup succeed, and is TEST_ROUTES=1 set on the api dev server?",
  ).toBe(200);

  const token = (await response.text()).trim();
  expect(token, "verification token was empty").not.toBe("");
  return token;
}

/** Sign up through the real form in the real browser. */
export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/signup");

  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  // A real Turnstile widget (M1) will populate this; for now it is a plain
  // input, and the api runs with Cloudflare's always-passes dummy secret, so
  // any non-empty value clears the bot check.
  await page.fill('input[name="turnstileToken"]', "dummy-turnstile-token");

  await page.click('button[type="submit"]');
}

/**
 * The full signup → fetch-token → verify spine, ending on a live VERIFIED
 * session in `page`'s context. Extracted verbatim from e2e/signup.spec.ts.
 *
 * ⚠️ RETURNS `{ email }` ONLY — NOT `{ email, username }`, a DELIBERATE deviation
 * from the task brief's stated interface, and the honest one. Signup MINTS the
 * username (apps/api/src/routes/signup.ts's `generateUsername`) as
 * `<sanitized-local-part>_<~64-bit random base36 suffix>`, so it is NOT derivable
 * from the email, and NO route surfaces it to the browser except the editor's
 * own publish redirect (`/@<username>/<slug>`). Having this helper learn it would
 * mean publishing a probe post — which would give EVERY signed-up user a
 * published post and break the draft-only / single-post-listing assertions in
 * publish.spec. So the username is discovered per-test from the publish each test
 * already performs (see `publishPost`), and this helper stays side-effect-free
 * beyond the account it creates.
 */
export async function signUpAndVerify(
  page: Page,
  request: APIRequestContext,
): Promise<{ email: string }> {
  const email = uniqueEmail("verified");

  // ---- 1. Sign up ----------------------------------------------------------
  await signUp(page, email);

  await expect(
    page.locator("#check-email"),
    "signup did not reach the 'check your email' state",
  ).toBeVisible();

  // ⚠️ THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BLOCKER. The api
  // mints the session on 201, `web` propagates the Set-Cookie, and the browser
  // must actually STORE it. With production cookie attributes
  // (`Domain=.thinkersjournal.com; Secure`) no browser can store it on
  // http://127.0.0.1 — it is silently dropped, and every step below fails with
  // a misleading "please log in". Pinned here so that failure is named at the
  // point it happens. (apps/api/src/auth/session.ts relaxes exactly those two
  // attributes when TEST_ROUTES=1; test/session.test.ts pins BOTH modes.)
  const cookies = await page.context().cookies();
  expect(
    cookies.find((c) => c.name === "tj_session"),
    "the browser did not store the tj_session cookie — check the cookie's Domain/Secure attributes for dev",
  ).toBeDefined();

  // ---- 2. Read the token the api "emailed" ---------------------------------
  const token = await readVerificationToken(request);

  // ---- 3. Verify, CARRYING THE SIGNUP SESSION ------------------------------
  // ⚠️ Same browser context, so the session cookie rides along — that is the
  // whole point. `GET /verify-email` REQUIRES a live, non-stale session
  // belonging to the token's own user (it closes an account-takeover chain:
  // holding the link is not proof of holding the password). With no session it
  // answers 401 LOGIN_REQUIRED and the page renders #login-required instead.
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);

  await expect(
    page.locator("#verified"),
    "verification failed — the signup session was probably not carried to /verify-email",
  ).toBeVisible();

  return { email };
}

/** What `publishPost` resolves to once the post is live at its public URL. */
export interface PublishedPost {
  /** The author's minted username (random-suffixed; only knowable from here). */
  username: string;
  /** The slug the api derived from the title. */
  slug: string;
  /** The post's DB id — needed to re-open the editor at `/new-post?post=<id>`. */
  postId: string;
  /** The absolute public URL, `http://127.0.0.1:8787/@<username>/<slug>`. */
  url: string;
}

/**
 * Author a post through the real editor and PUBLISH it, returning everything the
 * public page cannot tell you: the author's username, the slug, and the post id.
 *
 * ⚠️ SAVES A DRAFT FIRST, THEN PUBLISHES — and that two-step is load-bearing, not
 * laziness. The post id appears NOWHERE on the public page or the profile, and
 * the publish redirect (`/@user/slug`) does not carry it either; the editor's
 * draft-save redirect (`/new-post?post=<id>&saved=1`) is the ONLY browser-visible
 * source of it. So we save a draft to learn the id, then click Publish, which
 * PATCHes that same draft to `published` (the slug is preserved across the
 * PATCH — apps/api/src/routes/posts.ts's UPDATE never re-slugifies). The
 * intermediate draft is invisible to every other test.
 *
 * The username + slug are then parsed out of the publish redirect URL — the
 * single browser-reachable place the minted username is ever exposed.
 */
export async function publishPost(
  page: Page,
  post: { title: string; markdownSource: string },
): Promise<PublishedPost> {
  await page.goto("/new-post");
  await page.fill("#title", post.title);
  await page.fill("#markdownSource", post.markdownSource);

  // Draft-save to surface the id, then publish.
  await page.click("button[value='draft']");
  await expect(page.locator("#saved")).toBeVisible();
  const postId = new URL(page.url()).searchParams.get("post");
  expect(postId, "draft save did not surface ?post=<id> in the URL").not.toBeNull();

  await page.click("button[value='publish']");
  // The editor redirects to the public page on a successful publish.
  await page.waitForURL(/\/@[^/]+\/[^/]+$/);

  const { pathname, href } = new URL(page.url());
  // pathname is "/@<username>/<slug>" -> ["", "@<username>", "<slug>"].
  const segments = pathname.split("/");
  const username = segments[1]!.replace(/^@/, "");
  const slug = segments[2]!;

  return { username, slug, postId: postId!, url: href };
}

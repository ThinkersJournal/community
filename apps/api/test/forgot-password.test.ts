import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { anonymiseExpiredAccounts } from "../src/auth/anonymise-accounts";
import { createResetToken } from "../src/auth/password-reset";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";
import { awaitLimiterBurstWindow } from "./helpers/limiter-window";

/**
 * #70 — `POST /auth/forgot-password`. Runs in the POOL project (real
 * workerd): needs `HYPERDRIVE_FRESH` and `RESET_LIMITER`.
 *
 * ⚠️ Global `fetch` is stubbed (Turnstile + Postmark) in every case — see
 * `stubFetch`. Restored in `afterEach` so the stub cannot leak into sibling
 * pool test files sharing this workerd isolate. Mirrors test/signup.test.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";
const CANONICAL_ORIGIN = "https://community.thinkersjournal.com";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Same stub shape as test/signup.test.ts's — both outbound calls this route can make. */
function stubFetch(turnstileSuccess: boolean): RequestInit[] {
  const postmarkCalls: RequestInit[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.startsWith("https://challenges.cloudflare.com/")) {
        return new Response(JSON.stringify({ success: turnstileSuccess }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.postmarkapp.com/")) {
        postmarkCalls.push(init ?? {});
        return new Response(JSON.stringify({ ErrorCode: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );

  return postmarkCalls;
}

function postmarkBody(calls: RequestInit[], index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.body)) as Record<string, unknown>;
}

/** Pull the raw reset token out of a captured Postmark send's mailed link. */
function tokenFromMail(calls: RequestInit[], index = 0): string {
  const match = /\/reset-password\?token=([^"\\<\s]+)/.exec(
    String(postmarkBody(calls, index).TextBody),
  );
  expect(match, "no reset link found in the mailed body").not.toBeNull();
  return decodeURIComponent(match![1]!);
}

function forgotPasswordRequest(
  body: unknown,
  headers: Record<string, string> = { Origin: ALLOWED_ORIGIN },
): Request {
  return new Request("https://api.test/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function forgotPassword(
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetchWorker(forgotPasswordRequest(body, headers));
}

function validBody(email: string) {
  return { email, turnstileToken: "dummy-turnstile-token" };
}

function uniqueEmail(): string {
  return `forgot_${crypto.randomUUID().replace(/-/g, "")}@example.com`;
}

/** Read back the email `createVerifiedActor` minted (it does not return it). */
async function lookupEmail(userId: string): Promise<string | null> {
  const ctx = createExecutionContext();
  const email = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      userId,
    ]);
    return rows[0]?.email ?? null;
  });
  await waitOnExecutionContext(ctx);
  return email;
}

beforeEach(async () => {
  // Reset tokens' TEST-ONLY stash lives in SESSIONS (see
  // TEST_LAST_RESET_TOKEN_KEY's header); clear it so each case is
  // independent of the last. Mirrors test/email-verify.test.ts /
  // test/resend-verification.test.ts's identical setup.
  let cursor: string | undefined;
  do {
    const result = await env.SESSIONS.list(cursor ? { cursor } : undefined);
    await Promise.all(result.keys.map((k) => env.SESSIONS.delete(k.name)));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor !== undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await deleteCreatedUsers();
});

describe("POST /auth/forgot-password", () => {
  it("202s and mails a reset link for a REGISTERED email", async () => {
    const postmarkCalls = stubFetch(true);
    const actor = await createVerifiedActor();
    // createVerifiedActor doesn't expose the email it minted — look it up.
    const email = (await lookupEmail(actor.userId))!;
    const response = await forgotPassword(validBody(email));

    expect(response.status).toBe(202);
    expect(postmarkCalls).toHaveLength(1);
    const body = postmarkBody(postmarkCalls);
    expect(String(body.TextBody)).toContain(`${CANONICAL_ORIGIN}/reset-password?token=`);
    expect(String(body.HtmlBody)).toContain(`${CANONICAL_ORIGIN}/reset-password?token=`);
  });

  /**
   * ⚠️ THE WHOLE POINT OF THIS ROUTE'S DESIGN — see its own header's NO USER
   * ENUMERATION note. Same status, same (empty) body, no distinguishing
   * error, for an email that has never been registered.
   */
  it("202s IDENTICALLY for an UNREGISTERED email — and sends no mail", async () => {
    const postmarkCalls = stubFetch(true);

    const response = await forgotPassword(validBody(uniqueEmail()));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(postmarkCalls).toHaveLength(0);
  });

  it("the redeemable token round-trips through /auth/reset-password", async () => {
    const postmarkCalls = stubFetch(true);
    const actor = await createVerifiedActor();
    const email = (await lookupEmail(actor.userId))!;

    expect((await forgotPassword(validBody(email))).status).toBe(202);
    const token = tokenFromMail(postmarkCalls);

    const reset = await fetchWorker(
      new Request("https://api.test/auth/reset-password", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ token, password: "correct-horse-battery-staple" }),
      }),
    );
    expect(reset.status).toBe(200);
    expect(reset.headers.get("Set-Cookie")).not.toBeNull();
  });

  it("400s invalid input (malformed email)", async () => {
    const response = await forgotPassword({ email: "not-an-email", turnstileToken: "t" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("400s malformed JSON", async () => {
    const response = await fetchWorker(
      new Request("https://api.test/auth/forgot-password", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_JSON");
  });

  it("403s without an allowed Origin — before any parsing/DB work", async () => {
    const response = await forgotPassword(validBody(uniqueEmail()), {});
    expect(response.status).toBe(403);
  });

  it("403s on a failed Turnstile challenge, for a REGISTERED email too (never a distinguishing signal)", async () => {
    stubFetch(false);
    const actor = await createVerifiedActor();
    const email = (await lookupEmail(actor.userId))!;

    const response = await forgotPassword(validBody(email));
    expect(response.status).toBe(403);
  });

  /**
   * `RESET_LIMITER` is 5/60s (wrangler.jsonc) and the local pool REALLY
   * enforces it. Turnstile stubbed to BLOCK so each allowed request costs a
   * cheap 403 — the limiter counts it either way, and runs BEFORE Turnstile
   * (same order as signup/login).
   */
  it(
    "429s once over the rate limit (5/60s per ip+email)",
    async () => {
      stubFetch(false);
      const body = validBody(uniqueEmail());
      await awaitLimiterBurstWindow();

      for (let i = 0; i < 5; i++) {
        expect((await forgotPassword(body)).status).toBe(403);
      }
      expect((await forgotPassword(body)).status).toBe(429);
    },
    60_000,
  );
});

/**
 * `GET /__test/last-reset-token` — the E2E test seam `createResetToken`
 * stashes into, mirroring `GET /__test/last-verify-token`'s gate exactly
 * (see src/routes/__test.ts's header). test/email-verify.test.ts owns the
 * exhaustive gate matrix for that sibling route; this pins the SAME two
 * properties for this one rather than assuming they transfer.
 */
describe("GET /__test/last-reset-token", () => {
  it("returns the last raw token when TEST_ROUTES is set, and it matches the mailed one", async () => {
    const postmarkCalls = stubFetch(true);
    const actor = await createVerifiedActor();
    const email = (await lookupEmail(actor.userId))!;
    expect((await forgotPassword(validBody(email))).status).toBe(202);
    const mailed = tokenFromMail(postmarkCalls);

    const stashed = await fetchWorker(new Request("https://api.test/__test/last-reset-token"));
    expect(stashed.status).toBe(200);
    expect(await stashed.text()).toBe(mailed);
  });

  it("404s when TEST_ROUTES is unset — same as a nonexistent route", async () => {
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/last-reset-token"),
      prodEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("does not stash the raw token when TEST_ROUTES is unset", async () => {
    // `password_reset_tokens.user_id` is a real FK (unlike verification
    // tokens, which live in KV with no such constraint) — a made-up id would
    // mint nothing (createResetToken's INSERT … SELECT finds no row), so this
    // needs a real user, not a random uuid.
    const actor = await createVerifiedActor();
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;
    const ctx = createExecutionContext();

    await createResetToken(prodEnv, ctx, actor.userId);
    await waitOnExecutionContext(ctx);

    expect(await env.SESSIONS.get("__test:last-reset-token")).toBeNull();
  });
});

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => (await c.query(text, params)).rows as T[]);
  await waitOnExecutionContext(ctx);
  return rows;
}

/**
 * AH-7, structural (account-legal-hold spec §4a, PM ruling B). A deleted,
 * banned account's real address is no longer on its row, and forgot-password
 * reads only `users.email`, so it needs no guard of its own: it finds nothing
 * and mails nothing. The reaper reads the SHARED DB and other files run it in
 * parallel, so the fixture gets a unique far-past `deletion_requested_at` and
 * only its end state is asserted.
 */
describe("AH-7 — forgot-password for a deleted, banned account's original address", () => {
  it("202 with NO Postmark call and no reset token once the reaper has anonymised it (CONTROL: 1 call before)", async () => {
    const actor = await createVerifiedActor();
    const email = (await lookupEmail(actor.userId))!;
    await sql(
      `UPDATE users
          SET disabled_at = now(), disabled_reason = 'ban',
              deletion_requested_at = timestamptz '2000-01-01' + (random() * interval '1000 days')
        WHERE id = $1`,
      [actor.userId],
    );

    // CONTROL, before the reaper: the same request reaches the account and mails it.
    const before = stubFetch(true);
    expect((await forgotPassword(validBody(email))).status).toBe(202);
    expect(before).toHaveLength(1);
    vi.unstubAllGlobals();

    const ctx = createExecutionContext();
    await anonymiseExpiredAccounts(env, ctx);
    await waitOnExecutionContext(ctx);
    const [row] = await sql<{ anonymised_at: Date | null }>("SELECT anonymised_at FROM users WHERE id = $1", [
      actor.userId,
    ]);
    expect(row!.anonymised_at, "precondition: the reaper did not anonymise the fixture").not.toBeNull();

    const after = stubFetch(true);
    const response = await forgotPassword(validBody(email));

    expect(response.status).toBe(202);
    expect(after).toHaveLength(0);
    expect(
      await sql("SELECT 1 FROM password_reset_tokens WHERE user_id = $1", [actor.userId]),
    ).toEqual([]);
  });
});

/**
 * Account-legal-hold (PM ruling B). forgot-password reads `id, email`, then
 * mints a token; a scrub can commit in between. `createResetToken` therefore
 * inserts only for a row that is not anonymised, and forgot-password mails
 * only when a token was minted, answering the same 202 either way.
 */
describe("AH-7 — no reset token or mail for an anonymised account", () => {
  async function anonymise(userId: string): Promise<string> {
    const sentinel = `deleted-${userId}@invalid.thinkersjournal.local`;
    await sql("UPDATE users SET anonymised_at = now(), email = $2, password_hash = '!anonymised!' WHERE id = $1", [
      userId,
      sentinel,
    ]);
    return sentinel;
  }

  it("createResetToken on an anonymised id returns null and inserts nothing", async () => {
    const actor = await createVerifiedActor();
    await anonymise(actor.userId);

    const ctx = createExecutionContext();
    const token = await createResetToken(env, ctx, actor.userId);
    await waitOnExecutionContext(ctx);

    expect(token).toBeNull();
    expect(await sql("SELECT 1 FROM password_reset_tokens WHERE user_id = $1", [actor.userId])).toEqual([]);
  });

  it("a request that reaches an anonymised row sends no mail and answers exactly as the normal case", async () => {
    // The sentinel address is the one thing a request can name that still
    // finds the row after the scrub, so it stands in for the race window.
    const normal = await createVerifiedActor();
    const normalEmail = (await lookupEmail(normal.userId))!;
    const deleted = await createVerifiedActor();
    const sentinel = await anonymise(deleted.userId);

    const normalCalls = stubFetch(true);
    const normalRes = await forgotPassword(validBody(normalEmail));
    expect(normalCalls, "CONTROL: the normal case mails").toHaveLength(1);
    vi.unstubAllGlobals();

    const calls = stubFetch(true);
    const res = await forgotPassword(validBody(sentinel));

    expect(res.status).toBe(normalRes.status);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(await normalRes.text());
    expect(calls).toHaveLength(0);
    expect(await sql("SELECT 1 FROM password_reset_tokens WHERE user_id = $1", [deleted.userId])).toEqual([]);
  });
});

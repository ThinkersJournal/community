import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { csrfTokenFor } from "../src/auth/csrf";
import { createSession, readSession } from "../src/auth/session";
import { withClient } from "../src/db/client";
import { ROUTES } from "../src/routes";

import { PIPELINE_EXEMPT } from "./helpers/pipeline-exempt";

import type { SessionData } from "@thinkersjournal/shared";
import type { RouteDef } from "../src/routing";

/**
 * ISSUE #50 — the MUTATING PIPELINE refuses a barred user (design spec
 * 2026-09-06-m4-moderation-queue-design.md:174, the half #35 left open).
 *
 * ⚠️ THE CENSUS IS THIS FILE, NOT A CHECKLIST. The population below is every
 * non-GET route in ROUTES minus PIPELINE_EXEMPT — the same population
 * test/route-protection.test.ts holds to default-deny — so a route added
 * tomorrow is held to the bar the moment it is registered, whether or not its
 * author thought about barring. The refusal lives in `runMutatingPipeline`
 * with no per-route opt-out (PM ruling on #50, Q1), so there is no list for
 * anyone to keep complete.
 *
 * Per route, four arms:
 *   • AC-1 DISABLED       -> 403 ACCOUNT_BARRED + cleared cookie + KV session
 *                            destroyed (#50 Q2: CireSnave ruled a barred user is
 *                            told so, not handed a 401 that reads as "logged out").
 *   • AC-2 SUSPENDED      -> the same.
 *   • AC-3 LAPSED         -> NOT refused: an expired suspension bars nothing
 *                            (mirrors login; diverges from the reaper on purpose,
 *                            see src/auth/account-status.ts vs reap-unverified.ts).
 *   • AC-4 CONTROL        -> NOT refused: an ordinary verified session on the SAME
 *                            route with the SAME request. Without it, AC-1/AC-2's
 *                            refusal would be indistinguishable from "this probe
 *                            is refused for some other reason".
 *
 * AC-3/AC-4 assert only "neither 401 nor ACCOUNT_BARRED", not success: the probe body is generic and
 * most handlers 400 it after the pipeline. What they prove is that the PIPELINE
 * let the request through — which is the only thing this suite is about.
 *
 * Runs in the POOL project (real workerd): real SESSIONS KV, real
 * HYPERDRIVE_FRESH Postgres, real USER_SECURITY Durable Object.
 */

// A valid PHC-encoded argon2id string for the NOT NULL column; no password is
// ever verified here (sessions are minted directly, as login would).
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/** An origin in `checkOrigin`'s allowlist (the suite runs TEST_ROUTES=1). */
const ALLOWED_ORIGIN = "http://localhost:8787";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length === 0) return;
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]),
  );
  await waitOnExecutionContext(ctx);
  createdUserIds.length = 0;
});

type Status = "disabled" | "suspended" | "lapsed" | "ordinary";

/** A verified user (with its profile — every real user has one) in `status`. */
async function insertUser(status: Status, verified = true): Promise<string> {
  const now = Date.now();
  const disabledAt = status === "disabled" ? new Date(now) : null;
  const suspendedUntil =
    status === "suspended" ? new Date(now + DAY_MS) : status === "lapsed" ? new Date(now - DAY_MS) : null;

  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (email, password_hash, email_verified_at, disabled_at, suspended_until)
       VALUES ($1, $2, ${verified ? "now()" : "NULL"}, $3, $4) RETURNING id`,
      [`p50_${crypto.randomUUID()}@example.com`, PASSWORD_HASH, disabledAt, suspendedUntil],
    );
    const userId = rows[0].id as string;
    await c.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [
      userId,
      `p50_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ]);
    return userId;
  });
  await waitOnExecutionContext(ctx);
  createdUserIds.push(id);
  return id;
}

interface Authed {
  token: string;
  csrfToken: string;
}

/** Mint a session stamped with the user's CURRENT epoch, exactly as login does. */
async function authenticate(userId: string): Promise<Authed> {
  const securityEpoch = await env.USER_SECURITY.getByName(userId).getEpoch();
  const data: SessionData = {
    userId,
    roles: ["member"],
    securityEpoch,
    csrfSecret: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  const { cookie } = await createSession(env, data);
  const match = /^tj_session=([^;]*)/.exec(cookie);
  if (match === null) throw new Error(`unexpected cookie shape: ${cookie}`);
  return { token: match[1]!, csrfToken: await csrfTokenFor(data) };
}

function label(route: RouteDef): string {
  return `${route.method} ${route.pattern}`;
}

const PARAM_SAMPLES: Readonly<Record<string, string>> = {
  id: "00000000-0000-7000-8000-000000000000",
  followeeId: "00000000-0000-7000-8000-000000000000",
  blockedId: "00000000-0000-7000-8000-000000000000",
};

function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((s) => (s.startsWith(":") ? (PARAM_SAMPLES[s.slice(1)] ?? "sample") : s))
    .join("/");
}

/** A fully authenticated request: allowed Origin, session cookie, CSRF token. */
function authedRequest(route: RouteDef, authed: Authed): Request {
  return new Request(`https://api.test${concretePath(route.pattern)}`, {
    method: route.method,
    headers: {
      "content-type": "application/json",
      Origin: ALLOWED_ORIGIN,
      Cookie: `tj_session=${authed.token}`,
      "X-CSRF-Token": authed.csrfToken,
    },
    body: "{}",
  });
}

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Is `token`'s KV session record still live? */
async function sessionLive(token: string): Promise<boolean> {
  const probe = new Request("https://api.test/", { headers: { Cookie: `tj_session=${token}` } });
  return (await readSession(env, probe)) !== null;
}

const PIPELINE_ROUTES = ROUTES.filter(
  (r) => r.method !== "GET" && r.method !== "HEAD" && !PIPELINE_EXEMPT.has(label(r)),
);
const CASES = PIPELINE_ROUTES.map((r) => [label(r), r] as const);

/** Neither the session refusal (401) nor the bar (403 ACCOUNT_BARRED). Other 403s/400s are the handler's own business. */
async function expectNotRefused(res: Response): Promise<void> {
  expect(res.status).not.toBe(401);
  expect(await res.text()).not.toContain("ACCOUNT_BARRED");
}

describe("#50 — every pipeline route refuses a barred session", () => {
  it("the population is non-empty and is the route-protection population", () => {
    // 24 at 758912a. Printed rather than pinned: the point is that the suite
    // follows ROUTES, so a count pin would only make adding a route noisy.
    expect(PIPELINE_ROUTES.length).toBeGreaterThan(0);
    console.log(`#50 census: ${PIPELINE_ROUTES.length} pipeline routes: ${PIPELINE_ROUTES.map(label).join(", ")}`);
  });

  it.each(CASES)("AC-1 %s — a DISABLED account's live session is refused and destroyed", async (_name, route) => {
    const authed = await authenticate(await insertUser("disabled"));
    const res = await fetchWorker(authedRequest(route, authed));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "banned" } });
    expect(res.headers.get("Set-Cookie") ?? "").toMatch(/Max-Age=0/);
    expect(await sessionLive(authed.token)).toBe(false);
  });

  it.each(CASES)("AC-2 %s — a currently-SUSPENDED account's live session is refused and destroyed", async (_name, route) => {
    const authed = await authenticate(await insertUser("suspended"));
    const res = await fetchWorker(authedRequest(route, authed));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { barred: { kind: string } }).barred.kind).toBe("suspended");
    expect(res.headers.get("Set-Cookie") ?? "").toMatch(/Max-Age=0/);
    expect(await sessionLive(authed.token)).toBe(false);
  });

  it.each(CASES)("AC-3 %s — a LAPSED suspension does not bar", async (_name, route) => {
    const authed = await authenticate(await insertUser("lapsed"));
    const res = await fetchWorker(authedRequest(route, authed));

    await expectNotRefused(res);
  });

  it.each(CASES)("AC-4 CONTROL %s — an ordinary verified session passes the pipeline", async (_name, route) => {
    const authed = await authenticate(await insertUser("ordinary"));
    const res = await fetchWorker(authedRequest(route, authed));

    await expectNotRefused(res);
  });
});

describe("#50 — the refusal's shape", () => {
  const POST_POSTS = ROUTES.find((r) => r.method === "POST" && r.pattern === "/posts")!;

  // #50 Q2 (CireSnave: "If returning that they are banned lets us tell them
  // why, we should do that.") supersedes the Q1-era "byte-identical to a
  // revocation" pin. Only the session's own holder can reach this branch, so
  // it tells a stranger nothing; the cookie handling stays identical.
  it("a barred refusal is a DISTINCT 403 ACCOUNT_BARRED, with the SAME cleared cookie as an epoch revocation", async () => {
    const barred = await authenticate(await insertUser("disabled"));
    const barredRes = await fetchWorker(authedRequest(POST_POSTS, barred));

    const revokedUser = await insertUser("ordinary");
    const revoked = await authenticate(revokedUser);
    await env.USER_SECURITY.getByName(revokedUser).bumpEpoch();
    const revokedRes = await fetchWorker(authedRequest(POST_POSTS, revoked));

    expect(revokedRes.status).toBe(401);
    expect(barredRes.status).toBe(403);
    expect(((await barredRes.json()) as { code: string }).code).toBe("ACCOUNT_BARRED");
    expect(barredRes.headers.get("Set-Cookie")).toBe(revokedRes.headers.get("Set-Cookie"));
  });

  it("a suspension's `until` is the stored suspended_until, as ISO-8601", async () => {
    const userId = await insertUser("suspended");
    const authed = await authenticate(userId);
    const res = await fetchWorker(authedRequest(POST_POSTS, authed));

    const ctx = createExecutionContext();
    const stored = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ suspended_until: Date }>("SELECT suspended_until FROM users WHERE id = $1", [userId]);
      return rows[0]!.suspended_until;
    });
    await waitOnExecutionContext(ctx);
    expect(await res.json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "suspended", until: stored.toISOString() } });
  });

  it("the bar runs BEFORE the verified-email gate — a barred UNVERIFIED user gets ACCOUNT_BARRED, not EMAIL_NOT_VERIFIED", async () => {
    // Order matters: answering EMAIL_NOT_VERIFIED would leave the session live
    // and send the barred user into the verify-email flow.
    const authed = await authenticate(await insertUser("disabled", false));
    const res = await fetchWorker(authedRequest(POST_POSTS, authed));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("ACCOUNT_BARRED");
    expect(await sessionLive(authed.token)).toBe(false);
  });

  it("CONTROL: an ordinary UNVERIFIED user still gets the 403 EMAIL_NOT_VERIFIED", async () => {
    const authed = await authenticate(await insertUser("ordinary", false));
    const res = await fetchWorker(authedRequest(POST_POSTS, authed));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });
});

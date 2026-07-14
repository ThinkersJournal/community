import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "../src";
import { createSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * Task 13 — the SOFT email-verification gate: unverified users may
 * READ/browse freely, but CONTENT MUTATION (here, `POST /posts`) requires a
 * verified email. `GET /posts` proves reads stay open regardless.
 *
 * Runs in the POOL project (real workerd) — needs the `SESSIONS` KV binding
 * (for `createSession`/`readSession`) and `HYPERDRIVE_FRESH` (for the
 * `users` row), plus the Worker's `fetch` handler.
 */

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/** Rows created by a test, deleted in `afterEach`. */
const createdUserIds: string[] = [];

/** INSERT an UNVERIFIED user (`email_verified_at IS NULL`) with a per-run-unique email; returns its id. */
async function insertUnverifiedUser(): Promise<string> {
  const ctx = createExecutionContext();
  const email = `t13_${crypto.randomUUID()}@example.com`;
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, PASSWORD_HASH],
    );
    return rows[0].id as string;
  });
  await waitOnExecutionContext(ctx);
  createdUserIds.push(id);
  return id;
}

/** Stamp `email_verified_at = now()` for `userId` via the FRESH binding. */
async function verifyUser(userId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [
      userId,
    ]),
  );
  await waitOnExecutionContext(ctx);
}

/** Create a real session for `userId` and return the raw cookie token. */
async function sessionTokenFor(userId: string): Promise<string> {
  const data: SessionData = {
    userId,
    roles: ["member"],
    securityEpoch: 1,
    csrfSecret: "csrf-secret-value",
    createdAt: Date.now(),
  };
  const { cookie } = await createSession(env, data);
  const match = /^tj_session=([^;]*)/.exec(cookie);
  if (match === null) {
    throw new Error(`cookie did not match expected shape: ${cookie}`);
  }
  return match[1]!;
}

function requestWithCookie(
  path: string,
  method: string,
  token: string,
): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { Cookie: `tj_session=${token}` },
  });
}

beforeEach(async () => {
  // Isolate SESSIONS across tests within this pool file (isolatedStorage was
  // removed, so KV contents persist across tests otherwise).
  const { keys } = await env.SESSIONS.list();
  await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]),
    );
    await waitOnExecutionContext(ctx);
    createdUserIds.length = 0;
  }
});

describe("soft email-verification gate", () => {
  it("POST /posts with an unverified session -> 403 EMAIL_NOT_VERIFIED", async () => {
    const userId = await insertUnverifiedUser();
    const token = await sessionTokenFor(userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "POST", token),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("POST /posts succeeds once the user's email is verified", async () => {
    const userId = await insertUnverifiedUser();
    const token = await sessionTokenFor(userId);
    await verifyUser(userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "POST", token),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).not.toBe(403);
  });

  it("GET /posts with the SAME unverified session -> 200 (reads are open)", async () => {
    const userId = await insertUnverifiedUser();
    const token = await sessionTokenFor(userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "GET", token),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  it("POST /posts with no session -> 401 (not 403)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/posts", { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});

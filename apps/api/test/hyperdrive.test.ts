import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";

// Proves `pg` (node-postgres) runs inside REAL workerd via `nodejs_compat`,
// reaching Postgres through a Hyperdrive binding, and that `withClient`
// connects → runs the callback → ends the socket via `ctx.waitUntil`.
//
// Runs in the POOL project (real workerd) because it depends on the
// `HYPERDRIVE_FRESH` Cloudflare binding. The `miniflare.hyperdrives` override in
// vitest.config.ts resolves both bindings to the local test DB. The schema is
// applied by the root `globalSetup` (test/global-setup.ts) before this runs.
//
// FRESH is used deliberately: every auth / read-after-write read MUST go through
// `HYPERDRIVE_FRESH` (cache-disabled). See the FRESH-vs-CACHED rule in the brief.

// Unique per run so the persistent test DB (named volume + idempotent
// migrations) never collides on `users.email` (citext UNIQUE) across re-runs.
const email = `t6_${crypto.randomUUID()}@example.com`;
// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
const passwordHash = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

afterEach(async () => {
  // Belt-and-suspenders isolation: remove the row so the test leaves no residue
  // even though the email is already unique per run.
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM users WHERE email = $1", [email]),
  );
  await waitOnExecutionContext(ctx);
});

describe("withClient over Hyperdrive (FRESH binding)", () => {
  it("inserts a user then reads it back through the Hyperdrive binding", async () => {
    const ctx = createExecutionContext();

    const inserted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users (email, password_hash)
             VALUES ($1, $2)
          RETURNING id, email, password_hash`,
        [email, passwordHash],
      );
      return rows[0];
    });

    expect(inserted.email).toBe(email);
    expect(inserted.password_hash).toBe(passwordHash);
    expect(inserted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const readBack = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        "SELECT id, email, password_hash FROM users WHERE email = $1",
        [email],
      );
      return rows;
    });

    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toEqual(inserted);

    // Let the `ctx.waitUntil(client.end())` teardown from both calls complete so
    // no socket leaks past the test (output must stay pristine).
    await waitOnExecutionContext(ctx);
  });
});

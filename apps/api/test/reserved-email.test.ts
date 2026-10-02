import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { isEmailReserved, releaseReservedEmail, reservedEmailSha256 } from "../src/auth/reserved-email";

/**
 * account-legal-hold spec §4a (Task 2) — reserved-email hash. Pool project:
 * real workerd + the test DB through HYPERDRIVE_FRESH, same as
 * account-actions.test.ts.
 */
const madeUsers: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  if (madeUsers.length > 0) await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]));
  madeUsers.length = 0;
});

/** An anonymised row (anonymised_at set) so reserved_email_sha256 is legal to set. */
async function mkAnonymisedUser(opts?: { disabledAt?: boolean; reservedHash?: string | null }): Promise<string> {
  const id = crypto.randomUUID();
  await ctxRun((c) =>
    c.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at, anonymised_at, disabled_at, reserved_email_sha256)
       VALUES ($1, $2, 'h', now(), now(), $3, $4)`,
      [id, `anon-${id}@holds.test`, opts?.disabledAt ?? false ? new Date() : null, opts?.reservedHash ?? null],
    ),
  );
  madeUsers.push(id);
  return id;
}

describe("reservedEmailSha256", () => {
  it("is case-insensitive and equals the sha256 hex of the normalised address", async () => {
    const a = await reservedEmailSha256("Ada@Example.COM");
    const b = await reservedEmailSha256("ada@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    // Literal expected digest for "ada@example.com", computed independently
    // (fix round 1, minor #2) with TWO external tools, outside this test:
    //   printf '%s' "ada@example.com" | sha256sum
    //   printf '%s' "ada@example.com" | openssl dgst -sha256
    // Both: b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72
    expect(a).toBe("b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72");
  });
});

describe("isEmailReserved", () => {
  it("is true for an anonymised row holding that hash, and false for a different address (control)", async () => {
    // Random local part per run (fix round 1, minor #5): avoids any collision
    // with another lane's concurrent run against the shared test DB.
    const target = `reserved-target-${crypto.randomUUID()}@holds.test`;
    const other = `nobody-reserved-this-${crypto.randomUUID()}@holds.test`;
    const hash = await reservedEmailSha256(target);
    await mkAnonymisedUser({ reservedHash: hash });

    expect(await ctxRun((c) => isEmailReserved(c, target))).toBe(true);
    expect(await ctxRun((c) => isEmailReserved(c, target.toUpperCase()))).toBe(true);
    // Control: a different address, never reserved, is false.
    expect(await ctxRun((c) => isEmailReserved(c, other))).toBe(false);
  });
});

describe("releaseReservedEmail", () => {
  it("an anonymised, no longer banned row → hash NULL, true", async () => {
    const hash = await reservedEmailSha256(`release-me-${crypto.randomUUID()}@holds.test`);
    const u = await mkAnonymisedUser({ disabledAt: false, reservedHash: hash });

    const result = await ctxRun((c) => releaseReservedEmail(c, u));
    expect(result).toBe(true);

    const { rows } = await ctxRun((c) =>
      c.query<{ reserved_email_sha256: string | null }>(`SELECT reserved_email_sha256 FROM users WHERE id = $1`, [u]),
    );
    expect(rows[0]!.reserved_email_sha256).toBeNull();
  });

  it("an anonymised row still banned → unchanged, false", async () => {
    const hash = await reservedEmailSha256(`still-banned-${crypto.randomUUID()}@holds.test`);
    const u = await mkAnonymisedUser({ disabledAt: true, reservedHash: hash });

    const result = await ctxRun((c) => releaseReservedEmail(c, u));
    expect(result).toBe(false);

    const { rows } = await ctxRun((c) =>
      c.query<{ reserved_email_sha256: string | null }>(`SELECT reserved_email_sha256 FROM users WHERE id = $1`, [u]),
    );
    expect(rows[0]!.reserved_email_sha256).toBe(hash);
  });

  it("a row with no hash → false", async () => {
    const u = await mkAnonymisedUser({ disabledAt: false, reservedHash: null });
    const result = await ctxRun((c) => releaseReservedEmail(c, u));
    expect(result).toBe(false);
  });
});

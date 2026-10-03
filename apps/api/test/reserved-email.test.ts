import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import {
  isEmailReserved,
  releaseReservedEmail,
  ReservedEmailKeyMissingError,
  reservedEmailHmac,
} from "../src/auth/reserved-email";

/**
 * account-legal-hold spec §4a (Task 2) — the reserved-email fingerprint. Pool
 * project: real workerd + the test DB through HYPERDRIVE_FRESH, same as
 * account-actions.test.ts.
 *
 * Migration 0023: the fingerprint is an HMAC-SHA-256 keyed by the
 * RESERVED_EMAIL_KEY secret (vitest.config.ts gives the pool the fixed test key
 * "test-reserved-email-key"). The legacy unsalted reservation column (0022)
 * was dropped in migration 0025 (2026-10-03): it is no longer read, written
 * or present.
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

/** An anonymised row (anonymised_at set) so the reservation column is legal to set. */
async function mkAnonymisedUser(opts?: {
  disabledAt?: boolean;
  reservedHmac?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await ctxRun((c) =>
    c.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at, anonymised_at, disabled_at,
                          reserved_email_hmac)
       VALUES ($1, $2, 'h', now(), now(), $3, $4)`,
      [
        id,
        `anon-${id}@holds.test`,
        (opts?.disabledAt ?? false) ? new Date() : null,
        opts?.reservedHmac ?? null,
      ],
    ),
  );
  madeUsers.push(id);
  return id;
}

async function columns(id: string): Promise<{ hmac: string | null }> {
  const { rows } = await ctxRun((c) =>
    c.query<{ reserved_email_hmac: string | null }>(
      `SELECT reserved_email_hmac FROM users WHERE id = $1`,
      [id],
    ),
  );
  return { hmac: rows[0]!.reserved_email_hmac };
}

describe("reservedEmailHmac", () => {
  it("is the HMAC-SHA-256 of the normalised address under RESERVED_EMAIL_KEY, not its plain SHA-256", async () => {
    const a = await reservedEmailHmac(env, "Ada@Example.COM");
    const b = await reservedEmailHmac(env, "ada@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    // Literal expected HMAC, computed independently, outside this test, with
    // TWO external tools:
    //   printf '%s' "ada@example.com" | openssl dgst -sha256 -hmac "test-reserved-email-key"
    //   python: hmac.new(b"test-reserved-email-key", b"ada@example.com", hashlib.sha256).hexdigest()
    // Both: 6ed032f9dd97c94d02757691d9beeb51e660d7554a9bf3b7940d9ec9e017b1c3
    expect(env.RESERVED_EMAIL_KEY).toBe("test-reserved-email-key");
    expect(a).toBe("6ed032f9dd97c94d02757691d9beeb51e660d7554a9bf3b7940d9ec9e017b1c3");
    // ...and it is NOT the reversible unsalted digest 0022 stored (b5fc85e5...,
    // the plain sha256 hex of "ada@example.com", computed independently with
    // `printf '%s' "ada@example.com" | sha256sum`).
    expect(a).not.toBe("b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72");
  });

  it("the same address under a different key gives a different value", async () => {
    const other = await reservedEmailHmac({ RESERVED_EMAIL_KEY: "another-key" }, "ada@example.com");
    // openssl dgst -sha256 -hmac "another-key", as above.
    expect(other).toBe("e92576a38f1a3a172f18943b1340fdbfdc4fb428b4634592c8d7e0bdcd282541");
    expect(other).not.toBe(await reservedEmailHmac(env, "ada@example.com"));
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \u0009\u000a "],
    ["missing", undefined],
  ])("fails closed when the key is %s: throws ReservedEmailKeyMissingError", async (_label, key) => {
    await expect(
      reservedEmailHmac({ RESERVED_EMAIL_KEY: key as unknown as string }, "ada@example.com"),
    ).rejects.toBeInstanceOf(ReservedEmailKeyMissingError);
  });
});

describe("isEmailReserved", () => {
  it("is true for an anonymised row holding the address's HMAC, and false for a different address (control)", async () => {
    // Random local parts: no collision with another lane's run against the shared test DB.
    const target = `reserved-target-${crypto.randomUUID()}@holds.test`;
    const other = `nobody-reserved-this-${crypto.randomUUID()}@holds.test`;
    await mkAnonymisedUser({ reservedHmac: await reservedEmailHmac(env, target) });

    expect(await ctxRun((c) => isEmailReserved(c, env, target))).toBe(true);
    expect(await ctxRun((c) => isEmailReserved(c, env, target.toUpperCase()))).toBe(true);
    expect(await ctxRun((c) => isEmailReserved(c, env, other))).toBe(false);
  });

  it("fails closed without the key: throws rather than answering false", async () => {
    const target = `nokey-${crypto.randomUUID()}@holds.test`;
    await expect(ctxRun((c) => isEmailReserved(c, { RESERVED_EMAIL_KEY: "" }, target))).rejects.toBeInstanceOf(
      ReservedEmailKeyMissingError,
    );
  });
});

describe("releaseReservedEmail", () => {
  it("an anonymised, no longer banned row holding the HMAC column → NULL, true", async () => {
    const email = `release-me-${crypto.randomUUID()}@holds.test`;
    const u = await mkAnonymisedUser({
      disabledAt: false,
      reservedHmac: await reservedEmailHmac(env, email),
    });

    expect(await ctxRun((c) => releaseReservedEmail(c, u))).toBe(true);
    expect(await columns(u)).toEqual({ hmac: null });
  });

  it("an anonymised row still banned → unchanged, false", async () => {
    const email = `still-banned-${crypto.randomUUID()}@holds.test`;
    const hmac = await reservedEmailHmac(env, email);
    const u = await mkAnonymisedUser({ disabledAt: true, reservedHmac: hmac });

    expect(await ctxRun((c) => releaseReservedEmail(c, u))).toBe(false);
    expect(await columns(u)).toEqual({ hmac });
  });

  it("a row with nothing reserved → false", async () => {
    const u = await mkAnonymisedUser({ disabledAt: false });
    expect(await ctxRun((c) => releaseReservedEmail(c, u))).toBe(false);
  });
});

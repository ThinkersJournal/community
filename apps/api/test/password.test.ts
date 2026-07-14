import { describe, expect, it } from "vitest";

import { hashPassword, needsRehash, verifyPassword } from "../src/auth/password";

// WASM warm-up + Argon2 memory cost make the first hash slow, so the hashing
// cases get a generous timeout.
const HASH_TIMEOUT_MS = 30_000;

describe("password hashing (argon2id)", () => {
  it(
    "round-trips a correct password",
    async () => {
      const hash = await hashPassword("correct horse battery staple");
      expect(await verifyPassword("correct horse battery staple", hash)).toBe(
        true,
      );
    },
    HASH_TIMEOUT_MS,
  );

  it(
    "rejects a wrong password",
    async () => {
      const hash = await hashPassword("correct horse battery staple");
      expect(await verifyPassword("Tr0ub4dor&3", hash)).toBe(false);
    },
    HASH_TIMEOUT_MS,
  );

  it(
    "produces a PHC-encoded argon2id hash with the current parameters",
    async () => {
      const hash = await hashPassword("hunter2");
      expect(hash.startsWith("$argon2id$v=19$")).toBe(true);
      expect(hash).toContain("m=19456,t=2,p=1");
    },
    HASH_TIMEOUT_MS,
  );

  it(
    "needsRehash is false for a fresh hash and true for weaker params",
    async () => {
      const fresh = await hashPassword("hunter2");
      expect(needsRehash(fresh)).toBe(false);

      // Valid PHC format, but weaker-than-current parameters.
      const weak = "$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHQ$ZGlnZXN0";
      expect(needsRehash(weak)).toBe(true);
    },
    HASH_TIMEOUT_MS,
  );

  it("verifyPassword returns false (no throw) for a malformed string", async () => {
    await expect(verifyPassword("hunter2", "not-a-hash")).resolves.toBe(false);
  });

  it("needsRehash returns true for an unparseable/foreign hash", () => {
    expect(needsRehash("not-a-hash")).toBe(true);
  });
});

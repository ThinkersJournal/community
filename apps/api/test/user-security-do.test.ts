import { env, evictAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Runs in the POOL project (real workerd) because it needs the
// `USER_SECURITY` Durable Object binding. Each test case addresses a
// unique-per-test DO name (`u_<uuid>`) via `env.USER_SECURITY.getByName(...)`
// so cases never share storage within this file's run.
//
// Real Durable Object, no mocks — the persistence case specifically proves
// the epoch survives `evictAllDurableObjects()` (which tears down the running
// instance and resets in-memory state), which only holds if the epoch is
// truly persisted in the DO's SQLite storage rather than an instance field.
describe("UserSecurityDO (revocation epoch)", () => {
  it("a fresh DO starts at epoch 0", async () => {
    const stub = env.USER_SECURITY.getByName(`u_${crypto.randomUUID()}`);

    expect(await stub.getEpoch()).toBe(0);
  });

  it("bumpEpoch is strictly monotonic: 1, then 2", async () => {
    const stub = env.USER_SECURITY.getByName(`u_${crypto.randomUUID()}`);

    expect(await stub.bumpEpoch()).toBe(1);
    expect(await stub.bumpEpoch()).toBe(2);
  });

  it("persists the epoch across eviction (durable SQLite, not in-memory)", async () => {
    const name = `u_${crypto.randomUUID()}`;

    const stub = env.USER_SECURITY.getByName(name);
    expect(await stub.bumpEpoch()).toBe(1);
    expect(await stub.bumpEpoch()).toBe(2);

    // Tears down the running DO instance (resetting any in-memory state) but
    // must preserve durable storage.
    await evictAllDurableObjects();

    // Re-addressing the SAME name after eviction must still see epoch 2.
    const stubAfterEviction = env.USER_SECURITY.getByName(name);
    expect(await stubAfterEviction.getEpoch()).toBe(2);
  });
});

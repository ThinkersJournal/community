import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe("0006/0007/0008 migrations", () => {
  it("notification_channel enum has exactly instant|digest|off", async () => {
    const { rows } = await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'notification_channel' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["instant", "digest", "off"]);
  });

  it("notification_prefs defaults match the spec when a row is inserted bare", async () => {
    const { rows: u } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`prefs-${crypto.randomUUID()}@t.test`],
    );
    const uid = u[0]!.id;
    try {
      const { rows } = await client.query<{
        master_enabled: boolean; direct: string; reactions: string; follows: string; seen_at: string | null;
      }>(`INSERT INTO notification_prefs (user_id) VALUES ($1)
          RETURNING master_enabled, direct, reactions, follows, seen_at`, [uid]);
      expect(rows[0]).toMatchObject({
        master_enabled: true, direct: "instant", reactions: "digest", follows: "digest", seen_at: null,
      });
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });

  it("notifications.emailed_at exists and defaults NULL", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'notifications' AND column_name = 'emailed_at'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("email_drain_lock is seeded with instant and digest", async () => {
    const { rows } = await client.query<{ pass: string }>(
      `SELECT pass FROM email_drain_lock ORDER BY pass`,
    );
    expect(rows.map((r) => r.pass)).toEqual(["digest", "instant"]);
  });

  it("the lease claim is atomic — a second claim while leased returns 0 rows", async () => {
    await client.query(`UPDATE email_drain_lock SET leased_until = NULL WHERE pass = 'instant'`);
    const first = await client.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds'
        WHERE pass = 'instant' AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
    );
    const second = await client.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '90 seconds'
        WHERE pass = 'instant' AND (leased_until IS NULL OR leased_until < now()) RETURNING pass`,
    );
    await client.query(`UPDATE email_drain_lock SET leased_until = NULL WHERE pass = 'instant'`);
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
  });

  it("email_drain_lock has a leased_by owner column (0008)", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'email_drain_lock' AND column_name = 'leased_by'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("the fenced release cannot clear a successor's lease (leased_by fence)", async () => {
    // 'A' holds the lease...
    await client.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '300 seconds', leased_by = 'A' WHERE pass = 'instant'`,
    );
    // ...A's lease lapses and successor 'B' re-acquires it (still-future lease).
    await client.query(
      `UPDATE email_drain_lock SET leased_until = now() + interval '300 seconds', leased_by = 'B' WHERE pass = 'instant'`,
    );
    // A's fenced release (leased_by = 'A') must NOT clear B's live lease.
    const released = await client.query(
      `UPDATE email_drain_lock SET leased_until = NULL, leased_by = NULL WHERE pass = 'instant' AND leased_by = 'A'`,
    );
    expect(released.rowCount).toBe(0);
    const { rows } = await client.query<{ leased_by: string | null }>(
      `SELECT leased_by FROM email_drain_lock WHERE pass = 'instant'`,
    );
    expect(rows[0]!.leased_by).toBe("B"); // successor's lease intact
    await client.query(
      `UPDATE email_drain_lock SET leased_until = NULL, leased_by = NULL WHERE pass = 'instant'`,
    );
  });
});

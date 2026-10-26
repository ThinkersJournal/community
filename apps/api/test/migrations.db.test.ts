// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

// Runs in the Node vitest project (environment: 'node') with a direct pg TCP
// connection — NOT in workerd.
//
// ⚠️ THIS FILE HAS ITS OWN DATABASE, AND THAT IS LOAD-BEARING.
// It proves the migration SQL by RUNNING it: `down` drops every table in the
// stack (media, posts, profiles, users), then `up` recreates them. On the
// shared fixture DB that is a race, not a test: vitest runs test PROJECTS in
// parallel unless `sequence.groupOrder` says otherwise, so the "pool" project's
// Worker tests (signup/login/logout/email-verify/epoch-revoke/soft-gate/
// hyperdrive — all reaching the SAME database through Hyperdrive) can be
// mid-query in the window where this file has `users` dropped, and fail with
// `relation "users" does not exist`. This file needs *a* database, not the
// shared one, so it gets its own: the hazard is then structurally impossible
// rather than a scheduling constraint a future edit can quietly drop.
//
// The database is created by db/init/01-create-test-db.sql (fresh volumes) and,
// for volumes that predate it, by test/global-setup.ts. Its SCHEMA state is
// owned HERE (globalSetup migrates only the shared DB) — hence the beforeAll.
const MIGRATIONS_TEST_DATABASE_URL =
  process.env.MIGRATIONS_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_migrations_test";

/** The SHARED fixture DB — read-only here, only to prove we never touch it. */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

async function migrate(direction: "up" | "down"): Promise<void> {
  await runner({
    databaseUrl: MIGRATIONS_TEST_DATABASE_URL,
    dir: migrationsDir,
    direction,
    migrationsTable: "pgmigrations",
    // Infinity in BOTH directions: "down" must revert the ENTIRE applied
    // stack, not just the most-recently-applied file. With count: 1, adding
    // migrations/0002 on top of 0001 made "down" revert 0002 ONLY (posts +
    // media), leaving users/profiles in place — this test would then assert
    // those tables are gone and fail. Reverting the whole stack keeps this
    // round-trip test correct regardless of how many migrations exist.
    count: Infinity,
  });
}

async function withClient<T>(
  fn: (client: Client) => Promise<T>,
  connectionString: string = MIGRATIONS_TEST_DATABASE_URL,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length === 1;
}

async function columnExists(client: Client, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length === 1;
}

/** Whether `table.column` admits NULL (0035 makes `media.owner_id` nullable). */
async function columnNullable(client: Client, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0]?.is_nullable === "YES";
}

async function indexExists(client: Client, indexName: string): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [indexName],
  );
  return Number(rows[0]!.n) > 0;
}

/** The live `moderation_actions_action_check` definition, or "" when absent. */
async function actionCheck(client: Client): Promise<string> {
  const { rows } = await client.query<{ def: string }>(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'moderation_actions_action_check'",
  );
  return rows[0]?.def ?? "";
}

// globalSetup migrates the SHARED DB; this one is ours to set up. Idempotent
// (node-pg-migrate's `pgmigrations` table), so this is a no-op after run 1.
beforeAll(async () => {
  await migrate("up");
});

describe("0001 users + profiles migration", () => {
  it("creates users with password_hash, email_verified_at (nullable), and citext email", async () => {
    await withClient(async (client) => {
      const { rows } = await client.query(
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'`,
      );
      const byName = new Map<string, (typeof rows)[number]>(
        rows.map((r) => [r.column_name, r]),
      );

      expect(byName.has("password_hash")).toBe(true);
      expect(byName.get("password_hash")?.data_type).toBe("text");

      expect(byName.has("email_verified_at")).toBe(true);
      expect(byName.get("email_verified_at")?.data_type).toBe(
        "timestamp with time zone",
      );
      expect(byName.get("email_verified_at")?.is_nullable).toBe("YES");

      // citext surfaces in information_schema as USER-DEFINED / udt_name 'citext'.
      expect(byName.get("email")?.udt_name).toBe("citext");
    });
  });

  it("profiles.user_id exists and is a FK to users.id", async () => {
    await withClient(async (client) => {
      const { rows: cols } = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'profiles'
            AND column_name = 'user_id'`,
      );
      expect(cols).toHaveLength(1);

      const { rows: fks } = await client.query(
        `SELECT kcu.column_name AS fk_column,
                ccu.table_name  AS ref_table,
                ccu.column_name AS ref_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema    = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
            AND tc.table_schema    = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema    = 'public'
            AND tc.table_name      = 'profiles'`,
      );

      expect(fks).toEqual([
        { fk_column: "user_id", ref_table: "users", ref_column: "id" },
      ]);
    });
  });

  it("down drops every table and up restores them (round-trip); leaves DB migrated", async () => {
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "profiles")).toBe(true);
      expect(await tableExists(client, "posts")).toBe(true);
      expect(await tableExists(client, "media")).toBe(true);
      // 0012_moderation.sql — proves the whole stack, including the newest
      // migration, is reversible, not just the original 0001/0002 tables.
      expect(await tableExists(client, "blocks")).toBe(true);
      expect(await tableExists(client, "reports")).toBe(true);
      expect(await columnExists(client, "posts", "hidden_at")).toBe(true);
      expect(await columnExists(client, "comments", "hidden_at")).toBe(true);
      // 0013_moderation_actions.sql — proves the newest migration is
      // reversible too, not just the ones that predate it.
      expect(await tableExists(client, "moderation_actions")).toBe(true);
      // 0014_reports_created_idx.sql — the moderation queue's ordering index.
      expect(await indexExists(client, "reports_created_idx")).toBe(true);
      // 0015_user_account_status.sql — account status columns.
      expect(await columnExists(client, "users", "disabled_at")).toBe(true);
      // 0019_account_deletion.sql — account deletion request/scrub columns.
      expect(await columnExists(client, "users", "deletion_requested_at")).toBe(true);
      expect(await columnExists(client, "users", "anonymised_at")).toBe(true);
      // 0020_dsa_notices.sql — DSA notice-and-action intake table.
      expect(await tableExists(client, "dsa_notices")).toBe(true);
      // 0021_moderation_snapshots.sql — #58's retained copies.
      expect(await tableExists(client, "moderation_snapshots")).toBe(true);
      // 0022_account_legal_holds.sql — account legal holds + reserved-email hash.
      expect(await tableExists(client, "account_legal_holds")).toBe(true);
      // 0023_reserved_email_hmac.sql — the keyed reservation fingerprint.
      expect(await columnExists(client, "users", "reserved_email_hmac")).toBe(true);
      expect(await indexExists(client, "users_reserved_email_hmac_idx")).toBe(true);
      // 0024_appeals.sql — appeals + per-purpose moderation action tokens.
      expect(await tableExists(client, "appeals")).toBe(true);
      expect(await tableExists(client, "moderation_action_tokens")).toBe(true);
      // 0025 — the legacy unsalted reservation column is gone.
      expect(await columnExists(client, "users", "reserved_email_sha256")).toBe(false);
      // 0027_media_original_hashes.sql — original-upload hashes + the upload-scan schema.
      expect(await columnExists(client, "media", "original_sha256")).toBe(true);
      expect(await columnExists(client, "media", "pdq")).toBe(true);
      expect(await indexExists(client, "media_original_sha256_idx")).toBe(true);
      expect(await tableExists(client, "upload_scan_outcomes")).toBe(true);
      expect(await tableExists(client, "media_scan_backfill")).toBe(true);
      expect(await tableExists(client, "media_scan_backfill_progress")).toBe(true);
      // 0033 — moderation_actions accepts security_ref_resolved (security alerting).
      expect(await actionCheck(client)).toContain("'security_ref_resolved'::text");
      // 0034_moderation_notice_outbox.sql — the notice outbox and its two indexes.
      expect(await tableExists(client, "moderation_notice_outbox")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_due_idx")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_retain_until_idx")).toBe(true);
      // 0035_media_owner_nullable.sql — the ownership link can be cleared.
      expect(await columnNullable(client, "media", "owner_id")).toBe(true);
      expect(await columnExists(client, "media", "owner_cleared_at")).toBe(true);
      // 0036_moderation_notice_outbox_per_notice.sql — a reporter row is unique per DSA notice.
      expect(await columnExists(client, "moderation_notice_outbox", "dsa_notice_id")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_action_kind_key")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_action_kind_notice_key")).toBe(true);
      // 0037_post_idempotency_key.sql — the key lives on the post row.
      expect(await columnExists(client, "posts", "idempotency_key")).toBe(true);
      expect(await columnExists(client, "posts", "idempotency_request_sha256")).toBe(true);
      expect(await indexExists(client, "posts_author_idempotency_key")).toBe(true);
      // 0038_media_upload_refusals.sql — a refused upload of restricted bytes is recorded.
      expect(await tableExists(client, "media_upload_refusals")).toBe(true);
      expect(await indexExists(client, "media_upload_refusals_key_idx")).toBe(true);
      // 0039_terms_acceptances.sql — the signup terms-acceptance record.
      expect(await tableExists(client, "terms_acceptances")).toBe(true);
      // 0040_dmca.sql — DMCA notices, counter-notices and the moderation_actions link.
      expect(await tableExists(client, "dmca_notices")).toBe(true);
      expect(await tableExists(client, "dmca_counter_notices")).toBe(true);
      expect(await columnExists(client, "moderation_actions", "dmca_notice_id")).toBe(true);
      // 0041_member_reporter_outcome.sql — a member reporter is told the outcome.
      expect(await columnExists(client, "reports", "outcome_action_id")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_member_reporter_key")).toBe(true);
    });

    await migrate("down");
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(false);
      expect(await tableExists(client, "profiles")).toBe(false);
      expect(await tableExists(client, "posts")).toBe(false);
      expect(await tableExists(client, "media")).toBe(false);
      // 0027 — its tables are gone. (media_original_sha256_idx went with the
      // media table itself: after a full down the index cannot be checked
      // separately from the table drop, so only the tables are asserted.)
      expect(await tableExists(client, "upload_scan_outcomes")).toBe(false);
      expect(await tableExists(client, "media_scan_backfill")).toBe(false);
      expect(await tableExists(client, "media_scan_backfill_progress")).toBe(false);
      expect(await indexExists(client, "media_original_sha256_idx")).toBe(false);
      expect(await tableExists(client, "blocks")).toBe(false);
      expect(await tableExists(client, "reports")).toBe(false);
      expect(await tableExists(client, "moderation_actions")).toBe(false);
      expect(await indexExists(client, "reports_created_idx")).toBe(false);
      expect(await columnExists(client, "users", "disabled_at")).toBe(false);
      expect(await columnExists(client, "users", "deletion_requested_at")).toBe(false);
      expect(await columnExists(client, "users", "anonymised_at")).toBe(false);
      expect(await tableExists(client, "dsa_notices")).toBe(false);
      expect(await tableExists(client, "moderation_snapshots")).toBe(false);
      expect(await tableExists(client, "account_legal_holds")).toBe(false);
      expect(await columnExists(client, "users", "reserved_email_sha256")).toBe(false);
      expect(await columnExists(client, "users", "reserved_email_hmac")).toBe(false);
      expect(await indexExists(client, "users_reserved_email_hmac_idx")).toBe(false);
      expect(await tableExists(client, "appeals")).toBe(false);
      expect(await tableExists(client, "moderation_action_tokens")).toBe(false);
      // 0034 — the outbox and its indexes are gone.
      expect(await tableExists(client, "moderation_notice_outbox")).toBe(false);
      expect(await indexExists(client, "moderation_notice_outbox_due_idx")).toBe(false);
      expect(await indexExists(client, "moderation_notice_outbox_retain_until_idx")).toBe(false);
      // 0035 — went with the media table (a full down drops it).
      expect(await columnExists(client, "media", "owner_cleared_at")).toBe(false);
    });

    // THE ISOLATION PROPERTY, pinned. The stack is torn down above — in OUR
    // database. If this file ever gets pointed back at the shared fixture DB,
    // this assertion fails HERE, loudly and deterministically, instead of
    // surfacing as an intermittent `relation "users" does not exist` in an
    // unrelated pool test that happened to query during the drop window.
    await withClient(async (client) => {
      expect(
        await tableExists(client, "users"),
        "the destructive migration round-trip reached the SHARED test DB. It must run against MIGRATIONS_TEST_DATABASE_URL (its own database) — the pool project's Worker tests query the shared DB through Hyperdrive CONCURRENTLY with this project.",
      ).toBe(true);
    }, TEST_DATABASE_URL);

    await migrate("up");
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "profiles")).toBe(true);
      expect(await tableExists(client, "posts")).toBe(true);
      expect(await tableExists(client, "media")).toBe(true);
      expect(await tableExists(client, "blocks")).toBe(true);
      expect(await tableExists(client, "reports")).toBe(true);
      expect(await columnExists(client, "posts", "hidden_at")).toBe(true);
      expect(await columnExists(client, "comments", "hidden_at")).toBe(true);
      expect(await tableExists(client, "moderation_actions")).toBe(true);
      expect(await indexExists(client, "reports_created_idx")).toBe(true);
      expect(await columnExists(client, "users", "disabled_at")).toBe(true);
      expect(await columnExists(client, "users", "deletion_requested_at")).toBe(true);
      expect(await columnExists(client, "users", "anonymised_at")).toBe(true);
      expect(await tableExists(client, "dsa_notices")).toBe(true);
      expect(await tableExists(client, "moderation_snapshots")).toBe(true);
      expect(await tableExists(client, "account_legal_holds")).toBe(true);
      expect(await columnExists(client, "users", "reserved_email_hmac")).toBe(true);
      expect(await indexExists(client, "users_reserved_email_hmac_idx")).toBe(true);
      expect(await tableExists(client, "appeals")).toBe(true);
      expect(await tableExists(client, "moderation_action_tokens")).toBe(true);
      // 0025 — absent again after the full down/up round-trip re-applies it.
      expect(await columnExists(client, "users", "reserved_email_sha256")).toBe(false);
      // 0027 — re-applied by the round-trip.
      expect(await columnExists(client, "media", "original_sha256")).toBe(true);
      expect(await columnExists(client, "media", "pdq")).toBe(true);
      expect(await indexExists(client, "media_original_sha256_idx")).toBe(true);
      expect(await tableExists(client, "upload_scan_outcomes")).toBe(true);
      expect(await tableExists(client, "media_scan_backfill")).toBe(true);
      expect(await tableExists(client, "media_scan_backfill_progress")).toBe(true);
      // 0033 — re-applied by the round-trip.
      expect(await actionCheck(client)).toContain("'security_ref_resolved'::text");
      // 0034 — re-applied by the round-trip.
      expect(await tableExists(client, "moderation_notice_outbox")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_due_idx")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_retain_until_idx")).toBe(true);
      // 0035 — re-applied by the round-trip.
      expect(await columnNullable(client, "media", "owner_id")).toBe(true);
      expect(await columnExists(client, "media", "owner_cleared_at")).toBe(true);
      // 0036 — re-applied by the round-trip.
      expect(await columnExists(client, "moderation_notice_outbox", "dsa_notice_id")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_action_kind_notice_key")).toBe(true);
      // 0037 — re-applied by the round-trip.
      expect(await columnExists(client, "posts", "idempotency_key")).toBe(true);
      expect(await indexExists(client, "posts_author_idempotency_key")).toBe(true);
      // 0038 — re-applied by the round-trip.
      expect(await tableExists(client, "media_upload_refusals")).toBe(true);
      // 0039 — re-applied by the round-trip.
      expect(await tableExists(client, "terms_acceptances")).toBe(true);
      // 0040 — re-applied by the round-trip.
      expect(await tableExists(client, "dmca_notices")).toBe(true);
      expect(await columnExists(client, "moderation_actions", "dmca_notice_id")).toBe(true);
      // 0041 — re-applied by the round-trip.
      expect(await columnExists(client, "reports", "outcome_action_id")).toBe(true);
      expect(await indexExists(client, "moderation_notice_outbox_member_reporter_key")).toBe(true);
    });
    // Intentionally left in the migrated (up) state.
  });
});

describe("0035 media owner nullable: the Down Migration", () => {
  // The real Down SQL from the file, run inside a transaction that is always
  // rolled back, so the DB stays migrated (up) for whatever runs next.
  const downSql = readFileSync(join(migrationsDir, "0035_media_owner_nullable.sql"), "utf8").split("-- Down Migration")[1] ?? "";

  async function inRolledBackTx(fn: (client: Client) => Promise<void>): Promise<void> {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await fn(client);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  }

  async function seedUserWithMedia(client: Client, ownerCleared: boolean): Promise<void> {
    const userId = randomUUID();
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [
      userId,
      `${userId}@mig-0035.test`,
    ]);
    await client.query(
      `INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height)
       VALUES ($1, $2, 's', 1, 1, 1)`,
      [ownerCleared ? null : userId, `k-${randomUUID()}`],
    );
  }

  it("the file has a Down section", () => {
    expect(downSql).toContain("SET NOT NULL");
  });

  it("refuses while a media row has a NULL owner", async () => {
    await inRolledBackTx(async (client) => {
      await seedUserWithMedia(client, true);
      await expect(client.query(downSql)).rejects.toThrow(/null value|not-null|owner_id/i);
    });
  });

  it("CONTROL: the same Down SQL succeeds when every media row still has an owner", async () => {
    await inRolledBackTx(async (client) => {
      await seedUserWithMedia(client, false);
      await client.query(downSql);
      expect(await columnNullable(client, "media", "owner_id")).toBe(false);
      expect(await columnExists(client, "media", "owner_cleared_at")).toBe(false);
    });
  });
});

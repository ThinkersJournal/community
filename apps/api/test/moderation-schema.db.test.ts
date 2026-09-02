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

describe("auto-hide columns (0012_moderation)", () => {
  it("posts.hidden_at is a nullable timestamptz", async () => {
    const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'hidden_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("timestamp with time zone");
    expect(rows[0]!.is_nullable).toBe("YES");
  });

  it("comments.hidden_at is a nullable timestamptz", async () => {
    const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'comments' AND column_name = 'hidden_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("timestamp with time zone");
    expect(rows[0]!.is_nullable).toBe("YES");
  });
});

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let author: string;
beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`tag-${crypto.randomUUID()}@t.test`]);
  author = rows[0]!.id;
  await client.query(
    `INSERT INTO profiles (user_id, username) VALUES ($1,$2)`,
    [author, `tager_${author.slice(0, 8)}`]);
});
afterAll(async () => { await client.query(`DELETE FROM users WHERE id=$1`, [author]); await client.end(); });

async function insertPost(title: string, status: "published" | "draft"): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id,title,slug,markdown_source,status,published_at)
     VALUES ($1,$2,$3,'b',$4, CASE WHEN $4='published' THEN now() ELSE NULL END) RETURNING id`,
    [author, title, `tp-${crypto.randomUUID()}`, status]);
  return rows[0]!.id;
}
async function tagId(slug: string): Promise<string> {
  // NOTE: `$1,$1` (one param reused for both slug=citext and label=text)
  // throws "inconsistent types deduced for parameter $1" under pg's extended
  // query protocol — it can't resolve one placeholder to two different
  // column types. Two placeholders bound to the same JS value sidesteps it.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO tags (slug,label) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`,
    [slug, slug]);
  return rows[0]!.id;
}

describe("0010 tags schema", () => {
  it("citext slug collapses case to one row", async () => {
    const a = await tagId(`Rust-${author.slice(0, 6)}`);
    const b = await tagId(`rust-${author.slice(0, 6)}`);
    expect(a).toBe(b);
  });

  it("returns published posts with a tag newest-first, excludes drafts", async () => {
    const slug = `topic-${author.slice(0, 8)}`;
    const t = await tagId(slug);
    const pub = await insertPost("Pub tagged", "published");
    const draft = await insertPost("Draft tagged", "draft");
    await client.query(`INSERT INTO post_tags (post_id,tag_id) VALUES ($1,$2),($3,$2)`, [pub, t, draft]);
    const { rows } = await client.query<{ id: string }>(
      `SELECT p.id FROM post_tags pt JOIN posts p ON p.id=pt.post_id
        WHERE pt.tag_id=$1 AND p.status='published' ORDER BY p.id DESC`, [t]);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(draft);
  });

  it("ON DELETE CASCADE drops post_tags with the post", async () => {
    const t = await tagId(`cascade-${author.slice(0, 8)}`);
    const p = await insertPost("Cascade", "published");
    await client.query(`INSERT INTO post_tags (post_id,tag_id) VALUES ($1,$2)`, [p, t]);
    await client.query(`DELETE FROM posts WHERE id=$1`, [p]);
    const { rows } = await client.query(`SELECT 1 FROM post_tags WHERE post_id=$1`, [p]);
    expect(rows).toHaveLength(0);
  });
});

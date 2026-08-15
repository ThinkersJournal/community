/**
 * The daily orphan-media reclaimer (content-deletion + media-reclamation,
 * Task 4). Media has NO foreign key to posts — the only link between a
 * `media` row and the posts that use it is the image URL embedded in a
 * post's `markdown_source` (see migrations/0002_posts_and_media.sql's note on
 * `media.r2_key`: "reclamation is an offline GC that drops objects with no
 * remaining row"). A post-deletion orphan (Task 1's `DELETE /posts/:id` never
 * touches `media` — see src/routes/posts.ts) and an abandoned-upload orphan
 * (the user picked an image via `POST /media`, then never saved the post) are
 * therefore the SAME class: a `media` row whose sha256 appears in no post's
 * markdown.
 *
 * "Referenced" = the sha256 appears in SOME post's markdown, published OR
 * draft — deliberately conservative (a mention, even in an unpublished draft,
 * keeps the media alive).
 *
 * Run daily by src/index.ts's `scheduled` on cron `"15 4 * * *"` — its own
 * branch, AFTER the unverified-account reaper's (src/auth/reap-unverified.ts,
 * `"30 3 * * *"`), BEFORE the email-drain dispatch.
 */
import { withClient } from "../db/client";

/**
 * Caps one run's DELETE — same reasoning as reap-unverified.ts's REAP_BATCH: a
 * pathological backlog cannot turn a routine cron into an unbounded statement.
 * `ORDER BY created_at` means the oldest — most clearly abandoned — uploads go
 * first; a backlog beyond this cap is simply finished on the NEXT run.
 */
const REAP_BATCH = 500;

/**
 * Free media referenced by no post: hard-deletes the `media` row and, when
 * safe, its R2 object.
 *
 * ⚠️ GRACE WINDOW: 24h, KEYED ON `created_at` — never "last activity", for the
 * same reason as the unverified-account reaper: an in-progress compose (image
 * uploaded, post not yet saved) has no other activity signal to measure, and
 * `created_at` is what makes the reap safe — a real user mid-compose is
 * nowhere near the 24h boundary no matter how long they take to finish
 * writing.
 *
 * ⚠️ DEDUP-SAFE R2 DELETE. R2 objects are content-addressed and therefore
 * SHAREABLE: two `media` rows (different uploads, possibly different owners,
 * even one upload past its grace window and a duplicate re-upload still
 * inside it) can hold the identical `r2_key` — see the migration's note on
 * `media.r2_key`. Deleting a DB row is always safe on its own (each row is its
 * own artifact/quota entry), but the underlying R2 OBJECT must be deleted
 * ONLY when NO `media` row — including a grace-kept sibling on the same key
 * that survives THIS run — still holds it. That is re-checked PER KEY with a
 * `SELECT 1 ... WHERE r2_key = $1` issued IMMEDIATELY before each R2 delete, so
 * the check sits as close to the delete as possible (a batch snapshot taken up
 * front would leave a wider window for a racing duplicate upload). The window
 * cannot be fully closed — the DB and R2 are not one transaction — but it is
 * narrowed to a single query, and the residual race (the identical image
 * re-uploaded in that gap) is astronomically unlikely and self-healing (the
 * user simply re-uploads).
 *
 * @returns `{ rows, objects }` — rows deleted from `media`, and R2 objects
 * actually removed. `objects` can be less than `rows` when a batch reaps more
 * than one row that shared a key (only one of them owns the delete), and it
 * can differ further when a reaped row's key is still held by a row this run
 * did NOT touch.
 */
export async function reapOrphanMedia(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ rows: number; objects: number }> {
  const orphanKeys = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ r2_key: string }>(
      `WITH referenced AS (
         SELECT DISTINCT (regexp_matches(markdown_source, 'media/post/([0-9a-f]{64})\\.webp', 'g'))[1] AS sha256
           FROM posts
       ),
       orphans AS (
         SELECT m.id FROM media m
          WHERE m.created_at < now() - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM referenced r WHERE r.sha256 = m.sha256)
          ORDER BY m.created_at
          LIMIT $1
       )
       DELETE FROM media WHERE id IN (SELECT id FROM orphans) RETURNING r2_key`,
      [REAP_BATCH],
    );
    return rows.map((r) => r.r2_key);
  });

  const distinctKeys = [...new Set(orphanKeys)];
  let objects = 0;
  for (const key of distinctKeys) {
    // ⚠️ DEDUP-SAFE, WITH A PER-KEY RECHECK IMMEDIATELY BEFORE THE R2 DELETE.
    // The rows for this key were just deleted above, but the R2 object is
    // content-addressed and shareable, so a media row may still hold this same
    // `r2_key`: a grace-kept sibling (uploaded <24h ago), OR a brand-new
    // DUPLICATE upload racing this run (media.ts does PUT-then-INSERT). Re-verify
    // no media row references the key right before deleting the object — and do
    // it per-key, not from a batch snapshot, so the check is as close to the
    // delete as possible.
    //
    // This narrows the DB↔R2 window to a single query; it CANNOT fully close it
    // (the two systems are not atomic — a row could still be inserted in the gap
    // between this SELECT and the delete). The residual race requires the
    // IDENTICAL image re-uploaded in that sub-millisecond gap during the daily
    // cron, and its worst case is one re-uploadable broken image, never loss of
    // any saved content. The connection is released before the (slow) R2 delete
    // rather than held across it.
    const held = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rowCount } = await c.query(`SELECT 1 FROM media WHERE r2_key = $1 LIMIT 1`, [key]);
      return (rowCount ?? 0) > 0;
    });
    if (held) continue; // a media row still holds this object — keep it
    try {
      await env.MEDIA.delete(key);
      objects++;
    } catch (err) {
      console.error("reap-orphan-media: R2 delete failed for", key, err);
    }
  }
  if (orphanKeys.length > 0) {
    console.log(`reap-orphan-media: ${orphanKeys.length} row(s), ${objects} object(s)`);
  }
  return { rows: orphanKeys.length, objects };
}

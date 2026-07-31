-- Up Migration

-- The notifications table doubles as the email OUTBOX (M2.3c). emailed_at is the
-- watermark: NULL = not yet emailed. Stamped ONLY after a confirmed Postmark send,
-- so a failed send retries on the next pass.
ALTER TABLE notifications ADD COLUMN emailed_at timestamptz;

-- The drain predicate: unsent AND unread, per recipient, oldest first for coalescing.
CREATE INDEX notifications_outbox_idx
  ON notifications (recipient_id, created_at)
  WHERE emailed_at IS NULL AND read_at IS NULL;

-- Single-flight lease for the cron drain (one row per pass). A pass claims its row
-- with an atomic conditional UPDATE (a time-limited, auto-expiring lease — the TTL
-- and the leased_by owner-fence live in src/notifications/email-drain.ts and
-- migration 0008); a concurrent pass of the same disposition sees a live lease and
-- backs off. Committed row state — correct through Hyperdrive's transaction-mode
-- pooling, unlike a session advisory lock.
CREATE TABLE email_drain_lock (
  pass         text PRIMARY KEY,
  leased_until timestamptz
);
INSERT INTO email_drain_lock (pass) VALUES ('instant'), ('digest');

-- Down Migration
DROP TABLE IF EXISTS email_drain_lock;
DROP INDEX IF EXISTS notifications_outbox_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS emailed_at;

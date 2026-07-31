-- Up Migration

-- Per-user notification settings AND the badge "seen" watermark (M2.3c). One row
-- per user; an ABSENT row means all defaults (queries LEFT JOIN + COALESCE), so
-- there is no signup backfill. seen_at drives the unread BADGE (decision 10);
-- read_at on notifications (0005) drives EMAIL suppression — deliberately separate.
CREATE TYPE notification_channel AS ENUM ('instant', 'digest', 'off');

CREATE TABLE notification_prefs (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  master_enabled boolean              NOT NULL DEFAULT true,
  direct         notification_channel NOT NULL DEFAULT 'instant',
  reactions      notification_channel NOT NULL DEFAULT 'digest',
  follows        notification_channel NOT NULL DEFAULT 'digest',
  seen_at        timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS notification_prefs;
DROP TYPE IF EXISTS notification_channel;

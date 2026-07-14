-- Up Migration
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username citext UNIQUE NOT NULL,
  display_name text,
  bio text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
-- profiles first (it references users). citext is intentionally left installed.
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS users;

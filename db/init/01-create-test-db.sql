-- Runs once, on first boot of an empty Postgres data directory
-- (mounted into /docker-entrypoint-initdb.d/). The `postgres` image only
-- creates the single database named by POSTGRES_DB, so the test database is
-- created here alongside it.
CREATE DATABASE thinkersjournal_test;

-- Runs once, on first boot of an empty Postgres data directory
-- (mounted into /docker-entrypoint-initdb.d/). The `postgres` image only
-- creates the single database named by POSTGRES_DB, so the test databases are
-- created here alongside it.

-- The SHARED test fixture DB. Everything that needs a schema to query against
-- uses this one: the "pool" Worker tests (via both Hyperdrive bindings) and the
-- non-destructive "node" schema tests. Migrated by vitest's globalSetup.
CREATE DATABASE thinkersjournal_test;

-- The DESTRUCTIVE migration round-trip's OWN database — deliberately separate.
--
-- test/migrations.db.test.ts proves the migration SQL by actually running it:
-- its `down` drops EVERY table in the stack (media, posts, profiles, users),
-- then `up` recreates them. On the shared DB that is a live race: vitest runs
-- test PROJECTS in parallel unless `sequence.groupOrder` says otherwise, so the
-- "pool" tests query `users` through Hyperdrive at the same instant the "node"
-- project is dropping it ("relation \"users\" does not exist"). That test needs
-- *a* database, not the shared fixture, so it gets its own and the race becomes
-- structurally impossible rather than a scheduling constraint someone can lose.
CREATE DATABASE thinkersjournal_migrations_test;

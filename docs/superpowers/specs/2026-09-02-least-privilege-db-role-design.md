# Least-Privilege Runtime DB Role — Design & Runbook

**Status:** Design for founder review. The two production steps (role creation,
Hyperdrive rewiring) are **founder-executed** — they need Neon SQL access and
the Cloudflare dashboard, neither of which the agent holds (token is `zone: read`
only, and the rotated Neon password is deliberately never in agent context).

**Author:** controller agent, 2026-09-02, dispatched by the portfolio PM as
non-DNS-gated security work.

---

## 1. Problem

The runtime Workers authenticate to Postgres as **`neondb_owner`**, via both
Hyperdrive configs (`tj-hyperdrive-fresh` `0c47…c98f`, `tj-hyperdrive-cached`
`8e0f…1e60`). `neondb_owner` is the database owner — effectively near-superuser:
it can `DROP` any table, `TRUNCATE`, `ALTER` schema, `CREATE`/`DROP ROLE`, read
and rewrite everything. A SQL-injection or logic bug in the request path executes
with **all** of that authority.

This is standard security debt, and it is **strictly worse the moment the
platform is publicly reachable** (which, as of 2026-09-02, it is — see
[[deploy-state]]). The fix is a dedicated runtime role holding only the
privileges the request path actually uses, so the blast radius of any runtime
compromise is bounded to DML on application tables.

**Migrations are out of scope of this reduction.** DDL (schema changes) keeps
running as `neondb_owner` through `apps/api/scripts/migrate.mjs`. Only the
*runtime* connection (Hyperdrive → Workers) moves to the reduced role.

---

## 2. Verified runtime DB surface

The grant list below is derived from the code and migrations, not guessed. What
the request path actually does against Postgres:

| Capability | Used? | Evidence | Privilege implied |
|---|---|---|---|
| `SELECT/INSERT/UPDATE/DELETE` on app tables | ✅ | all of `src/routes/*`, `src/notifications/*` | DML on those tables |
| Sequences (`SERIAL`/`IDENTITY`/`nextval`) | ❌ none | no match in any migration; IDs are app-generated | **no sequence grants** |
| `LISTEN`/`NOTIFY` (Postgres pub/sub) | ❌ | "notify" in code = NotifyDO WebSocket, not DB | none |
| Advisory locks (`pg_advisory_*`) | ❌ | email-drain lock is a **table** + conditional-UPDATE lease (`migrations/0007`,`0008`; `src/notifications/email-drain.ts`) | covered by table DML |
| `SET LOCAL` params (`lock_timeout`, `idle_in_transaction_session_timeout`, `pg_trgm.word_similarity_threshold`) | ✅ | `src/db/client.ts:52-53`, `src/routes/search.ts:68` | **none** — all USERSET, settable by any role |
| Extension functions (`citext`, `pg_trgm` — `word_similarity`, `%`) | ✅ | `migrations/0001`,`0009`; `src/routes/search.ts` | **none** — extension `EXECUTE` defaults to `PUBLIC` |
| Runtime DDL (`CREATE`/`ALTER`/`DROP`/`TRUNCATE`) | ❌ | none in request path; all DDL is in migrations | none |
| Temp tables (`CREATE TEMP`) | ❌ | no match | none |
| `SET ROLE` / `SET search_path` | ❌ | no match (only `SET LOCAL` of USERSET params) | none |

**Conclusion:** the runtime needs exactly **DML on the public application tables**,
plus `USAGE` on schema `public` and `CONNECT` on the database. Nothing else.

Application tables (from migrations 0001–0011): `users`, `profiles`, `posts`,
`media`, `follows`, `comments`, `reactions`, `notifications`,
`notification_prefs`, `email_outbox`, `email_drain_lock`, `tags`, `post_tags`.
Plus the `pgmigrations` bookkeeping table (node-pg-migrate) — which the runtime
**never touches** (optional tightening in §4).

---

## 3. The role

Run as `neondb_owner` (or a Neon console admin) against the `neondb` database.
Replace `<STRONG_PASSWORD>` with a freshly generated secret **that never enters
agent context, chat, or a tool-call parameter** — same discipline as the Neon
owner password.

```sql
-- 3.1 The role: login-capable, but nothing that lets it escalate or reshape.
CREATE ROLE app_runtime
  LOGIN
  PASSWORD '<STRONG_PASSWORD>'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOREPLICATION
  NOINHERIT;              -- it is a member of nothing; NOINHERIT makes that explicit

-- 3.2 Reach the database and the schema (default PUBLIC grants may already
--     cover these on Neon; issuing them explicitly is idempotent and documents intent).
GRANT CONNECT ON DATABASE neondb TO app_runtime;
GRANT USAGE   ON SCHEMA   public TO app_runtime;

-- 3.3 DML on every existing application table.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO app_runtime;

-- 3.4 THE LINE THAT PREVENTS SILENT BREAKAGE ON THE NEXT MIGRATION.
--     ALTER DEFAULT PRIVILEGES only affects objects created by the named role.
--     Migrations run as neondb_owner, so future migration tables auto-grant to
--     app_runtime. WITHOUT this, every new table would be invisible to the
--     runtime until someone remembered to re-run 3.3 — a latent outage.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

**No `GRANT ... ON ALL SEQUENCES`** — there are none (see §2). If a future
migration ever introduces a `SERIAL`/`IDENTITY` column, that migration must also
add `GRANT USAGE, SELECT ON <seq> TO app_runtime` **and** a matching
`ALTER DEFAULT PRIVILEGES ... GRANT USAGE, SELECT ON SEQUENCES` — flagged in §7
as a standing rule.

---

## 4. Optional tightening (defensible either way)

- **Exclude `pgmigrations`.** §3.3 grants DML on it too (it's a table in
  `public`). The runtime never reads or writes it. To be strict:
  `REVOKE ALL ON pgmigrations FROM app_runtime;` after §3.3. Low value (it's
  bookkeeping, not sensitive), listed for completeness.
- **Column-level on `users`.** The runtime reads `email_verified_at`, the auth
  columns, etc. Column grants would over-fit the current query shapes and break
  on the next `SELECT *`; **not recommended** — table-level DML is the right
  altitude here.

---

## 5. Hyperdrive rewiring (zero-downtime cutover)

Both Hyperdrive configs must move from the `neondb_owner` connection string to an
`app_runtime` one. The **order matters** — grant before swap, or the app breaks
the instant it connects as a role with no table access.

> **⚠️ The load-bearing line is §3.4** — `ALTER DEFAULT PRIVILEGES FOR ROLE
> neondb_owner … GRANT … ON TABLES`. It is **not one grant among many**; it is
> the one that keeps the split alive past today. Skip it and everything in this
> runbook works perfectly — then breaks **silently, days later**, when the next
> migration adds a table `app_runtime` cannot see, and the failure arrives
> attached to a schema change rather than to the privilege change that caused it.
> Treat §3.4 as the point of this runbook, not a step within it.

**Runbook (founder-executed; agent verifies each checkpoint from outside):**

1. **Grant first.** Run all of §3 against prod — **including §3.4, the line
   above.** The role now exists with full DML but nothing is using it yet.
2. **Verify the role can do its job AND cannot exceed it** (see §6) — from a
   `psql` session as `app_runtime`, before touching Hyperdrive.
3. **Swap the FRESH config** (`tj-hyperdrive-fresh`) to the `app_runtime`
   connection string (same host `ep-purple-sun-a68hzw35`, DIRECT/non-pooler
   endpoint, db `neondb`, user `app_runtime`). Hyperdrive picks up config live —
   no redeploy.
4. **Agent verifies:** a FRESH-path write still 201s (a cache-disabled signup →
   live round-trip). If it 500s, the grant is wrong — roll back this one config
   (step 8) and stop.
5. **Swap the CACHED config** (`tj-hyperdrive-cached`) the same way.
6. **Agent verifies:** a CACHED-path read 200s after a forced cache-miss.
7. **Done.** Both configs authenticate as `app_runtime`. `neondb_owner` is now
   used only by `migrate.mjs`.
8. **Rollback (any step):** put the `neondb_owner` connection string back into the
   affected Hyperdrive config. Instant, no redeploy, no data change. The role and
   grants can stay in place harmlessly on a rollback.

**Why grant-then-swap and not swap-then-grant:** the grants are additive and
invisible until something connects as `app_runtime`; doing them first means step 3
is the only state change with user-visible effect, and it has a one-line rollback.

---

## 6. Proof of least-privilege (run as `app_runtime`)

The point of the split is not just "it still works" but "it can no longer do the
dangerous thing." Verify BOTH, from a `psql` session connected as `app_runtime`:

```sql
-- CAN (must succeed):
SELECT count(*) FROM posts;                         -- read
INSERT INTO tags (…) VALUES (…); ROLLBACK;          -- write (rolled back)

-- CANNOT (must each error):
CREATE TABLE evil (x int);                           -- ERROR: permission denied for schema public
DROP TABLE posts;                                    -- ERROR: must be owner of table posts
CREATE ROLE mallory LOGIN;                           -- ERROR: permission denied to create role
ALTER TABLE posts ADD COLUMN x int;                  -- ERROR: must be owner of table posts
TRUNCATE posts;                                      -- ERROR: permission denied for table posts
```

If any "CANNOT" succeeds, the role is over-privileged — stop and re-check §3.1.

---

## 7. Standing rules after the split

- **Migrations keep running as `neondb_owner`.** The `ALTER DEFAULT PRIVILEGES
  FOR ROLE neondb_owner` in §3.4 is what makes new tables reachable by the
  runtime; if the migration runner's role ever changes, that line must change to
  match, or new tables become invisible to the app.
- **Any migration that adds a sequence** (`SERIAL`/`IDENTITY`/`CREATE SEQUENCE`)
  must grant `USAGE, SELECT` on it to `app_runtime` and add a matching
  `ALTER DEFAULT PRIVILEGES ... ON SEQUENCES`. There are none today; this is the
  rule for when there is.
- **Any migration that adds a `SECURITY DEFINER` function or a table with RLS**
  needs its own grant review — `NOBYPASSRLS` on the role means RLS would actually
  apply to it, which is usually what you want but must be designed with the policy.

---

## 8. Founder decision points

1. **Role provisioning mechanism:** create `app_runtime` via **raw SQL** (as
   above — simplest, password set inline) or via the **Neon console/API** (Neon
   then manages the credential and it shows in the dashboard). Either works with
   Hyperdrive; the SQL path is fewer moving parts, the console path is more
   Neon-native. Recommendation: SQL path, since Hyperdrive needs the raw
   connection string regardless.
2. **Timing vs. launch:** this reduces exposure rather than adding a feature, so
   it is worth doing **before** any public-launch decision — but it is a live
   production change to the DB auth path, so it is sequenced at the founder's
   discretion. It is fully independent of the DNS cutover and the M3/M4 question.
3. **`pgmigrations` tightening** (§4): strict or skip.

---

## 9. Agent's role in execution

The agent **cannot** create the role or edit Hyperdrive (no DB password, no zone
write). On the founder's go, the agent:
- hands over the exact SQL (§3) and the verification queries (§6) for the founder
  to run at his terminal,
- verifies each Hyperdrive-swap checkpoint from the **outside** (signup 201 on
  FRESH, forced-cache-miss read 200 on CACHED — no DB secret needed), exactly as
  it verified the two Neon password rotations. This is the only instrument that
  can tell *"the swap worked"* apart from *"I'm still authenticated as the old
  role"*: a check that needs the credential being changed cannot distinguish the
  two. Verifying from outside tests the property that matters — *can the app
  serve a request* — not a proxy for it,
- and confirms green before declaring the split complete.

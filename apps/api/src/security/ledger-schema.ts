/**
 * `SecurityLedgerDO`'s tables (security-alerting spec §2.6, "Storage and
 * retention"). Additions to the spec's illustrative DDL (§8: not executed), each
 * one a column the spec's prose needs but its list omits:
 * - `held.subject_kind`: an account row is rendered as a ref, an ip row as a prefix.
 * - `class_day.suppressed`: `budget_exhausted.suppressedSoFar` (§3.2).
 * - `class_period`: the digest's per-class counts since the last digest (§2.6 step 5).
 * - `outbox.covers`: a held report's `S` and each named row's key and version (§2.6, F2).
 * - `outbox.sent_ms`: set the moment the sink accepts a row, BEFORE its delete, so
 *   a row whose delete fails is never sent again (batch-2 re-review m-A).
 */
export const LEDGER_SCHEMA: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  `CREATE TABLE IF NOT EXISTS held (signal_class TEXT NOT NULL, subject_key TEXT NOT NULL, signal TEXT NOT NULL,
     subject_kind TEXT NOT NULL, subject TEXT NOT NULL, events INTEGER NOT NULL, suppressed INTEGER NOT NULL,
     version INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY (signal_class, subject_key)) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS held_class_version ON held (signal_class, version)",
  // R2-1: forgetAccount and the nightly sweep find an account's rows without scanning `held`.
  "CREATE INDEX IF NOT EXISTS held_subject ON held (subject_kind, subject)",
  `CREATE TABLE IF NOT EXISTS held_overflow (signal_class TEXT NOT NULL, day TEXT NOT NULL, counted INTEGER NOT NULL,
     PRIMARY KEY (signal_class, day)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS cooldowns (signal TEXT NOT NULL, subject TEXT NOT NULL, until_ms INTEGER NOT NULL,
     PRIMARY KEY (signal, subject)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS class_day (class TEXT NOT NULL, day TEXT NOT NULL, sent INTEGER NOT NULL,
     onset_signals TEXT NOT NULL, exhausted_queued INTEGER NOT NULL, suppressed INTEGER NOT NULL,
     PRIMARY KEY (class, day)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS class_period (class TEXT PRIMARY KEY, sent INTEGER NOT NULL,
     by_cooldown INTEGER NOT NULL, by_budget INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, message TEXT NOT NULL, covers TEXT,
     attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL, sent_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS account_refs (user_id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
     last_used_ms INTEGER NOT NULL) WITHOUT ROWID`,
  // PR 2 (§2.6 m-e): an anonymised account's tombstone, so a late report cannot re-create its rows.
  "CREATE TABLE IF NOT EXISTS forgotten (user_id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL) WITHOUT ROWID",
  // Batch-2 review I-2: an outbox row whose HANDLING threw on every attempt, moved
  // out of the way (message only, never `covers`) and kept a week for inspection.
  "CREATE TABLE IF NOT EXISTS outbox_poison (id INTEGER PRIMARY KEY, message TEXT NOT NULL, poisoned_ms INTEGER NOT NULL)",
];

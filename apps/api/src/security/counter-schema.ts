/**
 * `SecurityCounterDO`'s tables (security-alerting spec §2.4). Every table with a
 * composite key is `WITHOUT ROWID` (R6). One addition to the spec's illustrative
 * DDL (§8 says it was not executed): `reports.rkey`, the (signal, subject) key
 * a pending report is merged on (§2.4 m4), with its index.
 */
export const COUNTER_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS buckets (subject TEXT NOT NULL, minute INTEGER NOT NULL, route TEXT NOT NULL,
     counts TEXT NOT NULL, PRIMARY KEY (subject, minute, route)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS members (signal TEXT NOT NULL, subject TEXT NOT NULL, minute INTEGER NOT NULL,
     member TEXT NOT NULL, PRIMARY KEY (signal, subject, minute, member)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, rkey TEXT NOT NULL, report TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS reports_rkey ON reports (rkey)",
  `CREATE TABLE IF NOT EXISTS last_report (signal TEXT NOT NULL, subject TEXT NOT NULL, at_ms INTEGER NOT NULL,
     PRIMARY KEY (signal, subject)) WITHOUT ROWID`,
  "CREATE TABLE IF NOT EXISTS overflow (minute INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
];

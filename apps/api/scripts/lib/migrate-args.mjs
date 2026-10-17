/**
 * PURE argument parsing and target resolution for `apps/api/scripts/migrate.mjs`
 * (#116 fix round 2 ruling — split out so that file can run with no entry-point
 * guard; see `scripts/lib/migration-gate.mjs`'s header for the full fail-open
 * story this answers). This file has NO side effects whatsoever (no
 * `node-pg-migrate` import, no database connection, no filesystem access, no
 * `process` access: the environment is passed in), so importing it can never
 * run a migration.
 *
 * ⚠️ WHY TARGET RESOLUTION LIVES HERE (2026-10-17 incident): `migrate.mjs`
 * used to fall back SILENTLY to the localhost dev database when `DATABASE_URL`
 * was unset, so a production URL held under another variable name migrated the
 * LOCAL database and printed nothing that said so. `resolveTarget` is the fix,
 * and it is a pure function of `(argv, env)` so every branch is unit-tested:
 *   1. an unset `DATABASE_URL` for the dev target is an ERROR unless `--local`
 *      says the localhost default is what you meant;
 *   2. a host that is not loopback is refused unless `--allow-remote` says so;
 *   3. the caller prints `banner` (host, port, database; never the user or
 *      password) BEFORE it connects.
 */

// Two plain constants, not an object: the side-effect test splits statements by brace depth.
export const DEFAULT_DEV_URL = "postgres://postgres:postgres@localhost:5432/thinkersjournal";
export const DEFAULT_TEST_URL = "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const KNOWN_FLAGS = ["--local", "--allow-remote"];

/** Flags (`--local`, `--allow-remote`) and positionals (`target direction count`) are separated here. */
export function splitArgs(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => !KNOWN_FLAGS.includes(f));
  if (unknown.length > 0) {
    // A typo such as `--allow-remot` must not silently mean "no flag".
    throw new Error(`unknown flag ${unknown.join(", ")} — known flags: ${KNOWN_FLAGS.join(", ")}`);
  }
  return { positional, local: flags.includes("--local"), allowRemote: flags.includes("--allow-remote") };
}

export function parseArgs(argv) {
  const positional = splitArgs(argv).positional;
  const target = positional[0] ?? "dev"; // "dev" | "test"
  const direction = positional[1] ?? "up"; // "up" | "down"
  const countArg = positional[2];

  // `up` applies all pending migrations by default; `down` reverts one at a
  // time. An explicit `countArg` overrides either default, regardless of
  // direction.
  let count = direction === "down" ? 1 : Infinity;
  if (countArg !== undefined) {
    const parsed = Number(countArg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `count must be a positive integer, got "${countArg}" — e.g. ` +
          `\`node scripts/migrate.mjs dev up 1\` to apply exactly one pending migration.`,
      );
    }
    count = parsed;
  }

  return { target, direction, count };
}

/** host, port and database of a connection string. Never the user or the password, and never echoes the string. */
export function describeTarget(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Deliberately not including the string: it may hold a password.
    throw new Error("the database URL is not a valid URL (value not shown)");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return { host: url.hostname, port: url.port === "" ? "5432" : url.port, database };
}

/** True when the host is this machine. */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(host.toLowerCase());
}

/**
 * Resolves what to migrate. `env` is `process.env`, passed in so this stays pure.
 * Returns `{ target, direction, count, databaseUrl, host, port, database, banner }`.
 */
export function resolveTarget(argv, env) {
  const { target, direction, count } = parseArgs(argv);
  const { local, allowRemote } = splitArgs(argv);
  if (target !== "dev" && target !== "test") {
    throw new Error(`unknown target "${target}" — expected "dev" or "test"`);
  }

  const envName = target === "test" ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const fromEnv = env[envName];
  const isSet = fromEnv !== undefined && fromEnv !== "";

  // The test default is a throwaway local database; the DEV default is the one that must be asked for.
  if (!isSet && target === "dev" && !local) {
    throw new Error(
      `${envName} is not set. Refusing to fall back to the localhost dev database silently. ` +
        `Set ${envName}, or pass --local if the localhost dev database is what you mean.`,
    );
  }
  const databaseUrl = isSet ? fromEnv : target === "test" ? DEFAULT_TEST_URL : DEFAULT_DEV_URL;

  const { host, port, database } = describeTarget(databaseUrl);
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `${envName} points at a non-local host (${host}:${port}/${database}). ` +
        `Re-run with --allow-remote if you mean to migrate that database.`,
    );
  }

  const source = isSet ? envName : "the built-in localhost default";
  const banner = `migrate ${target} ${direction}${count === Infinity ? "" : ` ${count}`}: ${host}:${port}/${database} (from ${source})`;
  return { target, direction, count, databaseUrl, host, port, database, banner };
}

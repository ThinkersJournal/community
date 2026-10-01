/**
 * PURE argument parsing for `apps/api/scripts/migrate.mjs` (#116 fix round 2
 * ruling — split out of that file so it can run with no entry-point guard).
 *
 * Fix round 1 added an optional `count` argument and, to make the parsing
 * testable without a database connection, guarded `migrate.mjs`'s real work
 * behind `import.meta.url === pathToFileURL(process.argv[1]).href`. The
 * controller found that comparison can FAIL OPEN (a symlinked path in the
 * environment, or a Windows drive-letter/case mismatch, makes it wrongly
 * `false`) — for this script that means a "apply the migration" run would
 * silently do nothing and report nothing, which is just as dangerous here as
 * it is for the deploy gate: a migration that was never applied looks, from
 * the outside, identical to one that succeeded.
 *
 * The fix: this file has NO side effects whatsoever (no `node-pg-migrate`
 * import, no database connection, no filesystem access) — importing it for
 * `parseArgs` can never run a migration, so `migrate.mjs` itself needs no
 * conditional and runs unconditionally, exactly as it did before round 1.
 */
export function parseArgs(argv) {
  const target = argv[0] ?? "dev"; // "dev" | "test"
  const direction = argv[1] ?? "up"; // "up" | "down"
  const countArg = argv[2];

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

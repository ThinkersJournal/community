/**
 * PURE argument parsing for `apps/api/scripts/migrate.mjs` (#116 fix round 2
 * ruling — split out so that file can run with no entry-point guard; see
 * `scripts/lib/migration-gate.mjs`'s header for the full fail-open story
 * this answers). This file has NO side effects whatsoever (no
 * `node-pg-migrate` import, no database connection, no filesystem access),
 * so importing it for `parseArgs` can never run a migration.
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

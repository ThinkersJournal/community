// SPDX-License-Identifier: MIT OR Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The deploy runbook's "Migrations waiting for CireSnave to apply" table must not go stale. 0042 and 0043 each added their own
 * prose section but no row, so the table kept saying "(none), applied through 0040" while production lacked 0041 to 0043
 * (found 2026-11-12, during the 418 deploy). Every migration newer than the table's "Applied through `NNNN`" line must have a
 * row that names it, and when no migration is waiting the line must name the newest one.
 */
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const runbook = readFileSync(join(migrationsDir, "../../../docs/runbooks/deploy.md"), "utf8");

const numbers = readdirSync(migrationsDir)
  .map((f) => /^(\d{4})_.*\.sql$/.exec(f)?.[1])
  .filter((n): n is string => n !== undefined)
  .sort();

const section = /## Migrations waiting for CireSnave to apply to production([\s\S]*?)\n## /.exec(runbook)?.[1] ?? "";
const rows = section.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*(Migration|---)/.test(l));
const appliedThrough = /Applied through `?(\d{4})/.exec(section)?.[1];

describe("deploy runbook: migrations waiting list", () => {
  it("has the table and an 'Applied through' marker (control: the parser finds them)", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(appliedThrough).toMatch(/^\d{4}$/);
    expect(numbers.length).toBeGreaterThan(40);
  });

  it("names every migration newer than the 'Applied through' marker in a row of its own", () => {
    const waiting = numbers.filter((n) => n > appliedThrough!);
    const unlisted = waiting.filter((n) => !rows.some((r) => r.includes(`\`${n}`)));
    expect(unlisted, `migrations missing from the waiting table: ${unlisted.join(", ")}`).toEqual([]);
  });

  it("says nothing is waiting only when the marker is the newest migration", () => {
    if (rows.some((r) => r.includes("(none)"))) expect(appliedThrough).toBe(numbers[numbers.length - 1]);
  });
});

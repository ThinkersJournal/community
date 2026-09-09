import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ⚠️ NO DOCUMENT MAY ASSERT AN ENFORCED BAN THE CODE CANNOT DELIVER.
 *
 * ⚠️⚠️ GREEN HERE DOES NOT MEAN BAN WORKS. IT DOES NOT WORK.
 * This file measures ONE thing: whether an authoritative document CLAIMS an
 * enforced ban while nothing can enforce one. Green means the claim and the
 * code agree — which is satisfied by CORRECTING THE CLAIM, and that is how it
 * was made green. **The enforcement gap itself is issue #35 and is still open.**
 *
 * ⚠️ IF YOU ARE HERE BECAUSE YOU ARE SHIPPING THE CSAM TERMINATION HOOK, OR
 * ANYTHING ELSE THAT NEEDS A USER TO STAY OUT: THE PRIMITIVE DOES NOT EXIST
 * YET. Read #35, not this file's exit code.
 *
 * The file was first written as `ban-claim-is-enforceable` — a name that would
 * have read as "ban is enforceable" the moment it went green, which is the same
 * defect it exists to catch, manufactured by its own remedy. It is named for
 * WHAT GREEN MEANS instead.
 *
 * `docs/superpowers/specs/2026-07-13-community-platform-design.md` says of
 * itself: *"This spec is the **authoritative** decisions; that doc is the why."*
 * It carries no DRAFT marker and no temporal marker. At §"Auth & sessions" it
 * states the `security_epoch` gives **"strongly-consistent ban/logout-everywhere"**.
 *
 * ⚠️ THE EPOCH KILLS EXISTING SESSIONS AND DOES NOTHING ABOUT NEW ONES.
 * `users` has five columns — id, email, password_hash, email_verified_at,
 * created_at — and `src/routes/login.ts` authenticates with
 * `SELECT id, password_hash FROM users WHERE email = $1`. A banned user logs
 * straight back in and receives a fresh session carrying the CURRENT epoch, so
 * the epoch comparison in `src/auth/pipeline.ts` passes. The ban survives
 * exactly until the next login.
 *
 * # Why this test exists rather than a note in the issue
 *
 * Issue #35 records the gap and has an OWNER. It has no DETECTOR: nothing goes
 * red while the claim and the schema disagree, so the disagreement persists
 * only until someone happens to re-read one of them. **A trigger sentence in an
 * issue body is not a detector, and neither is a date.**
 *
 * ⚠️ The consumer that makes it expensive is the CSAM termination hook, which
 * shares this primitive, and `src/auth/reap-unverified.ts` hard-DELETEs
 * unverified accounts after 7 days — so a ban that does not ban means the
 * banned user AND the evidence are gone in a week.
 *
 * # How this test dies
 *
 * It is a DEFERRAL DETECTOR and it is supposed to stop failing. It goes green
 * the moment EITHER side is made true:
 *
 *   - module 2c lands the status column AND login refuses on it, or
 *   - the spec is corrected to describe what the epoch actually achieves.
 *
 * Both are correct outcomes. What must not happen is the pair drifting apart
 * silently again, which is the only state this test refuses.
 *
 * ⚠️ WHY A `.node.test.ts` (no DB): it reads this repo's own source and docs.
 * workerd's filesystem is virtual, so a pool test cannot read them — same
 * reason as test/hidden-at-read-guard.node.test.ts. Touches NO database.
 */

const REPO_ROOT = join(import.meta.dirname, "../../..");
const SPEC = join(
  REPO_ROOT,
  "docs/superpowers/specs/2026-07-13-community-platform-design.md",
);
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const LOGIN = join(import.meta.dirname, "../src/routes/login.ts");

/**
 * The claim, as the spec words it. Anchored on prose rather than a line number
 * because line numbers rot.
 *
 * ⚠️ This test refuses exactly one state: claim present AND unenforceable.
 * Removing or correcting the claim makes it PASS, which is the intended
 * outcome — but so does rewording the claim into a different false sentence.
 * That blind spot is real and is stated in the failure message rather than
 * papered over. The `security_epoch` control below is what catches this test
 * being pointed at the wrong document; nothing catches a NEW falsehood, and
 * this test does not pretend to.
 */
const CLAIM = "strongly-consistent ban";

/**
 * Column names that would let the database express "this account is barred".
 * Any one of them is enough — this test does not prescribe the design, it only
 * asks whether SOMETHING can carry the state.
 */
const STATUS_COLUMNS = [
  "suspended_until",
  "disabled_at",
  "disabled_reason",
  "banned_at",
  "is_banned",
  "account_status",
];

function readSpec(): string {
  try {
    return readFileSync(SPEC, "utf8");
  } catch {
    throw new Error(
      `control: the design spec is missing at ${SPEC}. This test then measures ` +
        `nothing — repoint it rather than deleting it.`,
    );
  }
}

/** Every migration's SQL, concatenated. */
function allMigrations(): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  // Non-vacuity: an empty migrations directory would make "no status column"
  // trivially true and this test would pass having examined nothing.
  expect(
    files.length,
    "control: no .sql migrations found — the reader is broken, not the schema",
  ).toBeGreaterThan(10);
  return files.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");
}

/**
 * Does any migration add a status-bearing column TO `users`?
 *
 * ⚠️ STATEMENT-SCOPED AND CASE-INSENSITIVE, and that direction is deliberate.
 * A MISS here produces a FALSE RED *after* module 2c lands — the guard would
 * tell the lane their claim is unbacked exactly when they had just backed it,
 * which is how a detector gets muted and then deleted as flaky. So the reader
 * is permissive about FORM (line breaks, casing, quoted identifiers) and strict
 * only about WHAT it reads: a CREATE/ALTER statement on `users`.
 *
 * Comments are stripped first, because `0013` mentions `users.suspended_until`
 * in prose and a comment must never satisfy a schema claim.
 *
 * Adopted from a Codacy finding on this file, which observed that the original
 * per-line reader missed a column declared on a different line from its
 * `ALTER TABLE`.
 */
function schemaCanExpressABan(sql: string): string[] {
  // Strip line comments; a mention is not a column.
  const code = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  // Whole statements, so a column may sit on any line of its own statement.
  const found: string[] = [];
  for (const stmt of code.split(";")) {
    // Matches `users` and "users" alike — the quote characters sit outside
    // the word, so a quoted identifier still matches.
    if (!/\b(create|alter)\s+table\b[\s\S]*?\busers\b/i.test(stmt)) continue;
    for (const col of STATUS_COLUMNS) {
      if (stmt.toLowerCase().includes(col)) found.push(col);
    }
  }
  return [...new Set(found)];
}

describe("no document asserts an enforced ban the code cannot deliver", () => {
  it("if a spec claims an enforced ban, the login path must be able to refuse one", () => {
    const spec = readSpec();

    // Non-vacuity: we must still be reading the section that makes the claim.
    // If this fails we are reading the wrong file, and every verdict below is
    // meaningless rather than reassuring.
    expect(
      spec,
      `control: the design spec no longer mentions \`security_epoch\` at all — ` +
        `this test is reading the wrong document. Repoint it; do not delete it.`,
    ).toMatch(/security_epoch/);

    const claimPresent = spec.toLowerCase().includes(CLAIM.toLowerCase());

    const sql = allMigrations();
    const columns = schemaCanExpressABan(sql);

    const login = readFileSync(LOGIN, "utf8");
    // Non-vacuity: the login route must still be the thing that authenticates.
    expect(
      login,
      "control: src/routes/login.ts no longer queries `users` — repoint this test",
    ).toMatch(/FROM users/i);

    const loginLower = login.toLowerCase();
    const enforceable =
      columns.length > 0 &&
      columns.some((c) => loginLower.includes(c.toLowerCase()));

    // ⚠️ THE ONLY REFUSED STATE IS THE CONJUNCTION: the spec claims an enforced
    // ban AND nothing can enforce one. Fixing EITHER side makes this green.
    expect(
      !(claimPresent && !enforceable),
      `THE AUTHORITATIVE DESIGN SPEC CLAIMS ${JSON.stringify(CLAIM)} AND THE ` +
        `LOGIN PATH CANNOT DELIVER ONE.\n\n` +
        `  spec:  docs/superpowers/specs/2026-07-13-community-platform-design.md\n` +
        `         "This spec is the authoritative decisions" — no DRAFT marker,\n` +
        `         no temporal marker. Claim present: ${claimPresent}\n` +
        `  users: status-bearing columns in migrations: ` +
        `${columns.length > 0 ? JSON.stringify(columns) : "NONE"}\n` +
        `  login: consults one of them: ${enforceable}\n\n` +
        `The security_epoch invalidates EXISTING sessions. It does not stop a ` +
        `banned user logging back in, because nothing in the login query can ` +
        `express that the account is barred.\n\n` +
        `This is issue #35. Resolve it EITHER WAY and this test goes green:\n` +
        `  - land the status column and make login refuse on it (module 2c), or\n` +
        `  - correct the spec to describe what the epoch actually achieves.\n\n` +
        `⚠️ KNOWN LIMIT, stated rather than hidden: this test keys on ONE phrase. ` +
        `Rewording the claim to a DIFFERENT false sentence makes it go green ` +
        `while the defect remains. It guards a known disagreement; it is not a ` +
        `general falsehood detector, and it must not be read as one.`,
    ).toBe(true);
  });

  /**
   * ⚠️ THE READER'S OWN TWO-SIDED TEST, and it exists because of the failure
   * DIRECTION. A miss here reads as "no enforcement" and keeps the guard RED
   * *after* module 2c lands — telling the lane their claim is unbacked exactly
   * when they had just backed it. That is how a detector gets muted and then
   * deleted as flaky, so the reader is exercised against the awkward forms
   * directly rather than trusted.
   *
   * ⚠️ Deliberately a UNIT test over SQL strings, NOT a forced migration file.
   * `test/global-setup.ts` applies `migrations/` to the SHARED test database, so
   * a throwaway migration mutates state that outlives the run and breaks the
   * next person's suite. Measured the hard way: an earlier forced 2c simulation
   * left `users.suspended_until` and a `pgmigrations` row behind, and the next
   * run aborted with "Not run migration ... is preceding already run migration"
   * before executing a single test.
   */
  it("the schema reader survives multi-line, quoted and upper-case DDL", () => {
    const positives: Array<[string, string]> = [
      ["single line", "ALTER TABLE users ADD COLUMN suspended_until timestamptz;"],
      ["multi-line", 'ALTER TABLE users\n  ADD COLUMN suspended_until timestamptz;'],
      ["quoted identifier", 'ALTER TABLE "users" ADD COLUMN disabled_at timestamptz;'],
      ["upper case", "ALTER TABLE USERS ADD COLUMN SUSPENDED_UNTIL TIMESTAMPTZ;"],
      [
        "inside a CREATE body",
        "CREATE TABLE users (\n  id uuid PRIMARY KEY,\n  disabled_at timestamptz\n);",
      ],
    ];
    for (const [label, sql] of positives) {
      expect(
        schemaCanExpressABan(sql).length,
        `the reader missed a status column in the ${label} form — this produces a ` +
          `FALSE RED after module 2c lands, which is the failure direction that ` +
          `gets guards deleted`,
      ).toBeGreaterThan(0);
    }

    const negatives: Array<[string, string]> = [
      [
        "a comment is not a column",
        "-- truthful after users.suspended_until moves on\nCREATE TABLE moderation_actions (id uuid);",
      ],
      [
        "another table's column does not back a ban on users",
        "ALTER TABLE sessions ADD COLUMN disabled_at timestamptz;",
      ],
      ["no DDL at all", "SELECT suspended_until FROM users;"],
    ];
    for (const [label, sql] of negatives) {
      expect(
        schemaCanExpressABan(sql),
        `the reader accepted ${label} — it would then report enforcement that does ` +
          `not exist, which is the silent direction`,
      ).toEqual([]);
    }
  });
});

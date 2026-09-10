import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ⚠️ THE DMCA AGENT'S PHONE NUMBER APPEARS ON THE DMCA PAGE AND NOWHERE ELSE.
 *
 * This encodes a founder ruling that otherwise lives only in a chat relay.
 * CireSnave, verbatim (number elided — see below for why):
 *
 *   "As the DMCA agent, I'm fine with my phone number being published. It's
 *    [...]. Obviously, don't put it in as a primary contact number for the site
 *    but for things like DMCA where there are legal reasons for people to
 *    *need* to contact me, I'm fine with it."
 *
 * ⚠️ THE PERMISSION AND ITS CONSTRAINT ARE ONE RULING AND TRAVEL TOGETHER. The
 * number is a personal line published for a specific legal purpose — §512(c)(3)
 * requires a designated agent a notice sender can reach. It is NOT a general
 * contact number for the site. Putting it in a footer, a contact page, an
 * /about, or structured data would honour the first half of that sentence and
 * discard the second.
 *
 * ⚠️ WHY A TEST AND NOT A NOTE. A constraint that lives only in a relayed
 * message is maintained by whoever happens to remember it. This one erodes in
 * the most ordinary way imaginable: somebody builds a contact page and reaches
 * for the phone number the repo already contains. Nothing would object to that.
 * This objects.
 *
 * ⚠️ THE NUMBER IS READ FROM THE POLICY, NEVER HARDCODED HERE — AND THE FIRST
 * DRAFT OF THIS FILE FAILED ITS OWN GUARD FOR EXACTLY THAT REASON. It quoted
 * the ruling in full and stored the digits in a constant, so the repository
 * then contained the number in two places and the scan correctly flagged the
 * second. The tempting fix was to exempt this file. That would have been wrong
 * twice over: it spreads the number the rule exists to contain, and it exempts
 * by CATEGORY ("the guard's own file") rather than by any property that makes
 * the copy safe. Deriving it from the policy removes the second copy instead of
 * excusing it — and means a change to the number is followed automatically.
 *
 * GREEN HERE MEANS: no file outside the DMCA policy carries the number. It does
 * NOT mean the number is correct, that the registration is current, or that the
 * agent reads the inbox printed beside it. Those are `docs/legal/README.md`'s
 * business.
 *
 * ⚠️ WHY A `.node.test.ts` (no DB): it reads the repo's own files, and workerd's
 * filesystem is virtual — same reason as test/hidden-at-read-guard.node.test.ts.
 * Touches NO database.
 */

const REPO_ROOT = join(import.meta.dirname, "../../..");

/** The one file allowed to carry it, repo-relative with forward slashes. */
const ALLOWED = "docs/legal/dmca-policy.md";

/**
 * Directories that are not ours to police, plus build output. Kept short and
 * explicit: a broad ignore list is how a scan quietly stops covering the tree it
 * claims to cover.
 */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", ".wrangler", ".vercel", "coverage",
  ".superpowers", "playwright-report", "test-results",
]);

const TEXT_EXT = new Set([
  ".md", ".mdx", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".astro", ".json",
  ".jsonc", ".html", ".css", ".txt", ".yml", ".yaml", ".sql",
]);

/**
 * Pull the agent's number out of the policy itself. Compared as DIGITS ONLY, so
 * a reformatting — `555-000-1234`, `(555) 000-1234`, `+1 555 000 1234` are all
 * one value once stripped — cannot smuggle a copy past a literal string match.
 *
 * ⚠️ The example above uses PLACEHOLDER digits deliberately. An earlier draft
 * illustrated this with the real number in three formats, and the guard flagged
 * its own file for the second time — after the verbatim quote had already been
 * elided for the same reason. DOCUMENTATION ABOUT A SENSITIVE VALUE TENDS TO
 * CONTAIN THE VALUE, and an explanation is the least suspected copy.
 */
function agentPhoneDigits(): string {
  const policy = readFileSync(join(REPO_ROOT, ALLOWED), "utf8");
  const line = policy.split("\n").find((l) => /^\s*Phone:/i.test(l));
  if (line === undefined) {
    throw new Error(`${ALLOWED} has no "Phone:" line — this guard has nothing to search for.`);
  }
  return line.replace(/\D/g, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    const dot = entry.name.lastIndexOf(".");
    if (dot !== -1 && TEXT_EXT.has(entry.name.slice(dot))) out.push(join(dir, entry.name));
  }
  return out;
}

const rel = (abs: string): string => abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");

describe("⚠️ the DMCA agent's phone number is published on the DMCA page only", () => {
  it("a real number is extractable from the policy — the non-vacuity control", () => {
    // Without this, a policy that lost its Phone: line, or gained a malformed
    // one, would leave the guard below searching for a short or empty string —
    // matching everything or nothing, and asserting neither.
    const digits = agentPhoneDigits();
    expect(
      digits.length,
      `Extracted "${digits}" from ${ALLOWED}'s Phone: line. A DMCA agent's number must be at least 10 digits; anything shorter means this guard is searching for something that is not a phone number.`,
    ).toBeGreaterThanOrEqual(10);
  });

  it("appears in NO other file in the repository", () => {
    const digits = agentPhoneDigits();
    const files = walk(REPO_ROOT);
    expect(files.length, "the walk found no files — the scan is broken, not the tree").toBeGreaterThan(50);

    const offenders = files
      .map(rel)
      .filter((r) => r !== ALLOWED)
      .filter((r) => {
        try {
          return readFileSync(join(REPO_ROOT, r), "utf8").replace(/\D/g, "").includes(digits);
        } catch {
          return false;
        }
      });

    expect(
      offenders,
      `The DMCA agent's personal phone number appears outside ${ALLOWED}:\n` +
        offenders.map((o) => `  • ${o}`).join("\n") +
        `\n\nThe founder authorised publishing it for DMCA notice-and-takedown ONLY, explicitly not as a general site contact number. If you need a contact number elsewhere, that is a DIFFERENT number and a different decision — not this one reused.`,
    ).toEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/**
 * Enumerate from the INDEX (`git ls-files`), never by walking the disk: a disk
 * walk is slow under parallel-suite load (it timed out at 5 s once) and sees
 * untracked directories (`apps/web/.astro/`, other worktrees) that no skip-list
 * can fully anticipate. `-z` keeps unusual file names intact.
 */
function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((f) => f !== "")
    .filter((f) => {
      const dot = f.lastIndexOf(".");
      return dot !== -1 && TEXT_EXT.has(f.slice(dot));
    });
}

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
    const files = trackedTextFiles();
    expect(files.length, "git ls-files found too few files — the scan is broken, not the tree").toBeGreaterThan(50);
    // Positive control: the one file that SHOULD carry the number is in the
    // enumerated list, so the scan demonstrably covers the tree it claims to.
    expect(files, `${ALLOWED} must be in the enumerated list`).toContain(ALLOWED);

    const offenders = files
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
    // Explicit headroom: a cold first run (spawning git, then reading every
    // tracked text file) was observed at ~17 s on this box, over the 5 s default.
  }, 60_000);
});

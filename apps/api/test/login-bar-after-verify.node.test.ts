import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ⚠️ TIMING-SENSITIVE STRUCTURAL GUARD — the `isBarred` check must sit in a
 * WINDOW, not just clear a floor: AFTER the password verify in the login
 * route, AND BEFORE the rehash-on-upgrade step. Two different failure modes,
 * one on each side of the window.
 *
 * The `isBarred(row)` guard rejects disabled and currently-suspended accounts.
 * Its LOWER bound is load-bearing for timing-attack defense: a barred account
 * that fails the password check MUST take the same time as a wrong-password
 * attempt (both run the full Argon2id verify). If the barring check comes
 * BEFORE the password verify, a barred account skips the expensive verify
 * entirely and answers measurably faster — a timing oracle leaking account
 * status to an attacker.
 *
 * Its UPPER bound is load-bearing for a different reason: `needsRehash`
 * writes a new `password_hash` to the row, and `createSession` writes a live
 * KV session — both real, observable side effects. If the barring check
 * moved below either one, a barred account would get its password hash
 * silently upgraded and/or a live session issued before the route ever
 * returned 401, i.e. exactly the re-entry issue #35 exists to close, just
 * moved one guard down.
 *
 * A runtime test cannot reliably measure the timing difference (flaky on
 * heavily-loaded CI, and the delay is context-dependent). A functional test
 * also cannot: every source order returns 401 with identical body on the
 * lower-bound question, so the route has no behavioral difference that a
 * status/response-assertion can detect there. (The upper-bound question is
 * even less amenable: the response is unchanged either way, and the write
 * side effects it guards against are consequences we want to PREVENT, not
 * outcomes a passing test can safely trigger to check for.)
 *
 * This STRUCTURAL GUARD enforces correct SOURCE order using TypeScript's AST,
 * which guarantees execution order (handleLogin is straight-line; no branches
 * change the statement sequence). The guard FAILS if:
 *   - The `!passwordOk` check is missing from handleLogin, or
 *   - The `isBarred(row)` call is missing, or
 *   - The `needsRehash` call is missing, or
 *   - The `isBarred` statement appears BEFORE the `!passwordOk` statement
 *     (lower bound), or
 *   - The `isBarred` statement appears AFTER (or at) the `needsRehash`
 *     statement (upper bound).
 *
 * Same default-deny treatment on both bounds: a missing anchor is a FAILURE
 * naming the anchor, never a silent pass.
 *
 * ⚠️ BLIND SPOT, stated explicitly: this guard binds SOURCE order, which equals
 * EXECUTION order only because handleLogin contains straight-line code. If
 * handleLogin ever gains conditional branches that can skip the password verify,
 * the assumption "source order = execution order" becomes false, and this guard
 * must be restated or replaced with an execution-path analysis. Watch for that.
 *
 * ⚠️ WHY A `.node.test.ts` (no DB): it reads this repo's source files. workerd's
 * filesystem is virtual, so a pool test cannot read them. This runs in the Node
 * project (vitest.config.ts) and touches NO database.
 *
 * Model: apps/api/test/hidden-at-read-guard.node.test.ts (structural SQL guard).
 */

const LOGIN_FILE = join(import.meta.dirname, "../src/routes/login.ts");

/**
 * Find the index of a statement in handleLogin's body that matches a predicate.
 * Returns the statement and its index, or null if not found.
 *
 * A statement matches if its full text (reconstructed from AST) contains the
 * search substring. Using AST (not regex on raw text) excludes comments.
 */
function findStatementInHandleLogin(
  source: string,
  predicate: (stmt: string) => boolean,
): { stmt: string; index: number } | null {
  const sf = ts.createSourceFile(LOGIN_FILE, source, ts.ScriptTarget.Latest, true);

  let result: { stmt: string; index: number } | null = null;

  // Walk the AST to find the `handleLogin` function declaration.
  const walk = (node: ts.Node): void => {
    if (result !== null) return;

    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "handleLogin" &&
      node.body
    ) {
      const statements = node.body.statements;
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        // Get the full text of the statement from the source.
        const start = stmt.getStart(sf);
        const end = stmt.getEnd();
        const stmtText = source.slice(start, end);
        if (predicate(stmtText)) {
          result = { stmt: stmtText, index: i };
          return;
        }
      }
      return;
    }
    ts.forEachChild(node, walk);
  };

  walk(sf);
  return result;
}

describe("⚠️ login route bars disabled/suspended accounts in a WINDOW: after password verify, before rehash", () => {
  const source = readFileSync(LOGIN_FILE, "utf8");

  it("handleLogin exists and contains statements", () => {
    // Non-vacuity tripwire: ensure we can actually find and examine handleLogin.
    // If this fails, the guard is not seeing the function.
    const findAny = findStatementInHandleLogin(source, () => true);
    expect(
      findAny,
      "control: cannot locate handleLogin function or it has no statements — " +
        "the guard is broken, not the code",
    ).not.toBeNull();
  });

  it("the `!passwordOk` password-verification statement exists", () => {
    // Non-vacuity: anchor must be found for the order comparison to be meaningful.
    const found = findStatementInHandleLogin(source, (s) => s.includes("!passwordOk"));
    expect(
      found,
      "control: no statement containing `!passwordOk` found in handleLogin — " +
        "login.ts may have been refactored without updating this guard. " +
        "Repoint it or update the anchor.",
    ).not.toBeNull();
  });

  it("the `isBarred(row)` barring-check statement exists", () => {
    // Non-vacuity: the guard itself must be present in the code.
    const found = findStatementInHandleLogin(source, (s) =>
      s.includes("isBarred(row)"),
    );
    expect(
      found,
      "control: no statement containing `isBarred(row)` found in handleLogin — " +
        "the barring guard may have been removed or refactored. " +
        "Repoint it or restore it.",
    ).not.toBeNull();
  });

  it(
    "the password-verification statement (step 5) comes BEFORE the barring check (step 6)",
    () => {
      const passwordCheck = findStatementInHandleLogin(source, (s) =>
        s.includes("!passwordOk"),
      );
      const barringCheck = findStatementInHandleLogin(source, (s) =>
        s.includes("isBarred(row)"),
      );

      expect(
        passwordCheck,
        "control: password-verify anchor not found",
      ).not.toBeNull();
      expect(barringCheck, "control: barring anchor not found").not.toBeNull();

      const passwordIdx = passwordCheck!.index;
      const barringIdx = barringCheck!.index;

      expect(
        passwordIdx < barringIdx,
        `⚠️ TIMING ORACLE: the isBarred check at statement ${barringIdx} comes ` +
          `BEFORE the password verify at statement ${passwordIdx}. A barred account ` +
          `would skip the expensive Argon2id verify and answer measurably faster than ` +
          `a wrong password, leaking account status via response timing. ` +
          `This is the account-enumeration vulnerability the barring check's own ` +
          `comment exists to prevent. Move the isBarred(row) guard to AFTER the ` +
          `!passwordOk return statement, so every authentication path (password verify ` +
          `succeeds, then barring check) takes the same time regardless of the outcome.`,
      ).toBe(true);
    },
  );

  it("the `needsRehash` rehash-on-upgrade statement exists", () => {
    // Non-vacuity: anchor must be found for the upper-bound comparison to be
    // meaningful. Default-deny: a missing anchor FAILS naming it, never a
    // silent pass.
    const found = findStatementInHandleLogin(source, (s) =>
      s.includes("needsRehash"),
    );
    expect(
      found,
      "control: no statement containing `needsRehash` found in handleLogin — " +
        "login.ts may have been refactored without updating this guard. " +
        "Repoint it or update the anchor.",
    ).not.toBeNull();
  });

  it(
    "the barring check (step 6) comes BEFORE the rehash-on-upgrade step (step 7) — the upper bound",
    () => {
      const barringCheck = findStatementInHandleLogin(source, (s) =>
        s.includes("isBarred(row)"),
      );
      const rehashCheck = findStatementInHandleLogin(source, (s) =>
        s.includes("needsRehash"),
      );

      expect(barringCheck, "control: barring anchor not found").not.toBeNull();
      expect(
        rehashCheck,
        "control: rehash-on-upgrade anchor not found",
      ).not.toBeNull();

      const barringIdx = barringCheck!.index;
      const rehashIdx = rehashCheck!.index;

      expect(
        barringIdx < rehashIdx,
        `⚠️ A BARRED ACCOUNT WOULD GET A REHASH WRITE (AND, FARTHER DOWN, A LIVE ` +
          `SESSION) BEFORE BEING REFUSED: the isBarred check at statement ` +
          `${barringIdx} comes AFTER (or at the same statement as) the ` +
          `needsRehash check at statement ${rehashIdx}. Moving the isBarred(row) ` +
          `guard below this point — even as far down as after createSession — ` +
          `would still pass the LOWER-bound test above while silently letting a ` +
          `barred account's password hash be upgraded and a KV session row be ` +
          `written before the route returns 401. Move the isBarred(row) guard back ` +
          `to BEFORE the needsRehash block.`,
      ).toBe(true);
    },
  );
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ⚠️ STRUCTURAL GUARD — every PUBLIC read of `posts`/`comments` filters
 * auto-hidden rows.
 *
 * The M4 report+block feature auto-hides a post/comment once it draws enough
 * distinct reporters (src/moderation/auto-hide.ts sets `hidden_at`). The
 * contract that keeps hidden content out of public view is: EVERY public read
 * that scans or joins `posts`/`comments` carries `<alias>.hidden_at IS NULL`.
 *
 * That contract was previously enforced only by ~20 per-endpoint tests — an
 * ENUMERATION that already missed a path once (`/public/search`) before review
 * caught it. The UNIVERSAL ("every public read filters hidden_at") was itself
 * unguarded: a NEW read added later that forgets the filter passes every
 * existing per-endpoint test, because no test knows to look at it.
 *
 * ⚠️ THIS GUARD IS DEFAULT-DENY, NOT A RE-ENUMERATION. It scans the source of
 * every `src/routes/*.ts`, extracts every SQL literal, and for each `FROM` /
 * `JOIN` / `USING` reference to `posts`/`comments` it REQUIRES a matching
 * `hidden_at IS NULL` predicate — UNLESS that exact query is on the ALLOWLIST
 * below with a written reason. A future read that forgets the filter FAILS this
 * test until its author either adds the filter or consciously allowlists it
 * (and justifies why). Auditing a hand-list against itself always returns
 * "complete"; this scans the code and forces a justification for every miss.
 *
 * ⚠️ WHY A `.node.test.ts` (no DB): it reads this repo's own source files.
 * workerd's filesystem is virtual (`/bundle`), so a pool test cannot read them
 * — see test/hyperdrive-binding-inventory.node.test.ts's header. This runs in
 * the Node project (vitest.config.ts) and touches NO database.
 *
 * SCOPE: every `.ts` file under `apps/api/src/routes`, RECURSIVELY. SQL
 * that lives outside routes — the notification email-drain joins
 * (src/notifications/), block/auto-hide helpers (src/moderation/), background
 * jobs (src/jobs/) — is not scanned here. The notification LIST join DOES live
 * in routes (notifications.ts) and is handled explicitly below.
 */

const ROUTES_DIR = join(import.meta.dirname, "../src/routes");

/**
 * The write side and the author/participant-scoped reads that LEGITIMATELY do
 * not filter `hidden_at`. Each entry names the file, a distinctive substring of
 * the exact query it exempts (whitespace-normalized), and WHY. If you cannot
 * articulate why a read may skip the filter, it is a BUG — flag it, do not add
 * it here.
 *
 * Every entry MUST match at least one currently-unfiltered query (asserted
 * below): a stale entry — one whose query gained the filter or was deleted —
 * fails the test, so this list cannot rot into a permanent blanket exemption.
 *
 * NOTE on what is NOT here: `INSERT INTO posts/comments`, `UPDATE posts/comments
 * SET ...`, and `DELETE FROM posts/comments` are write TARGETS, not read
 * (FROM/JOIN/USING) references, so the scanner never flags them and they need
 * no entry. The entries below are the write-path JOINS and the author-scoped
 * reads that the scanner DOES see.
 */
interface AllowEntry {
  readonly file: string;
  /** A distinctive substring of the exempt query (whitespace is normalized before matching). */
  readonly match: string;
  readonly why: string;
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "posts.ts",
    match: "FROM posts p WHERE p.id = $1 AND p.author_id = $2",
    why:
      "handleGetPost — the AUTHOR's own post, drafts and hidden state INCLUDED. " +
      "Scoped to p.author_id = session.userId (the authoring editor's read, no-store, " +
      "never edge-cached). The author must see their own post regardless of published/ " +
      "hidden status; this is not a public read.",
  },
  {
    file: "comments.ts",
    match: "SELECT 1 FROM comments WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL",
    why:
      "handleUpdateComment no-op probe. Runs ONLY on the 0-row UPDATE path, scoped to " +
      "author_id = $2 (the caller's OWN comment), to tell a 200 no-op resubmit from a 404. " +
      "Author-scoped, not a public read; hidden_at governs public visibility, not an author " +
      "touching their own row.",
  },
  {
    file: "comments.ts",
    match: "SET deleted_at = now(), body_markdown = ''",
    why:
      "handleDeleteComment tombstone WRITE (UPDATE comments c ... FROM posts p). `posts p` is " +
      "joined only for the ownership predicate (comment author OR post author may delete) and " +
      "is not returned. A write, not a public read — and a delete must succeed even on an " +
      "already-hidden comment or post.",
  },
  {
    file: "comments.ts",
    match: "(c.author_id = $2 OR p.author_id = $2) AS mine",
    why:
      "handleDeleteComment idempotency probe. Runs ONLY on the 0-row delete path to tell " +
      "'already tombstoned and you could have deleted it' (200) from 'not found' (404), scoped " +
      "to (c.author_id = $2 OR p.author_id = $2). Deliberately matches a tombstoned row " +
      "(c.deleted_at IS NOT NULL); an author/post-owner probe restricted to the caller, so it " +
      "must resolve on hidden content too — not a public read.",
  },
  {
    file: "reactions.ts",
    match: "DELETE FROM reactions r USING comments c",
    why:
      "handleRemoveReaction — a DELETE (write). `USING comments c` resolves c.post_id only for " +
      "the live-channel push. A user must ALWAYS be able to retract a reaction, even from a " +
      "since-tombstoned or auto-hidden comment (file header); filtering hidden_at here would " +
      "strand reactions on hidden comments.",
  },
  {
    file: "notifications.ts",
    match: "LEFT JOIN posts p ON p.id = n.post_id",
    why:
      "handleListNotifications. Recipient-scoped (n.recipient_id = $1). The LEFT JOIN only " +
      "decorates the recipient's OWN notifications with post title/slug — author/participant- " +
      "facing, not a public content read. Surfacing hidden-state in the recipient's own " +
      "notification list is deferred by design (M4), and a filter on a LEFT JOIN would drop " +
      "the whole notification row, losing the notification itself.",
  },
];

/**
 * SQL keywords that can appear where an alias would, so a bare `FROM posts WHERE`
 * is not misread as "table posts aliased WHERE".
 */
const SQL_KEYWORDS: ReadonlySet<string> = new Set([
  "WHERE", "ON", "AND", "OR", "GROUP", "ORDER", "LIMIT", "OFFSET", "JOIN", "LEFT",
  "RIGHT", "INNER", "OUTER", "CROSS", "FULL", "USING", "SET", "VALUES", "RETURNING",
  "HAVING", "UNION", "FOR", "AS", "SELECT", "FROM", "INTO", "NATURAL", "LATERAL", "WITH",
]);

/**
 * Reconstruct a string/template literal's TEXT from the AST. Template
 * interpolations (`${...}`) become a ` __EXPR__ ` placeholder — the SQL keywords
 * and predicates we test for live in the literal spans, never inside an
 * interpolation. Using the AST (not a regex over raw source) means comments are
 * excluded for free and SQL's own single-quotes never confuse delimiter parsing.
 */
function literalText(node: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += " __EXPR__ " + span.literal.text;
    return out;
  }
  return null;
}

function extractLiterals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const walk = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null) out.push(text);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

/**
 * Strip SQL comments BEFORE whitespace normalization — ORDER IS LOAD-BEARING.
 * A `--` comment runs to end of line, so it can only be removed while the
 * newlines still exist; once `norm()` has collapsed them, a `--` would appear
 * mid-line and its true extent is unrecoverable. Removing both comment forms
 * closes the "hide the table reference behind a comment" evasion that the
 * `readRefs` scan would otherwise miss.
 */
const stripSqlComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const norm = (s: string): string => stripSqlComments(s).replace(/\s+/g, " ").trim();

/** A `FROM`/`JOIN`/`USING` reference to posts/comments, with its table alias. */
interface TableRef {
  readonly keyword: "FROM" | "JOIN" | "USING";
  readonly table: "posts" | "comments";
  readonly alias: string | null;
}

/**
 * Every posts/comments reference in a READ position within one normalized query.
 * `DELETE FROM posts/comments` is a write TARGET, not a read, and is excluded.
 * `INSERT INTO` / `UPDATE <table>` never reach here — their keywords are not in
 * the alternation — so writes to the target table are silently (correctly) skipped.
 */
function readRefs(normalized: string): TableRef[] {
  // ⚠️ `(?:ONLY\s+)?` and `\(?\s*` close two documented evasions: `FROM ONLY
  // posts` and `FROM (posts)` are both READ references that slipped past the
  // original alternation. Capture-group numbers are unchanged (all the added
  // groups are non-capturing), so the destructuring below still holds.
  const re =
    /(?:\b([A-Za-z_]+)\s+)?\b(FROM|JOIN|USING)\s+(?:ONLY\s+)?\(?\s*(posts|comments)\b(?:\s*\)\s*)?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  const refs: TableRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const prev = (m[1] ?? "").toUpperCase();
    const keyword = m[2]!.toUpperCase() as TableRef["keyword"];
    const table = m[3]!.toLowerCase() as TableRef["table"];
    let alias: string | null = m[4] ?? null;
    if (alias !== null && SQL_KEYWORDS.has(alias.toUpperCase())) alias = null;
    // `DELETE FROM <table>` is the delete target — a write, not a read.
    if (keyword === "FROM" && prev === "DELETE") continue;
    refs.push({ keyword, table, alias });
  }
  return refs;
}

/**
 * Does `normalized` carry a `hidden_at IS NULL` predicate that applies to `ref`?
 * Accepts `<alias>.hidden_at IS NULL`, `<table>.hidden_at IS NULL`, or a BARE
 * `hidden_at IS NULL` — but the bare form only when this query references a
 * single hidden_at-bearing table (both posts and comments carry hidden_at, so a
 * bare reference across both would be an ambiguous-column error in Postgres
 * anyway; such queries must qualify).
 */
function filterSatisfied(normalized: string, ref: TableRef, singleHiddenTable: boolean): boolean {
  // ⚠️ `includes()` on lowercased text, NOT a RegExp built from a variable.
  // `normalized` has already had every whitespace run collapsed to ONE space,
  // so the old `\s+` could only ever match a single space — the string check is
  // EQUIVALENT here, and it removes the non-literal-RegExp (ReDoS) surface
  // entirely rather than arguing the input happens to be trusted.
  const lower = normalized.toLowerCase();
  if (ref.alias !== null && lower.includes(`${ref.alias.toLowerCase()}.hidden_at is null`)) {
    return true;
  }
  if (lower.includes(`${ref.table}.hidden_at is null`)) {
    return true;
  }
  if (singleHiddenTable && /(?<![.\w])hidden_at\s+IS\s+NULL/i.test(normalized)) {
    return true;
  }
  return false;
}

function allowEntryFor(file: string, normalized: string): AllowEntry | null {
  for (const entry of ALLOWLIST) {
    if (entry.file === file && normalized.includes(norm(entry.match))) return entry;
  }
  return null;
}

interface Violation {
  readonly file: string;
  readonly ref: TableRef;
  readonly query: string;
}

interface ScanResult {
  readonly files: string[];
  readonly violations: Violation[];
  /** Read refs that DO carry the filter — the positive control. */
  readonly filteredReadCount: number;
  /** Which allowlist entries actually matched a query. */
  readonly usedEntries: Set<AllowEntry>;
}

function scan(): ScanResult {
  // ⚠️ RECURSIVE, DELIBERATELY. A non-recursive scan registers a route in a
  // subdirectory as an ABSENCE rather than a failure — and for this guard an
  // absence is INDISTINGUISHABLE FROM COMPLIANCE, so the blind spot would read
  // as a pass forever. `routes/` is flat today (measured: every entry a file,
  // zero directories), which makes this a LATENT hazard closed before it lands
  // rather than a live gap — the first route added in a subfolder is now
  // covered instead of silently unguarded.
  const files = readdirSync(ROUTES_DIR, { recursive: true })
    .map((f) => String(f))
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const violations: Violation[] = [];
  const usedEntries = new Set<AllowEntry>();
  let filteredReadCount = 0;

  for (const file of files) {
    const source = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const literal of extractLiterals(source, file)) {
      const normalized = norm(literal);
      const refs = readRefs(normalized);
      if (refs.length === 0) continue;

      const singleHiddenTable = new Set(refs.map((r) => r.table)).size === 1;
      const unfiltered = refs.filter((r) => !filterSatisfied(normalized, r, singleHiddenTable));
      filteredReadCount += refs.length - unfiltered.length;
      if (unfiltered.length === 0) continue;

      const entry = allowEntryFor(file, normalized);
      if (entry !== null) {
        usedEntries.add(entry);
        continue; // a consciously-justified exception — the whole query is exempt
      }
      for (const ref of unfiltered) violations.push({ file, ref, query: normalized });
    }
  }
  return { files, violations, filteredReadCount, usedEntries };
}

const RESULT = scan();

describe("⚠️ every public posts/comments read filters hidden_at (structural, default-deny)", () => {
  it("actually scanned the route source (tripwire — a moved src/routes would pass vacuously)", () => {
    expect(RESULT.files.length).toBeGreaterThan(5);
  });

  it("the scanner can SEE the filter when present (positive control, not a vacuous pass)", () => {
    // If this ever drops to ~0 the detector has stopped matching real queries —
    // an all-green run would then mean nothing. There are ~18 filtered public
    // reads across the routes today.
    expect(RESULT.filteredReadCount).toBeGreaterThanOrEqual(10);
  });

  it("no posts/comments READ skips `hidden_at IS NULL` without a justified allowlist entry", () => {
    const report = RESULT.violations
      .map(
        (v) =>
          `  • ${v.file}: ${v.ref.keyword} ${v.ref.table}` +
          `${v.ref.alias ? ` ${v.ref.alias}` : ""} has no ${v.ref.alias ?? v.ref.table}.hidden_at IS NULL\n` +
          `      ${v.query.slice(0, 200)}`,
      )
      .join("\n");
    expect(
      RESULT.violations,
      RESULT.violations.length === 0
        ? ""
        : `A public read of posts/comments is missing its hidden_at IS NULL filter, so ` +
          `auto-hidden (reported) content would leak into public results. Either add ` +
          `\`AND <alias>.hidden_at IS NULL\` to the query, or — if this read legitimately ` +
          `must see hidden rows (an author reading their OWN content, a write-path join, a ` +
          `participant-scoped read) — add an ALLOWLIST entry in this file with a written ` +
          `reason. Do NOT allowlist a genuine public read.\n\n${report}`,
    ).toEqual([]);
  });

  it("every allowlist entry still matches a real unfiltered query (no stale exemptions)", () => {
    const stale = ALLOWLIST.filter((e) => !RESULT.usedEntries.has(e));
    expect(
      stale,
      `These allowlist entries matched NO current query — the query gained its hidden_at ` +
        `filter, was renamed, or was deleted. Remove the stale entry so the allowlist cannot ` +
        `become a permanent blanket exemption:\n` +
        stale.map((e) => `  • ${e.file}: "${e.match}"`).join("\n"),
    ).toEqual([]);
  });
});

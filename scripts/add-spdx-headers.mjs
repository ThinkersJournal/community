// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Adds `SPDX-License-Identifier: MIT OR Apache-2.0` to the top of every tracked source file that lacks one in its
// first 15 lines (the window the CodeRipper `licence` rule reads; LICENSE.md section 1 names the expression).
//
//   node scripts/add-spdx-headers.mjs           add the missing headers
//   node scripts/add-spdx-headers.mjs --check   list files that lack one; exit 1 if any (changes nothing)
//
// Enumeration is `git ls-files`, never a disk walk, so another worktree's files are never seen. Idempotent. A file's own line
// endings are kept, and a shebang stays on line 1 with the header directly under it.
//
// Not touched, by design:
//  - the two wrangler-generated `worker-configuration.d.ts` files: LICENSE.md section 1 says they are Apache-2.0 only and not ours
//    to relicense, and `wrangler types` rewrites them, so a header would vanish on the next run;
//  - a file that already names a copyright holder in its first 15 lines (a third-party file keeps its own notice).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const EXPRESSION = "MIT OR Apache-2.0";
const WINDOW = 15;
const SLASH = new Set(["ts", "tsx", "js", "mjs", "cjs", "jsx"]);
const HASH = new Set(["py", "sh"]);
const NEVER = new Set(["apps/api/src/worker-configuration.d.ts", "apps/web/worker-configuration.d.ts"]);

const check = process.argv.includes("--check");
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);

const missing = [];
for (const path of files) {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  const comment = SLASH.has(ext) ? "//" : HASH.has(ext) ? "#" : null;
  if (comment === null || NEVER.has(path)) continue;
  const text = readFileSync(path, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const top = lines.slice(0, WINDOW).join("\n");
  if (/SPDX-License-Identifier:/.test(top) || /copyright\s*(\(c\)|©)/i.test(top)) continue;
  missing.push(path);
  if (check) continue;
  const at = lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(at, 0, `${comment} SPDX-License-Identifier: ${EXPRESSION}`);
  writeFileSync(path, lines.join(eol));
}

console.log(`${check ? "missing" : "added"} ${missing.length} of ${files.length} tracked files considered`);
if (check) {
  for (const path of missing) console.log(path);
  process.exit(missing.length === 0 ? 0 : 1);
}

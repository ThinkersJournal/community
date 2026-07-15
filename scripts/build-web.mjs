/**
 * Build the `web` Worker, and CLEAN UP AFTER THE BUILD. This is `apps/web`'s
 * `build` script — always go through it, never call `astro build` directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — a real, reproducible, two-bug interaction. Not superstition.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plain `astro build` succeeds exactly ONCE on a clean checkout and then fails
 * on EVERY later run, on Windows, with a message that names neither the cause
 * nor even the real file:
 *
 *     The property 'options.recursive' is no longer supported. Received true
 *       at Object.rmdirSync (node:fs)
 *       at emptyDir (astro/dist/core/fs/index.js:34)
 *
 * Two independent upstream defects compound to produce it:
 *
 *   1. `astro build` (via @astrojs/cloudflare -> @cloudflare/vite-plugin) spawns
 *      workerd child processes and NEVER REAPS THEM. They outlive the build,
 *      end up orphaned, and keep open handles on `apps/web/dist`. Measured: a
 *      clean build leaves 4 behind.
 *   2. Astro's `emptyDir` therefore gets EPERM from `fs.rmSync` on the locked
 *      directory, and its Windows EPERM fallback calls
 *      `fs.rmdirSync(p, { recursive: true })` — which Node 26 REMOVED. The
 *      fallback throws a *different* error, masking the EPERM that caused it.
 *
 * Reproduced deterministically (astro@7.0.9, node v26.5.0, Windows 11):
 *     rm -rf dist; astro build   -> OK,   leaves 4 workerd alive
 *     astro build (immediately)  -> FAILS with the message above
 *
 * Neither half is ours to fix: astro@7.0.9 is the latest release, and
 * @cloudflare/vite-plugin is pinned to 1.44.0 by wrangler's peer range (see
 * task-18-report.md §1 — bumping it splits the repo across two wrangler
 * versions, which one dev server cannot tolerate).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES — fix the LEAK, rather than mop up after it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. Remove `apps/web/dist` (astro's own emptyDir is disabled via
 *      `vite.build.emptyOutDir: false` in astro.config.mjs, precisely so its
 *      broken code path is never reached; THIS is what cleans the output).
 *   2. Snapshot which workerd processes are already running.
 *   3. Run `astro build`.
 *   4. Kill only the workerd processes that appeared DURING step 3.
 *
 * ⚠️ STEP 4 IS SCOPED BY DIFF, AND THAT PRECISION IS THE WHOLE POINT. An earlier
 * version of this script killed every workerd under this repo before building.
 * That silently killed the `api` dev server that playwright.config.ts had
 * started moments earlier on :8788 — the E2E then failed with a baffling
 * `ECONNREFUSED 127.0.0.1:8788` several steps later. Only processes that did not
 * exist before our build can possibly be ours, so only those may be killed.
 * NEVER widen this to "all workerd" or "all workerd in this repo".
 *
 * Because the leak is now cleaned up by the build that caused it, the steady
 * state has zero strays and step 1 always succeeds. If step 1 ever fails, it is
 * a genuine, human-actionable situation (a dev server holding dist, or a leak
 * from a build that was killed mid-flight) and it is reported as such.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const webDir = path.join(repoRoot, "apps", "web");
const distDir = path.join(webDir, "dist");

/** Block synchronously for `ms` without burning CPU. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * PIDs of workerd processes whose EXECUTABLE lives under this repo.
 *
 * Scoped by executable path so an unrelated Cloudflare project's workerd can
 * never enter the diff in the first place.
 *
 * ⚠️ THE TRAILING SEPARATOR IS THE WHOLE GUARANTEE. A bare
 * `startsWith(repoRoot)` is a STRING prefix test, not a PATH-containment test,
 * so it also matches any SIBLING checkout whose name merely starts with ours —
 * `…\ThinkersJournal-Community-Backup\node_modules\…\workerd.exe` begins with
 * `…\ThinkersJournal-Community`. That would let another project's workerd into
 * the diff and, if it happened to start during our build, get SIGKILLed —
 * exactly what the header promises can never happen. Appending `path.sep`
 * forces the match to land on a directory boundary, which is what "under this
 * repo" actually means.
 */
const repoRootPrefix = repoRoot + path.sep;

function repoWorkerdPids() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='workerd.exe'\" | " +
            "Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (out === "") return new Set();

      // ConvertTo-Json emits a bare object for one match, an array for several.
      const parsed = JSON.parse(out);
      const procs = Array.isArray(parsed) ? parsed : [parsed];
      return new Set(
        procs
          .filter(
            (p) =>
              typeof p.ExecutablePath === "string" &&
              p.ExecutablePath.toLowerCase().startsWith(
                repoRootPrefix.toLowerCase(),
              ),
          )
          .map((p) => p.ProcessId),
      );
    }

    const out = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      const [, pid, args] = match;
      // Same boundary reasoning as the win32 branch: `repoRootPrefix`, not
      // `repoRoot`, so a sibling checkout sharing our name as a prefix cannot
      // match. (A substring test is the best available here — the repo path can
      // appear anywhere in the command line, not just at its start.)
      if (args.includes("workerd") && args.includes(repoRootPrefix)) {
        pids.add(Number(pid));
      }
    }
    return pids;
  } catch {
    // Enumeration is best-effort: a failure here must not fail the build. The
    // worst case is that we do not reap, i.e. today's upstream behavior.
    return new Set();
  }
}

// ---- 1. Clean the output directory -----------------------------------------
if (fs.existsSync(distDir)) {
  // ⚠️ TWO conditions, and the second is the subtle one. Windows closes handles
  // asynchronously, so rm can return EPERM briefly; but a SUCCESSFUL rm is also
  // not proof, because a directory with open handles is merely marked
  // "delete-pending" — rm reports success while the entry SURVIVES until the
  // last handle closes. Observed exactly that: rm succeeded, then existsSync
  // stayed true with entries ["server"] for a further second. So success is
  // "the directory is gone", never "rm did not throw".
  const deadline = Date.now() + 10_000;
  let lastError = null;

  for (;;) {
    try {
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      lastError = err;
    }
    if (!fs.existsSync(distDir)) break;

    if (Date.now() >= deadline) {
      const detail =
        lastError === null
          ? "rm reported success but the directory survives — Windows delete-pending: a handle is still open"
          : `${lastError.code}: ${lastError.message}`;
      console.error(
        `[build-web] could not remove ${distDir}\n` +
          `  ${detail}\n` +
          `  Something holds a handle on it. Almost certainly a 'wrangler dev'\n` +
          `  serving apps/web/dist/server/wrangler.json, or a workerd leaked by a\n` +
          `  build that was interrupted. Stop the dev server (or kill the stray\n` +
          `  workerd) and re-run.\n` +
          `  (Left to astro, this surfaces as the misleading "options.recursive\n` +
          `  is no longer supported".)`,
      );
      process.exit(1);
    }
    sleepSync(200);
  }
}

// ---- 2. Snapshot pre-existing workerd ---------------------------------------
// Anything in here is someone else's (a running api/web dev server) and is
// therefore off-limits in step 4.
const preExisting = repoWorkerdPids();

// ---- 3. Build ----------------------------------------------------------------
const build = spawnSync("astro", ["build"], {
  cwd: webDir,
  stdio: "inherit",
  shell: true, // resolve the `astro` bin via node_modules/.bin on all platforms
});

// ---- 4. Reap ONLY what our build spawned ------------------------------------
// Runs even when the build fails: a failed build leaks just the same, and
// leaving strays behind would break the NEXT build's step 1.
let reaped = 0;
for (const pid of repoWorkerdPids()) {
  if (preExisting.has(pid)) continue; // not ours — never touch it.
  try {
    process.kill(pid, "SIGKILL");
    reaped++;
  } catch {
    // Already exited on its own: the outcome we wanted.
  }
}
if (reaped > 0) {
  console.log(
    `[build-web] reaped ${reaped} workerd process(es) leaked by astro build ` +
      `(see this script's header)`,
  );
}

process.exit(build.status ?? 1);

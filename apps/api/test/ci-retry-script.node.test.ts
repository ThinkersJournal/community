// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/ci-retry.sh: retries a flaky install step, bounds each attempt, and reports the
 * last status. Needs bash and coreutils `timeout` (ubuntu-latest has them; skipped locally
 * without them, failing in CI if missing). The commands are tiny shell snippets, and no
 * server is involved, so spawnSync cannot deadlock here.
 */

const SCRIPT = join(import.meta.dirname, "../../../scripts/ci-retry.sh");
const HAVE_TOOLS = ["bash", "timeout"].every((t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0);
const CI = process.env.CI === "true";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function counterDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ci-retry-"));
  dirs.push(d);
  writeFileSync(join(d, "n"), "0");
  return d;
}

/** A command that fails until its `succeedOn`-th run (0 = never), counting runs in a file. */
function flaky(dir: string, succeedOn: number): string[] {
  const body = `n=$(( $(cat '${dir}/n') + 1 )); echo $n > '${dir}/n'; [ ${succeedOn} -ne 0 ] && [ $n -ge ${succeedOn} ]`;
  return ["bash", "-c", body];
}

const run = (attempts: number, seconds: number, cmd: string[]) =>
  spawnSync("bash", [SCRIPT, String(attempts), String(seconds), ...cmd], { encoding: "utf8" });

describe.skipIf(!HAVE_TOOLS && !CI)("scripts/ci-retry.sh", () => {
  it("succeeds at once without retrying when the command works", () => {
    const d = counterDir();
    const r = run(3, 10, flaky(d, 1));
    expect(r.status).toBe(0);
    expect(readFileSync(join(d, "n"), "utf8").trim()).toBe("1");
  });

  it("retries a failing command and succeeds on a later attempt", () => {
    const d = counterDir();
    const r = run(3, 10, flaky(d, 3));
    expect(r.status).toBe(0);
    expect(readFileSync(join(d, "n"), "utf8").trim()).toBe("3");
    expect(r.stderr).toContain("attempt 1 of 3 failed");
  });

  it("gives up after the given attempts and exits non-zero (control: the same command never succeeds)", () => {
    const d = counterDir();
    const r = run(2, 10, flaky(d, 0));
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(d, "n"), "utf8").trim()).toBe("2");
  });

  it("bounds each attempt: a hung command is killed (124) and retried", () => {
    const r = run(2, 1, ["bash", "-c", "sleep 30"]);
    expect(r.status).toBe(124);
    expect(r.stderr).toContain("attempt 2 of 2 failed");
  });
});

// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * scripts/verify-host.sh (S18 a) is for CireSnave to run as root on the production VPS.
 * Its one promise is that it only READS. `.node.test.ts` because it reads a real file.
 * The text checks run everywhere; the syntax check needs bash.
 */

const PATH = join(import.meta.dirname, "../../../scripts/verify-host.sh");
const text = readFileSync(PATH, "utf8");

/** Executable lines: not comments, not `note "..."` prose (which mentions commands it does NOT run). */
const code = text
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l) && !/^\s*note\s/.test(l));

describe("scripts/verify-host.sh", () => {
  it("has the 13 sections of the design's host checklist, in order", () => {
    const headings = [...text.matchAll(/^section "(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(headings).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("only reads: no command that starts, stops, writes, deletes, signals or installs", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["systemctl state change", /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|kill|set-property)\b/],
      ["kill", /\b(kill|pkill|killall)\s/],
      ["rm", /\brm\s/],
      ["sysctl write", /\bsysctl\s+(-w|[a-z_.]+=)/],
      ["firewall change", /\b(ufw\s+(enable|disable|allow|deny|delete|reset)|iptables\s+-[AIDFPX]|nft\s+(add|delete|flush))/],
      ["chmod/chown", /\b(chmod|chown)\s/],
      ["package change", /\b(apt|apt-get|dpkg)\s+(install|remove|purge|upgrade|dist-upgrade)\b/],
      ["write redirect to a path", /(^|[^>&0-9])>{1,2}\s*\/(?!dev\/null)/],
      ["tee to a file", /\btee\s+(?!-a\s*$)\S+/],
      ["mkdir/touch/mv/cp", /\b(mkdir|touch|mv|cp)\s/],
    ];
    for (const [name, re] of forbidden) {
      const hit = code.find((l) => re.test(l));
      expect(hit, `a "${name}" command in: ${hit}`).toBeUndefined();
    }
  });

  it("never prints the contents of a secret file", () => {
    expect(code.find((l) => /\bcat\s+[^|]*(tj-decoder|\.cloudflared|credentials|\.pem|\.key)/.test(l))).toBeUndefined();
  });

  it("is valid bash", () => {
    const r = spawnSync("bash", ["-n", PATH], { encoding: "utf8" });
    if (r.error !== undefined) return; // no bash on this machine; CI has it
    expect(r.status, r.stderr).toBe(0);
  });
});

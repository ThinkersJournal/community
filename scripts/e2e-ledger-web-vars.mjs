// SPDX-License-Identifier: MIT OR Apache-2.0
// Writes the dummy PURGE_SECRET for the AUXILIARY web Worker of the single-process
// `ledger` e2e project (#156), as `<web build>/server/.dev.vars`.
//
// WHY A FILE: in `wrangler dev -c A -c B` only the PRIMARY config receives the CLI
// flags (`--var`, `--env-file`, `--persist-to`); wrangler 4.146.0 passes an
// auxiliary config just `{env, disableDevRegistry, multiworkerPrimary}` (startDev
// in wrangler-dist/cli.js). An auxiliary worker still loads `.dev.vars` from the
// directory of ITS config file, so that is the one channel. dist/ is gitignored
// build output; the value is the same public dummy playwright.config.ts passes
// to both Workers as `--var`. Never put anything real here.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const secret = process.argv[2];
if (!secret || /[\r\n"]/.test(secret)) {
  console.error("usage: node scripts/e2e-ledger-web-vars.mjs <dummy-purge-secret>");
  process.exit(1);
}
const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "apps", "web", "dist", "server");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, ".dev.vars"), `PURGE_SECRET="${secret}"\n`, "utf8");
console.log(`wrote ${join(dir, ".dev.vars")} (PURGE_SECRET only)`);

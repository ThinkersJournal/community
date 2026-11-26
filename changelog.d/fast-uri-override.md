kind: pin transitive fast-uri to 3.1.9
---
Adds a pnpm override `fast-uri: ^3.1.9` in `package.json` so the transitive copy pulled by ajv@8 moves from 3.1.8 to the fixed 3.1.9 (stays on the 3.x line; unconstrained resolution jumped to 4.2.4). `pnpm-lock.yaml` regenerated with `pnpm install --lockfile-only`; no runtime code change.

`scripts/add-spdx-headers.mjs`: reworded line 3 so the first 15 lines hold one SPDX identifier (line 1, MIT OR Apache-2.0); the prose mention was parsed by the licence rule as a foreign licence. Comment-only.

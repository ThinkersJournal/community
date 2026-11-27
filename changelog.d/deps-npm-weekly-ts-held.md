kind: deps: wrangler 4.167.0 and @cloudflare/vitest-plugin 1.9.1, TypeScript held at 6.0.3
---
Took the wrangler (4.165.0 to 4.167.0, `apps/api/package.json` and `apps/web/package.json`) and `@cloudflare/vitest-plugin` (1.8.5 to 1.9.1, `apps/api/package.json`) bumps from the npm-weekly group. TypeScript 7.0.2 is not taken: `astro check` in `apps/web` exits "does not currently support TypeScript 7.0" (job 140232930491 on #334), the documented hold in `docs/ROADMAP.md` section 4. `pnpm-lock.yaml` regenerated with no `typescript@7` entry.

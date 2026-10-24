# Changelog

All five workspace packages carry one version number. The log starts at 0.1.68; earlier history is in `git log`
(subjects name the PR). Pre-1.0, a breaking change moves the second number.

## 0.1.83

Author decision notices now state the legal and contractual grounds a moderator cited (adverse decisions only; a restore never shows them), and ROADMAP section 3 lists rows R1-R7.

## 0.1.82

Raised @astrojs/check 0.9.10 to 0.9.12 and repinned the CodeRipper `portfolio.yml` workflow to 0.9.24 (ee9c3950). TypeScript stays on 6.0.3: @astrojs/check 0.9.12 still peers `typescript ^5 || ^6`.

## 0.1.81

Refreshed HANDOFF to the post-dependency-upgrade state.

## 0.1.80

Raised vitest 4.1.11 to 5.0.5 and moved `@cloudflare/vitest-pool-workers` 0.22.0 (renamed upstream, 0.23.0 is its last release and caps vitest at ^4) to its successor `@cloudflare/vitest-plugin` 1.4.7. TypeScript stays on 6.0.3: `astro check` refuses TypeScript 7.

## 0.1.79

Raised zod to ^4.6.7 (supersedes the dependabot PR #222).

## 0.1.78

Raised astro 7.3.5 to 7.4.2 and @astrojs/cloudflare 14.3.3 to 14.4.2 (build, typecheck and the web suite pass; the no-store guard in `workers-cache.test.ts` still finds the adapter stamp).

## 0.1.77

Waived the two wrangler-generated `worker-configuration.d.ts` files from the CodeRipper `licence` rule in `.coderipper.toml`.

## 0.1.76

Added `SPDX-License-Identifier: MIT OR Apache-2.0` headers to 643 source files with `scripts/add-spdx-headers.mjs` (`--check` lists what is missing) (#224).

## 0.1.75

Added `CHANGELOG.md` (CodeRipper `version-and-changelog` rule, ROADMAP section 3).

## 0.1.74

Waived three test-fixture SEC-002 hits in `.coderipper.toml` and repinned the CodeRipper portfolio caller to 0.9.14 (#225).

## 0.1.70

Added the advisory CodeRipper `portfolio` CI job (not a required check) and the ROADMAP rows its findings produced (#221).

## 0.1.69

Refreshed the shared-crate fit note (#220).

## 0.1.68

Refreshed ROADMAP section 3 and HANDOFF (#219).

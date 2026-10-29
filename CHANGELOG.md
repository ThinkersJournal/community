# Changelog

All five workspace packages carry one version number. The log starts at 0.1.68; earlier history is in `git log`
(subjects name the PR). Pre-1.0, a breaking change moves the second number.

## 0.1.120

HANDOFF.md refreshed to current state (S12 merged, S4 closed). Docs only; the version number is a placeholder, the PM allocates it.

## 0.1.119

The auto-hide notice to the author goes through the notice outbox (ROADMAP S12): `maybeAutoHide` queues an `author_auto_hide` row in the hide's own transaction, so a hide that cannot be announced rolls back, the drain delivers it with retries, and the report route no longer sends mail. Same copy, no appeal link. No migration (the kind is already in the 0034 CHECK). The version number is a placeholder; the PM allocates it.

## 0.1.87

The appeal page states the legal and contractual grounds the decision cited (ROADMAP R7), so it matches the author notice: `AppealTarget` carries the optional grounds and `appeal.astro` renders them. No migration.

## 0.1.86

Docs matched to the code (the rest of ROADMAP S29): README status line and stale baseline, dated update notes on the design spec, queue design, deploy-automation design, CSAM design, SafeImage split, guidelines-intentions and outbox design, `legal/README.md`, `deploy.md` order constraint, and superseded banners on the 10-14 outbox design and the NCMEC notes. Original text is kept; no published wording changed.

## 0.1.85

Docs matched to the code: the privacy policy now describes the device cookie and known-browser list; the Community Guidelines (version 2026-10-25) say the 30-day appeal window starts when the decision email is delivered; the glossary and `pre-launch-fixes.md` no longer call the appeal form and login challenge unbuilt.

## 0.1.84

Spec-to-roadmap audit: ROADMAP section 7 lists the work found in the docs and not on the roadmap (S1-S29), and section 2 drops the rows that have since merged. Docs only.

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

kind: CI: CHANGELOG fragments and a version stamp script
---
The gate stamps the version and the CHANGELOG entry from one fragment per PR, so parallel and stacked PRs stop conflicting on the five package.json version lines. The scripts are the portfolio kit (v3) plus an npm branch: `tools/stamp-version.py`, `tools/check-fragment.py`, `tools/stamp-current.txt` (names `package.json`), `.github/workflows/changelog-fragment.yml` and `changelog.d/README.md`. Checked with a real stamp run on this repo and on a fixture with a `package-lock.json` (only the two top-level version keys change).

Gap in this file: it has no entries for 0.1.130 to 0.1.134 (the per-PR entries were not written then; `git log` subjects name each PR). Nothing is backfilled here.

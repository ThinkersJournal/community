kind: CI: CHANGELOG fragments and a version stamp script
---
The gate stamps the version and the CHANGELOG entry from one fragment per PR, so parallel and stacked PRs stop conflicting on the five package.json version lines. Files: tools/stamp-version.py, tools/check-fragment.py, tools/stamp-current.txt, .github/workflows/changelog-fragment.yml, changelog.d/README.md.

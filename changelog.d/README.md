# changelog.d: CHANGELOG fragments

A PR branch never edits `CHANGELOG.md`, a `Cargo.toml` version or `Cargo.lock`: those are what parallel PRs collide on.
Write one fragment per change instead, `changelog.d/<topic>.md`:

    kind: **BREAKING**: `Foo::bar` removed
    ---
    The entry body in the CHANGELOG's own style (no heading): what changed, why, how it was verified.

- The first line `kind: ...` is the text after the version in the heading. When several fragments are stamped together,
  one whose kind contains "breaking" wins.
- A line `---`, then the body.
- The PM allocates the number and the gate runs `python tools/stamp-version.py <version>` (add `--dry-run` to preview):
  it sets every crate version that equals the project's current one, the matching `Cargo.lock` entries, writes one entry
  above the newest CHANGELOG entry from all fragments, and deletes them.
- A repo that also versions npm packages (Humboldt) gets them stamped too: every `package.json` at the project's version, and the
  `package-lock.json` beside it. A PR must not edit those versions either (`check-fragment` counts a `package.json` version edit as
  a manual bump). With the crate outside the root, `tools/stamp-current.txt` holds its manifest path (`backend/Cargo.toml`).
- Exactly one fragment per PR. Two PRs never touch the same line, so stacked and parallel PRs stop conflicting on version
  lines.
- Pins written as `=X.Y.Z` in other files (README install lines): list the file in `tools/stamp-extra.txt`, one path per line.
- Thinker's Journal Community has no Cargo: `tools/stamp-current.txt` names `package.json`, and the five version lines (`package.json`, `apps/api`, `apps/web`, `packages/markdown`, `packages/shared`) are stamped together. pnpm's lockfile does not record them.

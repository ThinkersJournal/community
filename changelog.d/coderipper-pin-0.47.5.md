kind: CodeRipper pin moved to 0.47.5; rule ids migrated
---
The portfolio workflow pin in `.github/workflows/ci.yml` moves to coderipper c72a6e0 (0.47.5), and the `licence` waivers in `.coderipper.toml` use the new rule id `SUP-016` (via `tools/migrate-rule-ids.py`, idempotent). Pin and rename ship together because the old binary rejects numbered ids.

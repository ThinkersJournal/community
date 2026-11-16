# HANDOFF — Thinker's Journal Community lane (rewritten 2026-11-16; current state only)

## Rules that bind this lane (CLAUDE.md files are the authority; these are the ones that bite)
- **Model: NEVER Opus.** Every subagent gets explicit `model: "sonnet"`. First [STATUS] after restart states `model=sonnet`. Re-read THROTTLE.md.
- Never `gh auth switch` / act as `ciresnave`. No own Serena / no `activate_project`. **No `git stash`** (I used it once on 2026-11-13 in the primary checkout; don't). **No force-push unless the PM explicitly authorises**; never rewrite a PR branch the PM is gating or has head-pinned (add commits; `git merge origin/main`). Sign every PR body/comment `— lane: community`. `gh pr ready` is its own Bash command.
- **Versions: fragment + stamp kit (merged #298).** One `changelog.d/<topic>.md` per PR (`kind: ...`, `---`, body with full repo-relative paths), NO version edits; the PM allocates the number and stamps (`tools/stamp-version.py`). Check with `python tools/check-fragment.py origin/main`. If the PM pushed a stamp commit onto my branch, pull before touching it.
- Facts at a fresh `origin/main` (`git fetch`). Enumerate with `git ls-files`/`git grep`. Every absence needs a positive control. Never discard stderr.
- Tests: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/thinkersjournal_test_appeals` only; never create/drop/alter a DB or start Postgres/Docker. Fresh worktrees have no node_modules: **CI is the first typecheck** (check name `test / build / typecheck`; read the log with `gh run view <run> --job <job> --log-failed`, strip ANSI). Typecheck runs BEFORE tests, so a red that failed typecheck is not a red-first: fix the typing and read the real test failure. Red-first: push the failing test, read it red, then the fix.
- Migrations: PR title says NEW MIGRATION NNNN; only the PM applies them; applied files (0039-0043) stay byte-identical. **The deploy runbook's "Migrations waiting" table needs a row per new migration** (pinned by `apps/api/test/deploy-runbook.node.test.ts`).
- Never close/fix/resolve next to `#N`. Vendor names only "hash-matching service A"/`HMS_A_*`/"PhotoDNA scan step". Legal entity `[[LEGAL_ENTITY]]`. Never touch the DMCA agent's registered address; never open CIRESNAVE-CONTACT.md / PHOTODNA-TERMS-NOTES.md.
- **Peers: Synapse only.** `mcp__synapse__send` takes `to: "pm"` and `body` (not `message`); ack each inbound by `message_id`; the claude-peers id `ortv090f` is dead. Compact [STATUS]/[READY]/[HOLD]/[ASK]/[FIX]/[FINDING] formats (a `[READY]` per message, `key=value` pairs with no spaces).
- Codacy `ACTION_REQUIRED`: read annotations, comment per finding. T-SQL rules, "not schema qualified" on Postgres migrations, weak-RNG in tests = false positives. Real: method >50 lines, swallowed ROLLBACK (log it), non-null assertions.
- Shell: CRLF files need python scripts (`newline=""`/bytes) for edits; run scratch scripts from the scratchpad, not the repo; Python on Windows can't open bash `/tmp` paths. Trailers: "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" + the "Claude-Session:" line from the session reminder; PR bodies end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)" + the session URL.

## State (2026-11-16): main 05885151 (M3.2 merged through 2c-3c, #307). API deployed 2026-11-14T04:12Z; refresh sweep OFF (`REFERENCE_REFRESH="0"`), queue `reference-refresh` 1 producer/1 consumer.
- **Open PRs of mine, all with the PM (read the forge, do not wait to be told):**
  - #308 CodeRipper pin 0.47.5, version 0.1.143. Worktree `C:\Projects\ThinkersJournal-Community-wt-pin`.
  - #309 M3.2d orphan-reference GC (`references/gc.ts`; 1-year retention floor `GC_RETENTION_MS`; daily on the `15 4 * * *` cron via `gcReferencesDaily`, dark behind `REFERENCE_REFRESH`), 0.1.144. Worktree `-wt-gc`, branch `feat/refs-gc-sweep`.
  - #311 NEW MIGRATION 0044 `moderation_snapshots.card_snapshots` + `handleDeletePost` copies a moderated post's reference cards into the snapshot (PM task C). Stacked on #309: after #309 merges retarget to main and `git merge origin/main`. Worktree `-wt-cards`. Codacy: 4 T-SQL false positives, commented.
  - After each merge: `git status --porcelain` clean, remove worktree + prune, delete branch via the API and read back 404 (positive control: a live ref).
- **Ruling applied (PM 2026-11-16):** retention is CireSnave's #58 Q1/Q2 (1-year floor, then only on legal sign-off); evidence for a moderated post lives in `moderation_snapshots`; a reference row is shared third-party metadata, an ordinary cache past a year. No takedown flag (PR #310 withdrawn). If the PM says a card can be evidence for a never-hidden post, that changes #309.
- **Next unblocked:** view-time enqueue (2d part 2: a viewed reference due for refresh gets enqueued). Flag flip "0" to "1" is a later one-line PR only when the PM says. M3.3 PR must add a missing-ID named-error test and regenerate `src/worker-configuration.d.ts`.
- **M3.3 / M3.6 credentials unblocked** (vault, read access lanes pm,community): `GITHUB_TJCOMMUNITY_APP_PRIVATE_KEY`, `GITLAB_TJCOMMUNITY_CLIENT_SECRET`; PM sets the Worker secrets at deploy. Open: confirm in M3.3's first build that an installation token reads public repos outside the installation.
- **Kept worktree `C:\Projects	jc-q7`** (detached, untracked `apps/api/.q7-spike/`): spike findings NOT recorded; write them into ROADMAP S21 or an issue, then remove, unless the PM says discard.
- **Unchecked:** review threads and Sourcery on #295-#311 (GraphQL `reviewThreads{isResolved}`). Flake: issue #300 (`comments.test.ts` PATCH throttle). Issues: #114, #72 blocked-on ciresnave. Weekly issue sweep last 2026-11-07, overdue.
- Open design call (PM with CireSnave): `forbidden` leaves `live_state` untouched, so a resource that turned private has no "no longer available" signal (ROADMAP R11).
- Docker: lane never runs it. Test DB is `thinkersjournal_test_appeals` on another server.

## First moves after a restart
Read THROTTLE.md; `git fetch`; [STATUS] to `pm` over Synapse with `model=sonnet`; `gh pr list`; `lane-restart waits` and arm a timer per line; clean up any merged PR's worktree; then the next unblocked row.

## Waits (armed at each start with `lane-restart waits`)
WAIT: PM merges #308, #309, #311 (in that order, 0.1.143/144/145) | check: gh pr list --state open; git fetch -q && git log origin/main --oneline -5 | wake: 2026-11-16T20:00:00Z
WAIT: rollback-check run on main by CireSnave, then tell the PM (Synapse) to set AUTO_ROLLBACK_ENABLED=1 | check: gh run list --workflow rollback-check --limit 5 (no runs as of 2026-11-16) | wake: 2026-11-17T06:00:00Z
WAIT: PM reports S3 checker UNKNOWN field shapes (CSAM scanner response) | check: mcp__synapse__fetch for PM messages (none as of 2026-11-16) | wake: 2026-11-17T06:00:00Z

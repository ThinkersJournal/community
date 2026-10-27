#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Run a command with a per-attempt time limit and a few attempts, for CI steps that fail only
# when a hosted runner's network is slow (an apt mirror, a CDN). One slow mirror must not fail
# a pull request (PM request 2026-10-27, after "Install Playwright OS deps" hit its 10-minute
# step limit on #267 and #270).
#
#   bash scripts/ci-retry.sh <attempts> <seconds-per-attempt> <command> [args...]
#
# Exits 0 on the first success, else with the last attempt's status (124 for a timeout).
# It retries ANY failure, so use it only for idempotent install steps, never for tests.
#
# CI_RETRY_CLEANUP (optional): a shell snippet run after each failed attempt, for a command
# whose timeout leaves children behind. `timeout` signals only the command it started, so a
# killed `pnpm exec playwright install-deps` can leave apt-get running and holding the dpkg
# lock; the workflow passes a `pkill` line here so the next attempt does not hit that lock.
set -uo pipefail

attempts="${1:?usage: ci-retry.sh <attempts> <seconds-per-attempt> <command> [args...]}"
limit="${2:?usage: ci-retry.sh <attempts> <seconds-per-attempt> <command> [args...]}"
shift 2

status=1
for ((i = 1; i <= attempts; i++)); do
  timeout "$limit" "$@"
  status=$?
  [ "$status" -eq 0 ] && exit 0
  echo "ci-retry: attempt $i of $attempts failed (status $status; 124 means it timed out after ${limit}s)" >&2
  if [ -n "${CI_RETRY_CLEANUP:-}" ]; then bash -c "$CI_RETRY_CLEANUP" || true; fi
done
exit "$status"

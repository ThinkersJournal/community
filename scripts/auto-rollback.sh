#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Roll the production Workers back to the deployment before the current one.
# Run ONLY by .github/workflows/prod-smoke.yml's `rollback` job, in the
# `production-rollback` GitHub Environment (docs/superpowers/specs/
# 2026-10-25-auto-rollback-design.md). It uses curl and jq only, no wrangler and no
# `pnpm install`, so a broken build cannot stop the rollback.
#
#   CLOUDFLARE_API_TOKEN   the Environment secret (Workers Scripts: Edit, one account)
#   CLOUDFLARE_ACCOUNT_ID  the Environment secret
#   DRY_RUN=1              print what would be done; change nothing
#   CF_API_BASE            test seam: the API origin (default: Cloudflare's)
#
# The api goes back first, then web (docs/runbooks/deploy.md). The DATABASE is never
# touched: a rolled-back code version leaves its additive migration in place, which
# is inert (design note section 3). A Worker whose rollback Cloudflare refuses (a
# Durable Object class lifecycle change between the two versions) or that has no
# earlier deployment is reported and left alone; the script then exits 1 so the
# run stays red and a person acts.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
DRY_RUN="${DRY_RUN:-0}"
WORKERS=(thinkersjournal-api thinkersjournal-web)
message="auto-rollback: production smoke check failed after a push to main (${GITHUB_SHA:-unknown})"

failed=0

for name in "${WORKERS[@]}"; do
  url="$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$name/deployments"
  if ! list=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$url"); then
    echo "FAIL $name: could not list deployments"
    failed=1
    continue
  fi

  count=$(jq '.result.deployments | length' <<<"$list")
  if [ "$count" -lt 2 ]; then
    echo "SKIP $name: only $count deployment(s); nothing earlier to go back to"
    failed=1
    continue
  fi

  # Newest first. Roll back only from, and to, a plain single-version 100% deployment:
  # a gradual rollout in flight is a human's to untangle.
  current_n=$(jq '.result.deployments[0].versions | length' <<<"$list")
  previous_n=$(jq '.result.deployments[1].versions | length' <<<"$list")
  if [ "$current_n" != "1" ] || [ "$previous_n" != "1" ]; then
    echo "SKIP $name: a split (gradual) deployment is involved; roll back by hand"
    failed=1
    continue
  fi
  current=$(jq -r '.result.deployments[0].versions[0].version_id' <<<"$list")
  previous=$(jq -r '.result.deployments[1].versions[0].version_id' <<<"$list")

  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY  $name: would roll back $current -> $previous"
    continue
  fi

  body=$(jq -n --arg v "$previous" --arg m "$message" \
    '{strategy: "percentage", versions: [{percentage: 100, version_id: $v}], annotations: {"workers/message": $m}}')
  reply=$(mktemp)
  code=$(curl -sS -o "$reply" -w '%{http_code}' -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" --data "$body" "$url" || true)
  if [ "$code" = "200" ]; then
    echo "OK   $name: rolled back $current -> $previous"
  else
    # Only the API's own error list is printed, never the request.
    echo "FAIL $name: Cloudflare answered ${code:-no response} to the rollback ($current -> $previous): $(jq -c '.errors // empty' "$reply" 2>/dev/null || true); roll back by hand"
    failed=1
  fi
  rm -f "$reply"
done

exit $failed

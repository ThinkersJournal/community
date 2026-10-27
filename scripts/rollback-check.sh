#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# READ-ONLY proof that the production-rollback token works (board 305; design note
# docs/superpowers/specs/2026-10-25-auto-rollback-design.md). Run by
# .github/workflows/rollback-check.yml from main, in the `production-rollback`
# Environment. It makes only GET requests: it verifies the token, lists the Worker
# scripts the token can see, and counts each production Worker's deployments. It
# deploys nothing, rolls nothing back, and never prints the token.
#
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   Environment secrets
#   CF_API_BASE                                    test seam (default: Cloudflare's)
#
# Exit 0 only when the token verifies AND both production Workers' deployments can be
# read (those are the two reads the rollback needs). Script NAMES are printed (they are
# public product names, not secrets); ids of deployments are not.
set -uo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
WORKERS=(thinkersjournal-api thinkersjournal-web)
failed=0

get() { # get <url-or-path>: sets BODY and CODE (NOT used in $(...): a subshell would lose CODE)
  local f
  f=$(mktemp)
  CODE=$(curl -sS -o "$f" -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$1" || true)
  BODY=$(cat "$f")
  rm -f "$f"
}

# 1. Verify the token. A user token verifies at /user/tokens/verify, an account-owned one at
# /accounts/<id>/tokens/verify; try the first, then the second, and say which answered.
verified=""
for path in "user/tokens/verify" "accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify"; do
  get "$API/$path"; out=$BODY
  if [ "$CODE" = "200" ] && [ "$(jq -r '.result.status // empty' <<<"$out" 2>/dev/null)" = "active" ]; then
    verified="$path"
    break
  fi
done
if [ -n "$verified" ]; then
  echo "OK   token is active (verified at /${verified%%/tokens*}/tokens/verify)"
else
  echo "FAIL token did not verify as active at either verify endpoint (last HTTP ${CODE:-none})"
  failed=1
fi

# 2. Which Worker scripts can it see?
get "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts"; out=$BODY
if [ "$CODE" = "200" ]; then
  names=$(jq -r '[.result[]?.id] | sort | join(", ")' <<<"$out" 2>/dev/null)
  count=$(jq '[.result[]?] | length' <<<"$out" 2>/dev/null)
  echo "OK   the token can list $count Worker script(s): ${names:-none}"
else
  echo "FAIL listing Worker scripts answered HTTP ${CODE:-none}: $(jq -c '.errors // empty' <<<"$out" 2>/dev/null)"
  failed=1
fi

# 3. The two reads the rollback itself makes.
for name in "${WORKERS[@]}"; do
  get "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$name/deployments"; out=$BODY
  if [ "$CODE" = "200" ]; then
    echo "OK   $name: $(jq '.result.deployments | length' <<<"$out") deployment(s) readable"
  else
    echo "FAIL $name: deployments answered HTTP ${CODE:-none}: $(jq -c '.errors // empty' <<<"$out" 2>/dev/null)"
    failed=1
  fi
done

if [ "$failed" = "0" ]; then echo "RESULT: the token works for what the rollback needs (read side only; no write was attempted)."; else echo "RESULT: NOT ready."; fi
exit $failed

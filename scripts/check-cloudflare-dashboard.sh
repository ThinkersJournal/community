#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# S3 (board 287): reports, for each Cloudflare dashboard item the README's deploy gate
# asks for, whether it is PRESENT, ABSENT or UNKNOWN. A read-only checker so nobody has
# to click through the dashboard to find out.
#
#   with-secret CLOUDFLARE_TJ_READONLY -- bash scripts/check-cloudflare-dashboard.sh
#
# Reads the token from CLOUDFLARE_API_TOKEN in the ENVIRONMENT ONLY (never an argument,
# never a file), makes GET requests ONLY, and never prints the token. What the token cannot
# see is reported UNKNOWN with the HTTP status, never guessed. Optional: CLOUDFLARE_ACCOUNT_ID
# (otherwise the single account the token can list), ZONE_NAME (default thinkersjournal.com),
# CF_API_BASE (test seam).
#
# Expressions and rule descriptions are printed (they are configuration, not secrets) so a
# person can compare them with intent: a PRESENT here means "a rule of that shape is enabled",
# not "the expression is right".
set -uo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set (run through with-secret)}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
ZONE_NAME="${ZONE_NAME:-thinkersjournal.com}"
CDN_HOST="cdn.${ZONE_NAME}"
present=0; absent=0; unknown=0

get() { # get <url-or-path>: sets BODY and CODE (NOT used in $(...): a subshell would lose CODE)
  local f
  f=$(mktemp)
  CODE=$(curl -sS -o "$f" -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API$1" || true)
  BODY=$(cat "$f")
  rm -f "$f"
}
report() { # report PRESENT|ABSENT|UNKNOWN "item" "detail"
  printf '%-8s %s: %s\n' "$1" "$2" "$3"
  case "$1" in PRESENT) present=$((present + 1));; ABSENT) absent=$((absent + 1));; *) unknown=$((unknown + 1));; esac
}
errs() { jq -c '.errors // empty' <<<"$1" 2>/dev/null; }

# ---- the zone and the account ------------------------------------------------------------------
get "/zones?name=$ZONE_NAME"; out=$BODY
ZONE_ID=""; ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ "$CODE" = "200" ]; then
  ZONE_ID=$(jq -r '.result[0].id // empty' <<<"$out" 2>/dev/null)
  [ -z "$ACCOUNT_ID" ] && ACCOUNT_ID=$(jq -r '.result[0].account.id // empty' <<<"$out" 2>/dev/null)
fi
if [ -z "$ACCOUNT_ID" ]; then
  get "/accounts"; out=$BODY
  [ "$CODE" = "200" ] && [ "$(jq '.result | length' <<<"$out" 2>/dev/null)" = "1" ] && ACCOUNT_ID=$(jq -r '.result[0].id' <<<"$out")
fi
zs="NOT FOUND ($ZONE_NAME)"; [ -n "$ZONE_ID" ] && zs="found"
as="NOT FOUND"; [ -n "$ACCOUNT_ID" ] && as="found"
echo "zone: $zs   account: $as"

# entrypoint <phase> -> prints the rules as compact JSON lines; sets ENTRY_STATUS=ok|none|unknown:<http>
entrypoint() {
  ENTRY_STATUS="unknown:no-zone"; ENTRY_RULES=""
  [ -z "$ZONE_ID" ] && return
  local body
  get "/zones/$ZONE_ID/rulesets/phases/$1/entrypoint"; body=$BODY
  case "$CODE" in
    200) ENTRY_STATUS=ok; ENTRY_RULES=$(jq -c '.result.rules[]? | select(.enabled != false)' <<<"$body" 2>/dev/null);;
    404) ENTRY_STATUS=none;;
    *) ENTRY_STATUS="unknown:${CODE:-none}";;
  esac
}
verdict() { # verdict <item> <jq-filter-selecting-rules> <what>
  local item="$1" filter="$2" what="$3" hit
  case "$ENTRY_STATUS" in
    unknown:*) report UNKNOWN "$item" "the token cannot read this ruleset (${ENTRY_STATUS#unknown:})"; return;;
    none) report ABSENT "$item" "no ruleset exists for this phase"; return;;
  esac
  hit=$(jq -c "select($filter)" <<<"$ENTRY_RULES" 2>/dev/null | head -3)
  if [ -n "$hit" ]; then
    report PRESENT "$item" "$what: $(jq -r '"[" + (.description // "no description") + "] " + (.expression // "")' <<<"$(head -1 <<<"$hit")")"
  else
    report ABSENT "$item" "the phase has $(jq -s 'length' <<<"$ENTRY_RULES") enabled rule(s), none of the expected shape"
  fi
}

# 1. WAF custom rule that blocks /internal/*
entrypoint http_request_firewall_custom
verdict "WAF block on /internal/*" '(.action == "block") and ((.expression // "") | test("/internal"))' "enabled block rule"

# 2. WAF rate limit on public reads (any enabled rate-limit rule; the expression is printed for a person to compare)
entrypoint http_ratelimit
verdict "WAF rate limit on public reads" '(.ratelimit != null) and ((.expression // "") | test("/public|GET|http.request"))' "enabled rate-limit rule"

# 3. Cache Rule for the CDN host (Cache Everything + a long edge TTL)
entrypoint http_request_cache_settings
verdict "CDN cache rule ($CDN_HOST)" '((.expression // "") | test("'"$CDN_HOST"'")) and (.action_parameters.cache == true)' "enabled cache rule"

# 4. Transform rule adding X-Content-Type-Options: nosniff
entrypoint http_response_headers_transform
verdict "nosniff transform rule" '(.action_parameters.headers["X-Content-Type-Options"].value // .action_parameters.headers["x-content-type-options"].value // "" | ascii_downcase) == "nosniff"' "enabled transform rule"

# 5. CSAM Scanning Tool on the CDN zone
if [ -n "$ZONE_ID" ]; then
  get "/zones/$ZONE_ID/settings/csam_scanner_third_party"; out=$BODY
  if [ "$CODE" = "200" ]; then
    # NOT `a // b`: jq's // treats false as missing, so a disabled tool would read as "no flag".
    en=$(jq -r '[.result.enabled, .result.value.enabled?] | map(select(. != null)) | if length == 0 then empty else (.[0] | tostring) end' <<<"$out" 2>/dev/null)
    case "$en" in
      true) report PRESENT "CSAM Scanning Tool" "enabled (email verification: $(jq -r '.result.email_verification // .result.value.email_verification // "not reported"' <<<"$out"))";;
      false) report ABSENT "CSAM Scanning Tool" "present but not enabled";;
      *) report UNKNOWN "CSAM Scanning Tool" "answered 200 but no enabled flag was readable";;
    esac
  else
    report UNKNOWN "CSAM Scanning Tool" "the token cannot read the setting (${CODE:-none}): $(errs "$out")"
  fi
else
  report UNKNOWN "CSAM Scanning Tool" "no zone"
fi

# 6. Postmark / purge log alerts (Cloudflare Notifications only; alerts kept elsewhere are invisible here)
if [ -n "$ACCOUNT_ID" ]; then
  get "/accounts/$ACCOUNT_ID/alerting/v3/policies"; out=$BODY
  if [ "$CODE" = "200" ]; then
    for kw in postmark purge; do
      n=$(jq --arg k "$kw" '[.result[]? | select(((.name // "") + " " + (.description // "")) | ascii_downcase | contains($k))] | length' <<<"$out" 2>/dev/null)
      if [ "${n:-0}" -gt 0 ]; then report PRESENT "$kw log alert" "$n notification policy(ies) mention it"; else report ABSENT "$kw log alert" "no Cloudflare notification policy mentions it (an alert kept outside Cloudflare would not show here)"; fi
    done
  else
    report UNKNOWN "Postmark/purge log alerts" "the token cannot read notification policies (${CODE:-none})"
  fi
else
  report UNKNOWN "Postmark/purge log alerts" "no account"
fi

# 7. workers.dev off on the web Worker (the api keeps it on)
for w in thinkersjournal-web thinkersjournal-api; do
  if [ -z "$ACCOUNT_ID" ]; then report UNKNOWN "workers.dev on $w" "no account"; continue; fi
  get "/accounts/$ACCOUNT_ID/workers/scripts/$w/subdomain"; out=$BODY
  if [ "$CODE" != "200" ]; then report UNKNOWN "workers.dev on $w" "the token cannot read it (${CODE:-none})"; continue; fi
  en=$(jq -r '.result.enabled | tostring' <<<"$out" 2>/dev/null)
  if [ "$w" = "thinkersjournal-web" ]; then
    if [ "$en" = "false" ]; then report PRESENT "workers.dev off on the web Worker" "off"; else report ABSENT "workers.dev off on the web Worker" "workers.dev is ${en:-unreadable}"; fi
  else
    echo "INFO     workers.dev on the api Worker is $en (expected on until a custom route exists; README deploy gate)"
  fi
done

printf '\nPRESENT: %s   ABSENT: %s   UNKNOWN: %s   (GET only; nothing was changed)\n' "$present" "$absent" "$unknown"
exit 0

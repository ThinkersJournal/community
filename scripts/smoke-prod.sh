#!/usr/bin/env bash
# Post-deploy smoke check against the REAL production URL — not a local build,
# not the Playwright e2e suite (which only ever tests a build artifact and
# stayed green all night while production 404s went undetected).
#
# Asserts a 200 AND a non-empty body containing a known marker string — never
# just a status code. docs/ops/uptime-monitor-spec.md's /health/db check is
# correct and useful for what it checks (DB reachability) but proved tonight
# that a check which only verifies the wrong thing is worse than no check: it
# was green the entire time the homepage 404ed. This complements it by
# checking that a real visitor actually gets a real page.
set -euo pipefail

BASE="${SMOKE_BASE_URL:-https://community.thinkersjournal.com}"
fail=0

check() {
  local path="$1" marker="$2" status
  status=$(curl -sS -o /tmp/smoke-body -w '%{http_code}' "$BASE$path") || {
    echo "FAIL $path: curl error"
    fail=1
    return
  }
  if [ "$status" != "200" ]; then
    echo "FAIL $path: status $status"
    fail=1
    return
  fi
  if [ ! -s /tmp/smoke-body ] || ! grep -qi "$marker" /tmp/smoke-body; then
    echo "FAIL $path: 200 but marker '$marker' not found (or body empty)"
    fail=1
    return
  fi
  echo "OK   $path"
}

# ⚠️ No apostrophes in any marker below. apps/web/src/lib/xml.ts's escapeXml
# turns a literal ' into the entity `&apos;` in both rss.xml and sitemap.xml's
# output, so a marker containing one (e.g. "Thinker's Journal") can never
# match the raw bytes — caught by running this against the real feed, not
# assumed. `<rss version=` and `urlset` are apostrophe-free by construction.
check "/" "Discover"
check "/login" "Log in"
check "/tags" "Tags"
check "/rss.xml" "rss version"
check "/authors" "authors"
check "/sitemap.xml" "urlset"

exit $fail

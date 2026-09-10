#!/usr/bin/env bash
# Refresh the cached upstream issue/PR metadata under .upstream-cache/.
#
# Upstream (janhq/jan) is read-only for this fork: this script only ever GETs.
# The cache is git-ignored; rebuild the committed ledger afterwards with
#   node scripts/upstream-intake/build-queue.mjs
set -euo pipefail

REPO="${UPSTREAM_REPO:-janhq/jan}"
# Closed items are only interesting back to a little before our divergence.
SINCE="${UPSTREAM_SINCE:-2026-07-01T00:00:00Z}"
CACHE="$(cd "$(dirname "$0")/../.." && pwd)/.upstream-cache"

mkdir -p "$CACHE"

echo "issues: open"
gh api -X GET "repos/$REPO/issues" --paginate \
  -f state=open -f per_page=100 -f sort=updated -f direction=desc \
  > "$CACHE/issues-open-raw.json"

echo "issues: closed since $SINCE"
gh api -X GET "repos/$REPO/issues" --paginate \
  -f state=closed -f per_page=100 -f sort=updated -f direction=desc -f since="$SINCE" \
  > "$CACHE/issues-closed-raw.json"

echo "pulls: open"
gh api -X GET "repos/$REPO/pulls" --paginate \
  -f state=open -f per_page=100 -f sort=updated -f direction=desc \
  > "$CACHE/pulls-open-raw.json"

# The pulls endpoint has no `since`, so page by hand and stop once a page ends
# older than the window.
for page in 1 2 3 4 5; do
  echo "pulls: closed page $page"
  gh api -X GET "repos/$REPO/pulls" \
    -f state=closed -f per_page=100 -f sort=updated -f direction=desc -f page="$page" \
    > "$CACHE/pulls-closed-p$page.json"
done

echo "cache written to $CACHE"

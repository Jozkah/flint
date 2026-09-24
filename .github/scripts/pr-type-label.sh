#!/bin/bash
# Print the "type: ..." label for a conventional-commit PR title, or nothing
# when the title has no recognised type. Accepts "feat: x", "feat(scope): x",
# "feat!: x" and "feat(scope)!: x" (Jozkah/jan#108: only the bare form used
# to match, so most PRs went unlabelled).
title="$1"
case "$title" in
  *:*) ;;
  *) exit 0 ;;
esac
type="${title%%:*}"
type="${type%%(*}"
type="${type%%!*}"
case "$type" in
  chore) echo "type: chore" ;;
  feat) echo "type: feature request" ;;
  perf) echo "type: enhancement" ;;
  fix) echo "type: bug" ;;
  docs) echo "type: documentation" ;;
  ci) echo "type: ci" ;;
  build) echo "type: ci" ;;
  test) echo "type: chore" ;;
  style) echo "type: chore" ;;
  refactor) echo "type: chore" ;;
esac

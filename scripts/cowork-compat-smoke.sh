#!/usr/bin/env bash
#
# Cowork compatibility smoke: the runtime evidence, in one command.
#
# What this is. Every check below exercises a real service — a real Seatbelt
# sandbox confining a real child process, a real MCP handshake with a real
# server on stdio, the real resolver the prompt and readiness read. Nothing
# here is a mock standing in for a runtime.
#
# What this is not. It does not drive the Tauri window, so it proves nothing
# about pixels, focus order, or whether a control is where someone expects it.
# Those need a GUI driver this repository does not have. The script says so at
# the end rather than letting a green run imply more than it checked.
#
# Usage:  scripts/cowork-compat-smoke.sh
# Exit:   0 when every check passed; non-zero otherwise.

set -uo pipefail

cd "$(dirname "$0")/.."
FAILED=0

step() {
  printf '\n\033[1m== %s\033[0m\n' "$1"
}

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mpass\033[0m  %s\n' "$name"
  else
    printf '  \033[31mFAIL\033[0m  %s\n' "$name"
    FAILED=1
  fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This harness asserts macOS Seatbelt behaviour; run it on macOS." >&2
  exit 2
fi

step "Sandbox confinement, under the real backend"
# Policy construction and real confined processes: review-only cannot write the
# repository, edit-folder writes only the authorized root, and neither sibling
# — including the prefix sibling — can be read or written.
check "mcp_confine (policy + runtime enforcement)" \
  cargo test --quiet \
  --manifest-path src-tauri/plugins/tauri-plugin-agent-tools/Cargo.toml mcp_confine

step "The launch capability"
# Nothing outside the module can build or open a launch, the process builder is
# called in exactly one place, and an import with no confinement is refused.
check "ConfinedMcpLaunch invariants" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib launch

step "MCP, end to end"
# A confined child, a real JSON-RPC handshake, tools/list and tools/call.
check "confined stdio server: handshake, list, call, shutdown" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_end_to_end

check "launcher confinement and environment rebuild" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_confinement

step "Compatibility resolution"
# The resolver, discovery, scoped instructions, skill roots and the surfaces
# that render them.
check "compatibility suites" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/claudeCompat.test.ts \
  src/lib/__tests__/claudeCompatDiscovery.test.ts \
  src/lib/__tests__/claudeCompatIntegration.test.ts \
  src/lib/__tests__/claudeCompatScoping.test.ts \
  src/lib/__tests__/claudeCompatMcp.test.ts \
  src/lib/__tests__/claudeSkillRoots.test.ts \
  src/lib/__tests__/coworkDispatch.test.ts \
  src/lib/__tests__/coworkOriginAgreement.test.ts \
  src/containers/__tests__/CoworkCompatSection.test.tsx \
  src/containers/__tests__/ClaudeSkillRootsSettings.test.tsx \
  src/hooks/__tests__/useClaudeCompat.test.ts

step "MCP over a real remote transport"
# A loopback server, Jan's real streamable-HTTP transport, and the failure
# shapes a client has to survive.
check "loopback HTTP: handshake, list, call, refusal, malformed init" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_http_integration

step "Restart, in two real processes"
# One process writes what Jan persists and exits; a second starts fresh and
# reads it. Clearing a store inside one process would test the clearing, not
# the restart.
restart_across_processes() {
  local fixture
  fixture="$(mktemp -t janrestart)".json
  JAN_RESTART_FIXTURE="$fixture" web-app/node_modules/.bin/vitest run --root web-app \
    src/hooks/__tests__/restart/processA.spec.ts >/dev/null 2>&1 || {
    rm -f "$fixture"
    return 1
  }
  JAN_RESTART_FIXTURE="$fixture" web-app/node_modules/.bin/vitest run --root web-app \
    src/hooks/__tests__/restart/processB.spec.ts >/dev/null 2>&1
  local status=$?
  rm -f "$fixture"
  return "$status"
}
check "consent and running servers do not survive a restart" restart_across_processes

printf '\n'
if [[ "$FAILED" -eq 0 ]]; then
  printf '\033[32mAll runtime checks passed.\033[0m\n'
else
  printf '\033[31mSome checks failed.\033[0m\n'
fi

cat <<'NOTE'

Covered by an executing runtime:
  - Seatbelt confining a real child process, on this host
  - review-only vs edit-folder write boundaries
  - sibling and prefix-sibling refusal, for reads and writes
  - a confined MCP server: handshake, tools/list, tools/call, shutdown
  - refusal to launch an import that carries no confinement
  - the environment a confined server is given
  - a real remote MCP handshake, tool call, and failure handling on loopback
  - a restart, across two separate processes

Not covered here:
  - the Tauri window: layout, focus order, where a control sits
  - clicking through consent in the running application
  - Linux bubblewrap and Windows AppContainer at runtime

NOTE

exit "$FAILED"
